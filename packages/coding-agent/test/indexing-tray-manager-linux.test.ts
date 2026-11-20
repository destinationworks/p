import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { IndexingTrayManager } from "../src/core/indexing-tray-manager.ts";

function installLinuxTray(agentDir: string): void {
  const serviceDir = path.join(agentDir, "indexing-service");
  fs.mkdirSync(serviceDir, { recursive: true });
  fs.writeFileSync(path.join(serviceDir, "indexing_tray.py"), "");
}

function mockChild(pid: number | undefined = process.pid) {
  const child = Object.assign(new EventEmitter(), {
    pid,
    killed: false,
    exitCode: null as number | null,
    unref: () => {},
    kill: (signal?: string) => {
      child.killed = true;
      child.exitCode = 0;
      child.emit("exit", 0, signal);
      return true;
    },
  });
  return child;
}

const neverSpawn = () => {
  throw new Error("spawnProcess must not be called here");
};

describe("IndexingTrayManager on Linux", () => {
  let tempDir: string;
  let savedDisplay: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-tray-mgr-linux-"));
    savedDisplay = process.env.DISPLAY;
    process.env.DISPLAY = ":0";
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
    if (savedDisplay === undefined) delete process.env.DISPLAY;
    else process.env.DISPLAY = savedDisplay;
  });

  it("spawns a detached child with the agent directory and stops it with SIGTERM", () => {
    installLinuxTray(tempDir);
    let spawnCount = 0;
    let passedArgs: string[] = [];
    let passedOpts: Record<string, unknown> | undefined;
    const child = mockChild();
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "linux",
      spawnProcess: (_cmd, args, opts) => {
        spawnCount++;
        passedArgs = args;
        passedOpts = opts;
        return child as never;
      },
    });

    expect(manager.start()).toBe(true);
    expect(spawnCount).toBe(1);
    expect(passedArgs).toEqual([path.join(tempDir, "indexing-service", "indexing_tray.py")]);
    expect(manager.isRunning()).toBe(true);
    expect(passedOpts?.detached).toBe(true);
    expect((passedOpts?.env as Record<string, string>)?.P_CODING_AGENT_DIR).toBe(tempDir);

    // Second start is idempotent
    expect(manager.start()).toBe(true);
    expect(spawnCount).toBe(1);

    manager.stop();
    expect(child.killed).toBe(true);
    expect(manager.isRunning()).toBe(false);

    // Stop when not running is a no-op
    manager.stop();
    expect(manager.isRunning()).toBe(false);
  });

  it("handles synchronous spawn failure gracefully", () => {
    installLinuxTray(tempDir);
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "linux",
      spawnProcess: () => {
        throw new Error("ENOENT: spawn failure");
      },
    });

    expect(manager.start()).toBe(false);
    expect(manager.isRunning()).toBe(false);
  });

  it("forgets the child after it exits unexpectedly", () => {
    installLinuxTray(tempDir);
    const child = mockChild();
    child.kill = () => true;
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "linux",
      spawnProcess: () => child as never,
    });

    expect(manager.start()).toBe(true);
    expect(manager.isRunning()).toBe(true);

    child.exitCode = 1;
    child.emit("exit", 1, null);
    expect(manager.isRunning()).toBe(false);
  });

  it("does not start without a display server", () => {
    installLinuxTray(tempDir);
    delete process.env.DISPLAY;
    const savedWayland = process.env.WAYLAND_DISPLAY;
    delete process.env.WAYLAND_DISPLAY;
    try {
      const manager = new IndexingTrayManager({ agentDir: tempDir, platform: "linux", spawnProcess: neverSpawn });
      expect(manager.start()).toBe(false);
    } finally {
      if (savedWayland !== undefined) process.env.WAYLAND_DISPLAY = savedWayland;
    }
  });

  it("returns false without spawning when no python script is found", () => {
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "linux",
      spawnProcess: neverSpawn,
      resolveCommand: () => undefined,
    });
    expect(manager.start()).toBe(false);
  });

  it("isRunning returns true on EPERM (process exists but no permission to signal)", () => {
    installLinuxTray(tempDir);
    const child = mockChild(1);
    child.kill = () => true;
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "linux",
      spawnProcess: () => child as never,
    });
    manager.start();
    expect(manager.isRunning()).toBe(true);
  });

  it("isRunning returns false and clears process on ESRCH (process no longer exists)", () => {
    installLinuxTray(tempDir);
    const child = mockChild(2147483647);
    child.kill = () => true;
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "linux",
      spawnProcess: () => child as never,
    });
    manager.start();
    expect(manager.isRunning()).toBe(false);
  });

  it("isRunning falls back to process reference check when pid is absent", () => {
    installLinuxTray(tempDir);
    const child = mockChild(undefined);
    child.kill = () => true;
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "linux",
      spawnProcess: () => child as never,
    });
    manager.start();
    expect(manager.isRunning()).toBe(true);
  });
});
