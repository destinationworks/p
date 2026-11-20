import { describe, expect, it } from "vitest";
import { canCompileTrayLogic, type Json, useTrayLogicHarness } from "./tray-macos-logic-test-harness.ts";

// The tray turns two samples of the daemon's process tree into CPU/GPU rates and memory totals.
// These cases run the real Swift math (resource_usage.swift) through the compiled JSON driver.

const SECOND = 1_000_000_000;
const MB = 1_048_576;

function processSample(pid: number, fields: Json = {}): Json {
  return {
    pid,
    startTimeUs: pid * 1000,
    name: "node",
    arguments: [],
    cpuTimeNs: 0,
    footprintBytes: 10 * MB,
    gpuTimeNs: 0,
    ...fields,
  };
}

function sample(takenAtNs: number, processes: Json[], fields: Json = {}): Json {
  return { takenAtNs, rootPid: 100, processes, gpuAvailable: true, gpuDeviceUtilization: 61, ...fields };
}

const daemon = (fields: Json = {}) =>
  processSample(100, { arguments: ["/usr/bin/node", "/opt/p/indexing-service-daemon.js"], ...fields });
const embedder = (fields: Json = {}) =>
  processSample(200, {
    name: "Python",
    arguments: ["/usr/bin/python3", "/opt/p/code-index/embedding_server.py", "--port", "1"],
    footprintBytes: 1800 * MB,
    ...fields,
  });
const qdrant = (fields: Json = {}) =>
  processSample(300, { name: "qdrant", arguments: ["/bin/qdrant", "--config-path", "c.yaml"], ...fields });

