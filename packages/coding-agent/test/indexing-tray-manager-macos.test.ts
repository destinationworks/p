import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAUNCHCTL_SERVICE_NOT_FOUND, type LaunchctlResult } from "../src/core/indexing-tray-launchd-job.ts";
import { IndexingTrayManager, TRAY_LAUNCHD_RECHECK_MS } from "../src/core/indexing-tray-manager.ts";

function installMacTray(agentDir: string): string {
  const binDir = path.join(agentDir, "indexing-service", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, "p-indexing-tray");
  fs.writeFileSync(binary, "", { mode: 0o755 });
  return binary;
}

/** Unscripted calls succeed, except `print`, which reports the job unknown (a completed bootout). */
function fakeLaunchctl(answer: (args: string[]) => Partial<LaunchctlResult> = () => ({})) {
  const calls: string[][] = [];
  const run = (args: string[]): LaunchctlResult => {
    calls.push(args);
    const fallback: Partial<LaunchctlResult> = args[0] === "print" ? { status: LAUNCHCTL_SERVICE_NOT_FOUND } : {};
    return { status: 0, stdout: "", stderr: "", ...fallback, ...answer(args) };
  };
  return { run, calls };
}

const neverSpawn = () => {
  throw new Error("the macOS tray must never be spawned as a child of the daemon");
};

describe("IndexingTrayManager on macOS", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-tray-mgr-macos-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function macManager(launchctl: ReturnType<typeof fakeLaunchctl>, clock = { now: 1_000_000 }) {
    return new IndexingTrayManager({
      agentDir: tempDir,
      platform: "darwin",
      uid: 501,
      runLaunchctl: launchctl.run,
      spawnProcess: neverSpawn,
      now: () => clock.now,
    });
  }

  it("runs the tray as its own Interactive launchd job instead of a child of the throttled daemon", () => {
    const binary = installMacTray(tempDir);
    const launchctl = fakeLaunchctl();
    const manager = macManager(launchctl);

    expect(manager.start()).toBe(true);
    expect(launchctl.calls.map((args) => args[0])).toEqual(["bootout", "print", "bootstrap"]);
    const [, domain, plistPath] = launchctl.calls[2];
    expect(domain).toBe("gui/501");
    const plist = fs.readFileSync(plistPath, "utf8");
    expect(plist).toContain("<string>Interactive</string>");
    expect(plist).toContain(`<string>${binary}</string>`);
    expect(plist).toContain(`<key>P_CODING_AGENT_DIR</key>\n        <string>${tempDir}</string>`);
  });

  it("skips launchctl for repeated starts within the recheck window and kickstarts at the next reconcile", () => {
    installMacTray(tempDir);
    const launchctl = fakeLaunchctl();
    const clock = { now: 1_000_000 };
    const manager = macManager(launchctl, clock);
    manager.start();
    const afterFirstStart = launchctl.calls.length;

    // Config-file events arrive in bursts; none of them may spawn launchctl again.
    clock.now += TRAY_LAUNCHD_RECHECK_MS - 1;
    expect(manager.start()).toBe(true);
    expect(launchctl.calls).toHaveLength(afterFirstStart);

    // A five-minute reconcile restarts a tray the user quit; kickstart leaves a running one alone.
    clock.now += 5 * 60_000;
    expect(manager.start()).toBe(true);
    expect(launchctl.calls.slice(afterFirstStart)).toEqual([["kickstart", expect.stringMatching(/^gui\/501\//)]]);
  });

  it("stops with SIGTERM through launchd and restarts immediately when the tray is re-enabled", () => {
    installMacTray(tempDir);
    const launchctl = fakeLaunchctl();
    const manager = macManager(launchctl);
    manager.start();

    manager.stop();
    expect(launchctl.calls.at(-1)?.slice(0, 2)).toEqual(["kill", "TERM"]);
    expect(manager.start()).toBe(true);
    expect(launchctl.calls.at(-1)?.[0]).toBe("kickstart");
  });

  it("asks launchd whether the tray process is alive", () => {
    let printReply: Partial<LaunchctlResult> = { status: 0, stdout: "\tstate = running\n\tpid = 777\n" };
    const launchctl = fakeLaunchctl((args) => (args[0] === "print" ? printReply : {}));
    const manager = macManager(launchctl);
    expect(manager.isRunning()).toBe(true);
    printReply = { status: 0, stdout: "\tstate = not running\n" };
    expect(manager.isRunning()).toBe(false);
  });

  it("reports no tray when the agent directory cannot hold the plist, and retries on the next call", () => {
    installMacTray(tempDir);
    fs.rmSync(path.join(tempDir, "indexing-service"), { recursive: true });
    fs.writeFileSync(path.join(tempDir, "indexing-service"), "not a directory");
    const launchctl = fakeLaunchctl();
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "darwin",
      uid: 501,
      runLaunchctl: launchctl.run,
      spawnProcess: neverSpawn,
      resolveCommand: () => ({ command: "/opt/p/bin/p-indexing-tray", args: [] }),
    });

    expect(manager.start()).toBe(false);
    expect(launchctl.calls.map((args) => args[0])).toEqual(["bootout", "print"]);
    expect(manager.start()).toBe(false);
    expect(launchctl.calls.map((args) => args[0])).toEqual(["bootout", "print", "bootout", "print"]);
  });

  it("returns false without touching launchd when no tray binary is installed", () => {
    const launchctl = fakeLaunchctl();
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "darwin",
      runLaunchctl: launchctl.run,
      spawnProcess: neverSpawn,
      resolveCommand: () => undefined,
    });
    expect(manager.start()).toBe(false);
    expect(launchctl.calls).toEqual([]);
  });

  it("skips starting and never touches launchd when the tray is disabled in config", () => {
    installMacTray(tempDir);
    fs.writeFileSync(path.join(tempDir, "code-rag.json"), JSON.stringify({ enableTray: false }));
    const launchctl = fakeLaunchctl();
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "darwin",
      runLaunchctl: launchctl.run,
      spawnProcess: neverSpawn,
    });

    expect(manager.start()).toBe(false);
    expect(launchctl.calls).toEqual([]);
  });
});
