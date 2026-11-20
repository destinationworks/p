import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LAUNCHCTL_SERVICE_NOT_FOUND, type LaunchctlResult } from "../src/core/indexing-tray-launchd-job.ts";
import { IndexingTrayManager, TRAY_LAUNCHD_RECHECK_MS } from "../src/core/indexing-tray-manager.ts";

/**
 * Installs a tray build the way the linker does: a new file renamed over the old path. A tray
 * started from the old file keeps running its old code, which is why a rebuild needs a restart.
 */
function installMacTray(agentDir: string, build = "tray build 1"): string {
  const binDir = path.join(agentDir, "indexing-service", "bin");
  fs.mkdirSync(binDir, { recursive: true });
  const binary = path.join(binDir, "p-indexing-tray");
  fs.writeFileSync(`${binary}.tmp`, build, { mode: 0o755 });
  fs.renameSync(`${binary}.tmp`, binary);
  return binary;
}

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");
const subcommands = (calls: string[][]) => calls.map((args) => args[0]);

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
    const binary = path.join(tempDir, "p-indexing-tray");
    fs.writeFileSync(binary, "tray build 1", { mode: 0o755 });
    fs.writeFileSync(path.join(tempDir, "indexing-service"), "not a directory");
    const launchctl = fakeLaunchctl();
    const manager = new IndexingTrayManager({
      agentDir: tempDir,
      platform: "darwin",
      uid: 501,
      runLaunchctl: launchctl.run,
      spawnProcess: neverSpawn,
      resolveCommand: () => ({ command: binary, args: [] }),
    });

    expect(manager.start()).toBe(false);
    expect(launchctl.calls.map((args) => args[0])).toEqual(["bootout", "print"]);
    expect(manager.start()).toBe(false);
    expect(launchctl.calls.map((args) => args[0])).toEqual(["bootout", "print", "bootout", "print"]);
  });

  describe("when reinstall replaces the tray binary at the same path", () => {
    // The plist names the same path before and after a reinstall, so without the binary's digest
    // in the definition the restarted daemon only kickstarted, and the old tray stayed on screen.
    it("restarts the running tray exactly once at the next daemon start, and never when nothing changed", () => {
      installMacTray(tempDir, "tray build 1");
      expect(macManager(fakeLaunchctl()).start()).toBe(true);

      const restartedDaemon = fakeLaunchctl();
      expect(macManager(restartedDaemon).start()).toBe(true);
      expect(subcommands(restartedDaemon.calls)).toEqual(["kickstart"]);

      installMacTray(tempDir, "tray build 2");
      const afterReinstall = fakeLaunchctl();
      expect(macManager(afterReinstall).start()).toBe(true);
      expect(subcommands(afterReinstall.calls)).toEqual(["bootout", "print", "bootstrap"]);
      const plistPath = afterReinstall.calls[2][2];
      expect(fs.readFileSync(plistPath, "utf8")).toContain(`<string>${sha256("tray build 2")}</string>`);

      const nextDaemonStart = fakeLaunchctl();
      expect(macManager(nextDaemonStart).start()).toBe(true);
      expect(subcommands(nextDaemonStart.calls)).toEqual(["kickstart"]);
    });

    it("picks up a binary replaced under a running daemon at the next reconcile, once", () => {
      installMacTray(tempDir, "tray build 1");
      const launchctl = fakeLaunchctl();
      const clock = { now: 1_000_000 };
      const manager = macManager(launchctl, clock);
      manager.start();

      installMacTray(tempDir, "tray build 2");
      clock.now += TRAY_LAUNCHD_RECHECK_MS;
      let seen = launchctl.calls.length;
      expect(manager.start()).toBe(true);
      expect(subcommands(launchctl.calls.slice(seen))).toEqual(["bootout", "print", "bootstrap"]);

      clock.now += TRAY_LAUNCHD_RECHECK_MS;
      seen = launchctl.calls.length;
      expect(manager.start()).toBe(true);
      expect(subcommands(launchctl.calls.slice(seen))).toEqual(["kickstart"]);
    });

    it("leaves the tray running when a rebuild produces a new file with identical bytes", () => {
      installMacTray(tempDir, "tray build 1");
      macManager(fakeLaunchctl()).start();

      installMacTray(tempDir, "tray build 1");
      const launchctl = fakeLaunchctl();
      expect(macManager(launchctl).start()).toBe(true);
      expect(subcommands(launchctl.calls)).toEqual(["kickstart"]);
    });

    it("restarts a tray started from a definition written before the digest existed exactly once", () => {
      installMacTray(tempDir, "tray build 1");
      const first = fakeLaunchctl();
      macManager(first).start();
      const plistPath = first.calls[2][2];
      const withoutDigest = fs
        .readFileSync(plistPath, "utf8")
        .replace(/\n\s*<key>P_INDEXING_TRAY_BINARY_SHA256<\/key>\n\s*<string>[0-9a-f]{64}<\/string>/, "");
      expect(withoutDigest).not.toContain("P_INDEXING_TRAY_BINARY_SHA256");
      fs.writeFileSync(plistPath, withoutDigest);

      const upgraded = fakeLaunchctl();
      expect(macManager(upgraded).start()).toBe(true);
      expect(subcommands(upgraded.calls)).toEqual(["bootout", "print", "bootstrap"]);
      const next = fakeLaunchctl();
      expect(macManager(next).start()).toBe(true);
      expect(subcommands(next.calls)).toEqual(["kickstart"]);
    });

    it("leaves a running tray alone while its binary is briefly unreadable, then only kickstarts", () => {
      const binary = installMacTray(tempDir, "tray build 1");
      const launchctl = fakeLaunchctl();
      const clock = { now: 1_000_000 };
      // Pinned: the default resolver would fall back to a built dist/bin tray once this one is gone.
      const manager = new IndexingTrayManager({
        agentDir: tempDir,
        platform: "darwin",
        uid: 501,
        runLaunchctl: launchctl.run,
        spawnProcess: neverSpawn,
        now: () => clock.now,
        resolveCommand: () => ({ command: binary, args: [] }),
      });
      manager.start();
      const afterFirstStart = launchctl.calls.length;

      fs.rmSync(binary);
      clock.now += TRAY_LAUNCHD_RECHECK_MS;
      expect(manager.start()).toBe(false);
      expect(launchctl.calls).toHaveLength(afterFirstStart);

      installMacTray(tempDir, "tray build 1");
      expect(manager.start()).toBe(true);
      expect(subcommands(launchctl.calls.slice(afterFirstStart))).toEqual(["kickstart"]);
    });

    it("reports no tray without touching launchd while the binary cannot be read, and retries", () => {
      const binary = path.join(tempDir, "p-indexing-tray");
      const launchctl = fakeLaunchctl();
      const manager = new IndexingTrayManager({
        agentDir: tempDir,
        platform: "darwin",
        uid: 501,
        runLaunchctl: launchctl.run,
        spawnProcess: neverSpawn,
        resolveCommand: () => ({ command: binary, args: [] }),
      });

      expect(manager.start()).toBe(false);
      expect(launchctl.calls).toEqual([]);

      fs.writeFileSync(binary, "tray build 1", { mode: 0o755 });
      expect(manager.start()).toBe(true);
      expect(subcommands(launchctl.calls)).toEqual(["bootout", "print", "bootstrap"]);
    });
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
