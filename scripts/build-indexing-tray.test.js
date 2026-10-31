import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { copyLinuxIndexingTray, LINUX_TRAY_FILES } from "./build-indexing-tray.js";

const codeIndexDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "packages", "code-index");

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p-tray-install-"));
  try {
    return callback(directory);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

test("Linux tray install list covers every indexing_tray*.py module the script imports", () => {
  const onDisk = fs.readdirSync(codeIndexDir).filter((name) => /^indexing_tray.*\.py$/.test(name)).sort();
  assert.deepEqual([...LINUX_TRAY_FILES].sort(), onDisk);
});

test("Linux tray install copies the script and its helper modules together, executable", () => {
  withTempDir((serviceRoot) => {
    const copied = copyLinuxIndexingTray(codeIndexDir, serviceRoot);
    assert.deepEqual(copied, LINUX_TRAY_FILES);
    for (const name of LINUX_TRAY_FILES) {
      const destination = path.join(serviceRoot, name);
      assert.equal(fs.readFileSync(destination, "utf8"), fs.readFileSync(path.join(codeIndexDir, name), "utf8"));
      assert.equal(fs.statSync(destination).mode & 0o111, 0o111, `${name} should be executable`);
    }
  });
});

test("Linux tray install skips modules that are not present in the source directory", () => {
  withTempDir((source) => {
    withTempDir((serviceRoot) => {
      fs.writeFileSync(path.join(source, "indexing_tray.py"), "# only the entry point\n");
      assert.deepEqual(copyLinuxIndexingTray(source, serviceRoot), ["indexing_tray.py"]);
      assert.deepEqual(fs.readdirSync(serviceRoot), ["indexing_tray.py"]);
    });
  });
});
