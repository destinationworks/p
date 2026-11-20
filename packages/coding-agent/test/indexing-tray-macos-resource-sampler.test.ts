import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

// Runs the tray's real sampler (libproc, sysctl and IORegistry reads) against a live process tree
// shaped like the indexing daemon's: a node parent with a CPU-busy child.

const SWIFTC = "/usr/bin/swiftc";
const testDir = path.dirname(fileURLToPath(import.meta.url));
const swiftDir = path.resolve(testDir, "..", "src", "tray", "macos");
const driverSource = path.join(testDir, "fixtures", "tray-macos-resources", "main.swift");
const canCompile = process.platform === "darwin" && fs.existsSync(SWIFTC);
const MB = 1_048_576;

type SampledProcess = {
  pid: number;
  label: string;
  isRoot: boolean;
  footprintBytes: number;
  cpuPercent: number | null;
  gpuPercent: number | null;
  cpuTimeNs: number;
};
type SampledUsage = { gpuAvailable: boolean; totalCpuPercent: number | null; processes: SampledProcess[] };

describe.skipIf(!canCompile)("macOS tray resource sampler (live process tree)", () => {
  let buildDir = "";
  let binary = "";
  let tree: ChildProcess | undefined;

  beforeAll(() => {
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-tray-resources-"));
    binary = path.join(buildDir, "tray-resources");
    const sources = ["resource_usage.swift", "resource_sampler.swift", "gpu_usage_probe.swift"].map((name) =>
      path.join(swiftDir, name),
    );
    const compile = spawnSync(SWIFTC, ["-Onone", ...sources, driverSource, "-o", binary], {
      encoding: "utf8",
      timeout: 240_000,
    });
    expect(compile.status, compile.stderr).toBe(0);
    // The busy child stops on its own as well, should the group kill below ever be skipped.
    fs.writeFileSync(path.join(buildDir, "burn.js"), "const end = Date.now() + 20000;\nwhile (Date.now() < end) {}\n");
    fs.writeFileSync(
      path.join(buildDir, "parent.js"),
      [
        'const { spawn } = require("node:child_process");',
        `const child = spawn(process.execPath, [${JSON.stringify(path.join(buildDir, "burn.js"))}], { stdio: "ignore" });`,
        'process.stdout.write(String(child.pid) + "\\n");',
        "setInterval(() => {}, 1000);",
      ].join("\n"),
    );
  }, 300_000);

  afterEach(() => {
    if (tree?.pid) {
      try {
        process.kill(-tree.pid, "SIGKILL");
      } catch {
        // The group already exited.
      }
    }
    tree = undefined;
  });

  afterAll(() => {
    fs.rmSync(buildDir, { recursive: true, force: true });
  });

  /** Starts parent.js in its own process group and resolves with the busy child's pid. */
  async function startTree(): Promise<{ parentPid: number; childPid: number }> {
    const parent = spawn(process.execPath, [path.join(buildDir, "parent.js")], {
      detached: true,
      stdio: ["ignore", "pipe", "inherit"],
    });
    tree = parent;
    const childPid = await new Promise<number>((resolve, reject) => {
      let output = "";
      parent.once("error", reject);
      parent.stdout?.on("data", (chunk: Buffer) => {
        output += chunk.toString();
        if (output.includes("\n")) resolve(Number.parseInt(output, 10));
      });
    });
    return { parentPid: parent.pid ?? -1, childPid };
  }

  /** Cumulative CPU seconds of a process as `ps` reports it ("M:SS.cc", centisecond resolution). */
  const psCpuSeconds = (pid: number): number => {
    const ps = spawnSync("/bin/ps", ["-o", "time=", "-p", String(pid)], { encoding: "utf8" });
    return ps.stdout
      .trim()
      .split(":")
      .reduce((total, part) => total * 60 + Number.parseFloat(part), 0);
  };

  /** Waits until the busy child has accrued real CPU time, however slowly a loaded host schedules it. */
  async function waitForCpu(pid: number, seconds: number): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (psCpuSeconds(pid) < seconds) {
      expect(Date.now(), `pid ${pid} did not reach ${seconds}s of CPU`).toBeLessThan(deadline);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }

  const sample = (rootPid: number, startedAt: string, intervalMs: number): SampledUsage | null => {
    const run = spawnSync(binary, [String(rootPid), startedAt, String(intervalMs)], {
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as SampledUsage | null;
  };

  it("walks the daemon's children and measures their CPU and memory", async () => {
    const { parentPid, childPid } = await startTree();
    // Like the daemon, the status file's startedAt is recorded after the process started.
    const startedAt = new Date().toISOString();
    await waitForCpu(childPid, 0.3);
    const cpuBefore = psCpuSeconds(childPid);
    const usage = sample(parentPid, startedAt, 1500);
    const cpuAfter = psCpuSeconds(childPid);

    expect(usage?.processes[0]).toMatchObject({ pid: parentPid, isRoot: true, label: "node · parent.js" });
    const child = usage?.processes.find((process) => process.pid === childPid);
    expect(child).toMatchObject({ isRoot: false, label: "node · burn.js" });
    // The sampler read the child's cumulative CPU between the two ps readings. This pins the unit
    // regardless of host load: unconverted Mach ticks read 41.67x too low on Apple silicon.
    const sampledSeconds = (child?.cpuTimeNs ?? 0) / 1e9;
    expect(sampledSeconds).toBeGreaterThanOrEqual(cpuBefore - 0.02);
    expect(sampledSeconds).toBeLessThanOrEqual(cpuAfter + 0.02);
    // The rate depends on how much of a core a loaded host grants the loop, so only its range is fixed.
    expect(child?.cpuPercent).toBeGreaterThan(0);
    expect(child?.cpuPercent).toBeLessThan(250);
    expect(child?.footprintBytes).toBeGreaterThan(MB);
    expect(usage?.totalCpuPercent).toBeGreaterThanOrEqual(child?.cpuPercent ?? Number.POSITIVE_INFINITY);
    // A CPU loop opens no GPU client: 0% where the driver reports per-process GPU time, else none.
    expect(child?.gpuPercent).toBe(usage?.gpuAvailable ? 0 : null);
  }, 60_000);

  it("rejects a root pid whose process started after the status file's startedAt", async () => {
    const { parentPid } = await startTree();
    expect(sample(parentPid, new Date(Date.now() - 60_000).toISOString(), 10)).toBeNull();
  }, 60_000);

  it("returns nothing for a daemon pid that has exited", () => {
    const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], {
      encoding: "utf8",
    });
    expect(sample(Number.parseInt(exited.stdout, 10), new Date().toISOString(), 10)).toBeNull();
  }, 60_000);
});
