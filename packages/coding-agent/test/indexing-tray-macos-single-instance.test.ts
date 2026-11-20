import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

// The launchd-managed tray must replace a leftover tray that an older daemon spawned as its child
// (that tray keeps the throttled scheduling), and must never disturb anything else. Runs the real
// single_instance_lock.swift against real processes and flock.

const SWIFTC = "/usr/bin/swiftc";
const testDir = path.dirname(fileURLToPath(import.meta.url));
const lockSource = path.resolve(testDir, "..", "src", "tray", "macos", "single_instance_lock.swift");
const driverSource = path.join(testDir, "fixtures", "tray-macos-lock", "main.swift");
const canCompile = process.platform === "darwin" && fs.existsSync(SWIFTC);

interface Holder {
  child: ChildProcess;
  exit: Promise<NodeJS.Signals | null>;
}

describe.skipIf(!canCompile)("macOS tray single-instance lock (compiled Swift)", () => {
  let buildDir: string;
  let trayBinary: string;
  let otherBinary: string;
  let agentDir: string;
  const holders: ChildProcess[] = [];

  beforeAll(() => {
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-tray-lock-"));
    // The takeover only signals executables named p-indexing-tray, so the driver carries that name.
    trayBinary = path.join(buildDir, "p-indexing-tray");
    otherBinary = path.join(buildDir, "other-app");
    const compile = spawnSync(SWIFTC, ["-Onone", lockSource, driverSource, "-o", trayBinary], {
      encoding: "utf8",
      timeout: 240_000,
    });
    expect(compile.status, compile.stderr).toBe(0);
    fs.copyFileSync(trayBinary, otherBinary);
    fs.chmodSync(otherBinary, 0o755);
  }, 300_000);

  afterAll(() => {
    fs.rmSync(buildDir, { recursive: true, force: true });
  });

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-tray-lock-agent-"));
  });

  afterEach(() => {
    for (const holder of holders.splice(0)) holder.kill("SIGKILL");
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  async function startHolder(binary: string, mode = "hold"): Promise<Holder> {
    const child = spawn(binary, [agentDir, mode], { stdio: ["ignore", "pipe", "inherit"] });
    holders.push(child);
    const exit = new Promise<NodeJS.Signals | null>((resolve) =>
      child.once("exit", (_code, signal) => resolve(signal)),
    );
    await new Promise<void>((resolve, reject) => {
      child.stdout?.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("locked")) resolve();
      });
      child.once("exit", () => reject(new Error("holder exited before taking the lock")));
    });
    return { child, exit };
  }

  const acquire = (mode: "acquire" | "acquire-managed"): string =>
    spawnSync(trayBinary, [agentDir, mode], { encoding: "utf8", timeout: 20_000 }).stdout.trim();

  const isAlive = (child: ChildProcess): boolean => child.exitCode === null && child.signalCode === null;

  it("an unmanaged tray exits and leaves the running tray alone", async () => {
    const holder = await startHolder(trayBinary);
    expect(acquire("acquire")).toBe("denied");
    expect(isAlive(holder.child)).toBe(true);
  });

  it("the launchd-managed tray terminates a leftover p-indexing-tray and takes the lock", async () => {
    const holder = await startHolder(trayBinary);
    expect(acquire("acquire-managed")).toBe("acquired");
    expect(await holder.exit).toBe("SIGTERM");
    expect(acquire("acquire")).toBe("acquired");
  });

  it("never signals a lock holder that is not p-indexing-tray", async () => {
    const holder = await startHolder(otherBinary);
    expect(acquire("acquire-managed")).toBe("denied");
    expect(isAlive(holder.child)).toBe(true);
  });

  it("gives up on a tray that ignores SIGTERM while it stops the service", async () => {
    const holder = await startHolder(trayBinary, "hold-ignoring-sigterm");
    expect(acquire("acquire-managed")).toBe("denied");
    expect(isAlive(holder.child)).toBe(true);
  }, 20_000);

  it("takes a free lock without a holder to replace", () => {
    expect(acquire("acquire-managed")).toBe("acquired");
    expect(fs.readFileSync(path.join(agentDir, "indexing-tray.pid"), "utf8")).toMatch(/^\d+\n$/);
  });
});