describe.skipIf(!canCompileTrayLogic)("macOS tray resource usage (compiled Swift)", () => {
  const { one } = useTrayLogicHarness();
  const usage = (previous: Json | undefined, current: Json) =>
    one({ kind: "resourceUsage", previous, current }) as {
      processes: Array<Record<string, unknown>>;
      totalFootprintBytes: number;
      totalCpuPercent: number | null;
      totalGpuPercent: number | null;
      summary: string;
    };

  describe("computeResourceUsage", () => {
    it("reports memory at once and leaves rates unknown until a second sample exists", () => {
      const result = usage(undefined, sample(5 * SECOND, [daemon({ cpuTimeNs: 9 * SECOND }), embedder()]));
      expect(result.processes.map((process) => process.cpuPercent)).toEqual([null, null]);
      expect(result.totalCpuPercent).toBeNull();
      expect(result.totalFootprintBytes).toBe(1810 * MB);
      expect(result.summary).toBe("Resources: CPU … · Memory 1.8 GB · GPU …");
    });

    it("turns counter deltas into per-core CPU and GPU percentages and sums the tree", () => {
      const before = sample(10 * SECOND, [
        daemon({ cpuTimeNs: 1 * SECOND }),
        embedder({ cpuTimeNs: 4 * SECOND, gpuTimeNs: 20 * SECOND }),
        qdrant({ cpuTimeNs: 2 * SECOND }),
      ]);
      const after = sample(12 * SECOND, [
        daemon({ cpuTimeNs: 1_500_000_000 }),
        embedder({ cpuTimeNs: 7 * SECOND, gpuTimeNs: 21_200_000_000 }),
        qdrant({ cpuTimeNs: 2_020_000_000 }),
      ]);
      const result = usage(before, after);
      expect(result.processes).toEqual([
        expect.objectContaining({ pid: 100, isRoot: true, cpuPercent: expect.closeTo(25, 6), gpuPercent: 0 }),
        expect.objectContaining({
          pid: 200,
          label: "Python · embedding_server.py",
          cpuPercent: expect.closeTo(150, 6),
          gpuPercent: expect.closeTo(60, 6),
        }),
        expect.objectContaining({ pid: 300, label: "qdrant", cpuPercent: expect.closeTo(1, 6), gpuPercent: 0 }),
      ]);
      expect(result.totalCpuPercent).toBeCloseTo(176, 6);
      expect(result.totalGpuPercent).toBeCloseTo(60, 6);
      expect(result.summary).toBe("Resources: CPU 176% · Memory 1.8 GB · GPU 60%");
      expect(result.processes.map((process) => process.title)).toEqual([
        "node · indexing-service-daemon.js (100) — CPU 25% · Memory 10 MB",
        "Python · embedding_server.py (200) — CPU 150% · Memory 1.8 GB · GPU 60%",
        "qdrant (300) — CPU 1.0% · Memory 10 MB",
      ]);
    });

    it("keeps the GPU figure on a row whose process has used the GPU, even while it idles", () => {
      const before = sample(SECOND, [daemon(), embedder({ gpuTimeNs: 40 * SECOND })]);
      const after = sample(2 * SECOND, [daemon(), embedder({ gpuTimeNs: 40 * SECOND })]);
      const result = usage(before, after);
      expect(result.processes.map((process) => [process.usesGpu, process.title])).toEqual([
        [false, "node · indexing-service-daemon.js (100) — CPU 0.0% · Memory 10 MB"],
        [true, "Python · embedding_server.py (200) — CPU 0.0% · Memory 1.8 GB · GPU 0.0%"],
      ]);
    });

    it("lists the daemon first and the other processes by memory, largest first", () => {
      const result = usage(
        undefined,
        sample(SECOND, [
          qdrant({ footprintBytes: 900 * MB }),
          daemon({ footprintBytes: 5 * MB }),
          embedder({ footprintBytes: 1200 * MB }),
        ]),
      );
      expect(result.processes.map((process) => process.pid)).toEqual([100, 200, 300]);
    });

    it("never diffs a reused pid against the counters of the process it replaced", () => {
      const before = sample(SECOND, [daemon({ cpuTimeNs: SECOND }), embedder({ cpuTimeNs: 50 * SECOND })]);
      // pid 200 now belongs to a freshly started embedder with much smaller counters.
      const after = sample(2 * SECOND, [
        daemon({ cpuTimeNs: 1_100_000_000 }),
        embedder({ startTimeUs: 999_999, cpuTimeNs: 200_000_000 }),
      ]);
      const result = usage(before, after);
      expect(result.processes.find((process) => process.pid === 200)?.cpuPercent).toBeNull();
      expect(result.totalCpuPercent).toBeCloseTo(10, 6);
    });

    it("shows no rate for a counter that went backwards, such as a closed GPU client", () => {
      const before = sample(SECOND, [daemon(), embedder({ gpuTimeNs: 30 * SECOND })]);
      const after = sample(2 * SECOND, [daemon(), embedder({ gpuTimeNs: 29 * SECOND })]);
      const result = usage(before, after);
      expect(result.processes.find((process) => process.pid === 200)?.gpuPercent).toBeNull();
      expect(result.totalGpuPercent).toBe(0);
    });

    it("caps GPU at 100% when the counters and the clock were read a moment apart", () => {
      const before = sample(SECOND, [daemon(), embedder({ gpuTimeNs: 0 })]);
      const after = sample(2 * SECOND, [daemon(), embedder({ gpuTimeNs: 1_004_000_000 })]);
      expect(usage(before, after).processes.find((process) => process.pid === 200)?.gpuPercent).toBe(100);
    });

    it("drops the GPU figures entirely when the driver exposes no per-process GPU time", () => {
      const fields = { gpuAvailable: false, gpuDeviceUtilization: null };
      const before = sample(SECOND, [daemon(), embedder({ gpuTimeNs: null })], fields);
      const after = sample(2 * SECOND, [daemon({ cpuTimeNs: 500_000_000 }), embedder({ gpuTimeNs: null })], fields);
      const result = usage(before, after);
      expect(result.totalGpuPercent).toBeNull();
      expect(result.summary).toBe("Resources: CPU 50% · Memory 1.8 GB");
      expect(result.processes[1]?.title).toBe("Python · embedding_server.py (200) — CPU 0.0% · Memory 1.8 GB");
    });

    it("computes no rates when the clock did not advance between samples", () => {
      const before = sample(5 * SECOND, [daemon({ cpuTimeNs: 0 })]);
      const after = sample(5 * SECOND, [daemon({ cpuTimeNs: SECOND })]);
      expect(usage(before, after).totalCpuPercent).toBeNull();
    });
  });

  describe("counterPercent", () => {
    const rate = (previous: number | undefined, current: number | undefined, elapsedNs: number) =>
      one({ kind: "counterPercent", previous, current, elapsedNs });

    it("divides the counter delta by the elapsed time", () => {
      expect(rate(SECOND, 1_250_000_000, SECOND)).toBeCloseTo(25, 9);
    });

    it("refuses a missing baseline, a backwards counter and zero elapsed time", () => {
      expect(rate(undefined, SECOND, SECOND)).toBeNull();
      expect(rate(2 * SECOND, SECOND, SECOND)).toBeNull();
      expect(rate(SECOND, 2 * SECOND, 0)).toBeNull();
    });
  });

  describe("labels and formatting", () => {
    it("formats memory in binary units with Activity Monitor's labels", () => {
      const memory = (bytes: number) => one({ kind: "formatMemory", bytes });
      expect(memory(512 * 1024)).toBe("512 KB");
      expect(memory(MB)).toBe("1 MB");
      expect(memory(946 * MB)).toBe("946 MB");
      expect(memory(1.5 * 1024 * MB)).toBe("1.5 GB");
    });

    it("prints small percentages with one decimal and switches to integers without a 10.0% step", () => {
      const percent = (value: number | undefined) => one({ kind: "formatPercent", value });
      expect(percent(undefined)).toBe("…");
      expect(percent(0)).toBe("0.0%");
      expect(percent(9.94)).toBe("9.9%");
      expect(percent(9.96)).toBe("10%");
      expect(percent(176.4)).toBe("176%");
    });

    it("names interpreter processes by the script they run", () => {
      const label = (name: string, args: string[]) => one({ kind: "processLabel", name, arguments: args });
      expect(label("Python", ["python3", "/x/embedding_server.py", "--port", "1"])).toBe(
        "Python · embedding_server.py",
      );
      expect(label("Python", ["python3", "-c", "from multiprocessing.resource_tracker import main"])).toBe("Python");
      expect(label("qdrant", ["qdrant", "--config-path", "c.yaml"])).toBe("qdrant");
      expect(label("node", [])).toBe("node");
      expect(label("", ["x", "y.js"])).toBe("process · y.js");
    });

    it("reads the owner pid from the GPU driver's client creator string", () => {
      const pid = (creator: string) => one({ kind: "clientPid", creator });
      expect(pid("pid 43876, Python")).toBe(43876);
      expect(pid("pid 12")).toBe(12);
      expect(pid("pid , Python")).toBeNull();
      expect(pid("Python 43876")).toBeNull();
    });
  });

  describe("rootProcessMatchesStatus", () => {
    const startedAtUs = Date.parse("2026-11-20T09:00:40.725Z") * 1000;
    const matches = (processStartTimeUs: number, statusStartedAt = "2026-11-20T09:00:40.725Z") =>
      one({ kind: "rootMatches", processStartTimeUs, statusStartedAt });

    it("accepts the daemon, which starts before it writes startedAt", () => {
      expect(matches(startedAtUs - 900_000)).toBe(true);
      expect(matches(startedAtUs + 1_500_000)).toBe(true);
      expect(matches(startedAtUs - 900_000, "2026-11-20T09:00:40Z")).toBe(true);
    });

    it("rejects a process that started after the daemon recorded its start (a reused pid)", () => {
      expect(matches(startedAtUs + 60_000_000)).toBe(false);
    });

    it("does not hide resources when startedAt cannot be parsed", () => {
      expect(matches(startedAtUs + 60_000_000, "not a date")).toBe(true);
    });
  });

  describe("resourceMenuContent", () => {
    const content = (request: Json) => one({ kind: "resourceMenuContent", unifiedMemory: true, ...request });

    it("explains a stopped service, a pending first sample and a vanished daemon in the row and submenu", () => {
      expect(content({ serviceRunning: false })).toEqual({
        title: "Resources: unavailable (service stopped)",
        processRows: ["The indexing service is not running."],
        footerRows: [],
      });
      expect(content({ serviceRunning: true })).toEqual({
        title: "Resources: measuring...",
        processRows: ["Measuring..."],
        footerRows: [],
      });
      expect(content({ serviceRunning: true, unavailable: true })).toEqual({
        title: "Resources: unavailable (daemon process not found)",
        processRows: ["The status file names a process that is not the running daemon."],
        footerRows: [],
      });
    });

    it("lists every process and explains the units, noting GPU buffers on unified memory", () => {
      const current = sample(SECOND, [daemon(), embedder({ gpuTimeNs: SECOND })]);
      expect(content({ serviceRunning: true, current })).toEqual({
        title: "Resources: CPU … · Memory 1.8 GB · GPU …",
        processRows: [
          "node · indexing-service-daemon.js (100) — CPU … · Memory 10 MB",
          "Python · embedding_server.py (200) — CPU … · Memory 1.8 GB · GPU …",
        ],
        footerRows: [
          "Whole GPU (all apps): 61%",
          "100% CPU = one core. Memory = physical footprint, as in Activity Monitor,",
          "which includes GPU (Metal) buffers in unified memory.",
        ],
      });
    });

    it("omits the whole-GPU row and the unified-memory note where they do not apply", () => {
      const current = sample(SECOND, [daemon()], { gpuDeviceUtilization: null });
      expect(content({ serviceRunning: true, current, unifiedMemory: false })).toMatchObject({
        footerRows: ["100% CPU = one core. Memory = physical footprint, as in Activity Monitor."],
      });
    });
  });
});
