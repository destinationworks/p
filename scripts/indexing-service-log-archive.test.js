import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import zlib from "node:zlib";
import { archiveOversizedServiceLogs } from "./indexing-service-log-archive.js";

const NOW = new Date("2026-10-31T01:02:03.000Z");

function temporaryLogDirectory() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "p-service-log-archive-"));
}

test("archives an oversized log with Brotli, preserves its bytes, and empties it in place", async () => {
  const directory = temporaryLogDirectory();
  try {
    const logPath = path.join(directory, "service.log");
    const content = "[code-index:debug] Embedding server already running on port 18742\n".repeat(200);
    fs.writeFileSync(logPath, content);
    const inodeBefore = fs.statSync(logPath).ino;

    const archives = await archiveOversizedServiceLogs(directory, { thresholdBytes: 1_000, now: NOW });

    assert.equal(archives.length, 1);
    assert.equal(path.basename(archives[0].archivePath), "service-until-2026-10-31.log.br");
    assert.equal(archives[0].bytes, Buffer.byteLength(content));
    assert.equal(zlib.brotliDecompressSync(fs.readFileSync(archives[0].archivePath)).toString(), content);
    assert.equal(fs.statSync(logPath).size, 0);
    assert.equal(fs.statSync(logPath).ino, inodeBefore, "the open log file must keep its identity");
    assert.deepEqual(
      fs.readdirSync(directory).filter((name) => name.endsWith(".tmp")),
      [],
    );
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("leaves logs at or below the threshold and missing logs alone", async () => {
  const directory = temporaryLogDirectory();
  try {
    fs.writeFileSync(path.join(directory, "service.log"), "x".repeat(1_000));
    const archives = await archiveOversizedServiceLogs(directory, { thresholdBytes: 1_000, now: NOW });
    assert.deepEqual(archives, []);
    assert.equal(fs.statSync(path.join(directory, "service.log")).size, 1_000);
    assert.equal(fs.existsSync(path.join(directory, "service-error.log")), false);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("archives both logs and never overwrites an earlier archive from the same day", async () => {
  const directory = temporaryLogDirectory();
  try {
    fs.writeFileSync(path.join(directory, "service-until-2026-10-31.log.br"), "earlier archive");
    fs.writeFileSync(path.join(directory, "service.log"), "a".repeat(2_000));
    fs.writeFileSync(path.join(directory, "service-error.log"), "b".repeat(2_000));

    const archives = await archiveOversizedServiceLogs(directory, { thresholdBytes: 1_000, now: NOW });

    assert.deepEqual(archives.map((archive) => path.basename(archive.archivePath)).sort(), [
      "service-error-until-2026-10-31.log.br",
      "service-until-2026-10-31-2.log.br",
    ]);
    assert.equal(fs.readFileSync(path.join(directory, "service-until-2026-10-31.log.br"), "utf8"), "earlier archive");
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("keeps the original log intact when the archive cannot be written", async () => {
  const directory = temporaryLogDirectory();
  try {
    const logPath = path.join(directory, "service.log");
    fs.writeFileSync(logPath, "c".repeat(2_000));
    fs.chmodSync(directory, 0o500);
    if (process.getuid?.() === 0) return;

    await assert.rejects(archiveOversizedServiceLogs(directory, { thresholdBytes: 1_000, now: NOW }));

    assert.equal(fs.readFileSync(logPath, "utf8"), "c".repeat(2_000));
  } finally {
    fs.chmodSync(directory, 0o700);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
