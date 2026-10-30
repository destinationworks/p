import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { EmbeddingServerManager } from "../src/embed/server.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Unable to allocate a test port");
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** A fake embedding server that records each spawn and answers /health slowly while `busy` exists. */
function writeFakeEmbeddingServer(directory: string): { executable: string; spawnLog: string; busyFlag: string } {
  const executable = join(directory, "fake-python.js");
  const spawnLog = join(directory, "spawns.log");
  const busyFlag = join(directory, "busy");
  writeFileSync(
    executable,
    [
      "#!/usr/bin/env node",
      'import fs from "node:fs";',
      'import http from "node:http";',
      "const args = process.argv.slice(2);",
      'const port = Number(args[args.indexOf("--port") + 1]);',
      `fs.appendFileSync(${JSON.stringify(spawnLog)}, process.pid + "\\n");`,
      "const server = http.createServer((request, response) => {",
      `  const delay = fs.existsSync(${JSON.stringify(busyFlag)}) ? 3_000 : 0;`,
      "  setTimeout(() => {",
      '    response.setHeader("content-type", "application/json");',
      '    response.end(JSON.stringify({ status: "ready" }));',
      "  }, delay);",
      "});",
      'server.on("error", () => process.exit(98));',
      'server.listen(port, "127.0.0.1");',
      'process.on("SIGTERM", () => process.exit(0));',
    ].join("\n"),
  );
  chmodSync(executable, 0o700);
  return { executable, spawnLog, busyFlag };
}

function spawnedPids(spawnLog: string): number[] {
  return existsSync(spawnLog) ? readFileSync(spawnLog, "utf8").trim().split("\n").filter(Boolean).map(Number) : [];
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitForExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isAlive(pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return !isAlive(pid);
}

describe("EmbeddingServerManager with a busy port", () => {
  it("waits for its own slow child instead of spawning a duplicate it can no longer stop", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p-embed-busy-own-"));
    temporaryDirectories.push(directory);
    const fake = writeFakeEmbeddingServer(directory);
    const manager = new EmbeddingServerManager(await availablePort(), "model", {
      pythonExecutable: fake.executable,
      startupTimeoutMs: 8_000,
    });
    try {
      expect(await manager.ensureStarted()).toBe(true);
      writeFileSync(fake.busyFlag, "");
      expect(await manager.ensureStarted()).toBe(false);
      expect(spawnedPids(fake.spawnLog)).toHaveLength(1);
    } finally {
      if (existsSync(fake.busyFlag)) unlinkSync(fake.busyFlag);
      await manager.stop();
    }
    const [pid] = spawnedPids(fake.spawnLog);
    expect(await waitForExit(pid!, 2_000)).toBe(true);
  }, 20_000);

  it("does not spawn while another process holds the port with slow health responses", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p-embed-busy-foreign-"));
    temporaryDirectories.push(directory);
    const fake = writeFakeEmbeddingServer(directory);
    const port = await availablePort();
    const foreign: Server = createServer((_request, response) => {
      setTimeout(() => {
        response.setHeader("content-type", "application/json");
        response.end(JSON.stringify({ status: "ready" }));
      }, 2_500);
    });
    await new Promise<void>((resolve) => foreign.listen(port, "127.0.0.1", resolve));
    const logs: string[] = [];
    const manager = new EmbeddingServerManager(port, "model", {
      pythonExecutable: fake.executable,
      startupTimeoutMs: 8_000,
      onLog: (_level, message) => logs.push(message),
    });
    try {
      expect(await manager.ensureStarted()).toBe(false);
      expect(spawnedPids(fake.spawnLog)).toEqual([]);
      expect(logs.join("\n")).toContain("waiting for readiness");
    } finally {
      await manager.stop();
      foreign.closeAllConnections();
      await new Promise<void>((resolve) => foreign.close(() => resolve()));
    }
  }, 20_000);

  it("stops waiting on an occupied port as soon as startup is cancelled", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p-embed-busy-abort-"));
    temporaryDirectories.push(directory);
    const fake = writeFakeEmbeddingServer(directory);
    const port = await availablePort();
    const stuck: Server = createServer(() => {});
    await new Promise<void>((resolve) => stuck.listen(port, "127.0.0.1", resolve));
    const manager = new EmbeddingServerManager(port, "model", {
      pythonExecutable: fake.executable,
      startupTimeoutMs: 15_000,
    });
    const controller = new AbortController();
    const startedAt = Date.now();
    try {
      const startup = manager.ensureStarted(controller.signal);
      setTimeout(() => controller.abort(new Error("daemon quiescing")), 2_500);
      await expect(startup).rejects.toThrow("daemon quiescing");
      expect(Date.now() - startedAt).toBeLessThan(5_000);
      expect(spawnedPids(fake.spawnLog)).toEqual([]);
    } finally {
      await manager.stop();
      stuck.closeAllConnections();
      await new Promise<void>((resolve) => stuck.close(() => resolve()));
    }
  }, 20_000);

  it("fails without spawning when the port stays occupied but never becomes ready", async () => {
    const directory = mkdtempSync(join(tmpdir(), "p-embed-busy-stuck-"));
    temporaryDirectories.push(directory);
    const fake = writeFakeEmbeddingServer(directory);
    const port = await availablePort();
    const stuck: Server = createServer(() => {});
    await new Promise<void>((resolve) => stuck.listen(port, "127.0.0.1", resolve));
    const manager = new EmbeddingServerManager(port, "model", {
      pythonExecutable: fake.executable,
      startupTimeoutMs: 1_500,
    });
    try {
      await expect(manager.ensureStarted()).rejects.toThrow(`port ${port} is occupied`);
      expect(spawnedPids(fake.spawnLog)).toEqual([]);
    } finally {
      await manager.stop();
      stuck.closeAllConnections();
      await new Promise<void>((resolve) => stuck.close(() => resolve()));
    }
  }, 20_000);
});
