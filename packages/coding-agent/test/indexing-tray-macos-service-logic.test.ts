import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Compiles the real Swift decision logic (service_state.swift, status_headline.swift) with a
// JSON driver and asserts on its answers, so the tray's state -> menu mapping is tested without AppKit.

const SWIFTC = "/usr/bin/swiftc";
const testDir = path.dirname(fileURLToPath(import.meta.url));
const swiftDir = path.resolve(testDir, "..", "src", "tray", "macos");
const harnessSource = path.join(testDir, "fixtures", "tray-macos", "main.swift");
const canCompile = process.platform === "darwin" && fs.existsSync(SWIFTC);

type Json = Record<string, unknown>;

const status = (repoState: string, extra: Json = {}): Json => ({
  pid: 4242,
  running: true,
  startedAt: "2026-10-31T00:00:00Z",
  updatedAt: "2026-10-31T00:00:01Z",
  repos: [
    {
      path: "/work/alpha",
      state: repoState,
      indexedFiles: 7,
      indexedChunks: 70,
      updatedAt: "2026-10-31T00:00:01Z",
      ...extra,
    },
  ],
});

describe.skipIf(!canCompile)("macOS tray service toggle logic (compiled Swift)", () => {
  let buildDir: string;
  let binary: string;

  const evaluate = (requests: Json[]): unknown[] => {
    const run = spawnSync(binary, { input: JSON.stringify(requests), encoding: "utf8", timeout: 20_000 });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as unknown[];
  };
  const one = (request: Json): unknown => evaluate([request])[0];

  beforeAll(() => {
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-tray-logic-"));
    binary = path.join(buildDir, "tray-logic");
    const sources = ["models.swift", "service_state.swift", "status_headline.swift"].map((name) =>
      path.join(swiftDir, name),
    );
    const compile = spawnSync(SWIFTC, ["-Onone", ...sources, harnessSource, "-o", binary], {
      encoding: "utf8",
      timeout: 240_000,
    });
    expect(compile.status, compile.stderr).toBe(0);
  }, 300_000);

  afterAll(() => {
    fs.rmSync(buildDir, { recursive: true, force: true });
  });

  describe("planServiceMenu", () => {
    it("offers Stop and enables the dependent controls while the service is loaded", () => {
      expect(one({ kind: "plan", state: "loaded", plistInstalled: true })).toEqual({
        toggleTitle: "Stop Indexing Service",
        toggleEnabled: true,
        toggleOperation: "stop",
        controlsEnabled: true,
      });
    });

    it("still offers Stop for a loaded service whose plist was deleted (bootout needs only the label)", () => {
      expect(one({ kind: "plan", state: "loaded", plistInstalled: false })).toMatchObject({
        toggleOperation: "stop",
        toggleEnabled: true,
      });
    });

    it("offers Start and disables Restart/Reindex/Prioritize when not loaded", () => {
      expect(one({ kind: "plan", state: "notLoaded", plistInstalled: true })).toEqual({
        toggleTitle: "Start Indexing Service",
        toggleEnabled: true,
        toggleOperation: "start",
        controlsEnabled: false,
      });
    });

    it("disables Start with an explanatory hint when the plist is missing", () => {
      expect(one({ kind: "plan", state: "notLoaded", plistInstalled: false })).toEqual({
        toggleTitle: "Start Indexing Service (not installed)",
        toggleEnabled: false,
        toggleOperation: null,
        controlsEnabled: false,
      });
    });

    it("exposes no action while the state is unknown", () => {
      expect(one({ kind: "plan", state: "unknown", plistInstalled: true })).toEqual({
        toggleTitle: "Checking Indexing Service...",
        toggleEnabled: false,
        toggleOperation: null,
        controlsEnabled: false,
      });
    });

    it.each([
      ["stop", "Stopping Indexing Service..."],
      ["start", "Starting Indexing Service..."],
      ["restart", "Restarting Indexing Service..."],
    ])("locks every control while %s is in flight, whatever the cached state says", (pending, title) => {
      for (const state of ["loaded", "notLoaded", "unknown"]) {
        expect(one({ kind: "plan", state, plistInstalled: true, pending })).toEqual({
          toggleTitle: title,
          toggleEnabled: false,
          toggleOperation: null,
          controlsEnabled: false,
        });
      }
    });
  });

  describe("launchctl commands", () => {
    const plist = "/Users/dst/Library/LaunchAgents/com.dst.p.code-index.plist";

    it("derives the plist path from the home directory", () => {
      expect(one({ kind: "plistPath", home: "/Users/dst" })).toBe(plist);
    });

    it("stops with bootout of the exact job label so KeepAlive cannot respawn it", () => {
      expect(one({ kind: "args", operation: "stop", uid: 501, plistPath: plist })).toEqual([
        "bootout",
        "gui/501/com.dst.p.code-index",
      ]);
    });

    it("starts by bootstrapping the plist into the user's gui domain", () => {
      expect(one({ kind: "args", operation: "start", uid: 501, plistPath: plist })).toEqual([
        "bootstrap",
        "gui/501",
        plist,
      ]);
    });

    it("restarts with kickstart -k and probes with print", () => {
      expect(one({ kind: "args", operation: "restart", uid: 501, plistPath: plist })).toEqual([
        "kickstart",
        "-k",
        "gui/501/com.dst.p.code-index",
      ]);
      expect(one({ kind: "printArgs", uid: 501 })).toEqual(["print", "gui/501/com.dst.p.code-index"]);
    });
  });

  describe("launchctl print probe", () => {
    it.each([
      [0, "loaded"],
      [113, "notLoaded"],
      [1, "notLoaded"],
    ])("maps exit status %s to %s", (exitCode, expected) => {
      expect(one({ kind: "probe", exitCode })).toBe(expected);
    });

    it("maps a spawn failure or timeout (no exit status) to unknown rather than guessing", () => {
      expect(one({ kind: "probe" })).toBe("unknown");
    });
  });

  describe("statusHeadline", () => {
    it("reports Stopped for an unloaded service even when the status file still says it is indexing", () => {
      const stale = status("indexing", { progress: { percent: 42 } });
      expect(one({ kind: "headline", service: "notLoaded", processRunning: true, status: stale })).toBe(
        "Status: Stopped",
      );
    });

    it("reports Starting while launchd has the job but no daemon process is alive yet", () => {
      expect(one({ kind: "headline", service: "loaded", processRunning: false, status: status("ready") })).toBe(
        "Status: Starting...",
      );
    });

    it("reports indexing progress and idle for a live daemon", () => {
      const indexing = status("indexing", { progress: { percent: 42.9 } });
      expect(one({ kind: "headline", service: "loaded", processRunning: true, status: indexing })).toBe(
        "Status: Indexing alpha (42%)",
      );
      expect(one({ kind: "headline", service: "loaded", processRunning: true, status: status("ready") })).toBe(
        "Status: Ready (Idle)",
      );
    });

    it("reports Checking before the first probe finishes and falls back to file data when only launchctl is unknown", () => {
      expect(one({ kind: "headline", service: "unknown", processRunning: false })).toBe("Status: Checking...");
      expect(one({ kind: "headline", service: "unknown", processRunning: true, status: status("ready") })).toBe(
        "Status: Ready (Idle)",
      );
    });

    it("marks an old cache as refreshing instead of waiting for fresh data", () => {
      expect(one({ kind: "headline", service: "notLoaded", processRunning: false, status: null, stale: true })).toBe(
        "Status: Stopped (refreshing...)",
      );
    });
  });

  describe("isCacheStale", () => {
    it.each([
      [0, false],
      [9.9, false],
      [10, false],
      [10.1, true],
      [120, true],
    ])("treats a cache %ss old as stale=%s", (ageSeconds, expected) => {
      expect(one({ kind: "stale", ageSeconds })).toBe(expected);
    });
  });

  describe("repoStateDescription", () => {
    const repo = (state: string): Json => (status(state).repos as Json[])[0];

    it("shows repositories as Stopped when the service is down, ignoring stale per-repo states", () => {
      expect(one({ kind: "repoState", repo: repo("indexing"), serviceRunning: false })).toBe("Stopped (7 files)");
    });

    it("keeps the per-repo state when the service is running", () => {
      expect(one({ kind: "repoState", repo: repo("indexing"), serviceRunning: true })).toBe("Indexing");
      expect(one({ kind: "repoState", repo: repo("error"), serviceRunning: true })).toBe("Error");
      expect(one({ kind: "repoState", repo: repo("queued"), serviceRunning: true })).toBe("Queued");
      expect(one({ kind: "repoState", repo: repo("ready"), serviceRunning: true })).toBe("Ready (7 files)");
    });
  });

  describe("serviceFailureMessage", () => {
    it("includes launchctl's own error text", () => {
      expect(
        one({ kind: "failure", operation: "start", exitCode: 5, stderr: "Bootstrap failed: 5: Input/output error\n" }),
      ).toBe("Could not start the indexing service: Bootstrap failed: 5: Input/output error");
    });

    it("falls back to the exit status, and distinguishes timeouts and spawn failures", () => {
      expect(one({ kind: "failure", operation: "stop", exitCode: 3, stderr: "  " })).toBe(
        "Could not stop the indexing service: launchctl exited with status 3.",
      );
      expect(one({ kind: "failure", operation: "stop", timedOut: true })).toBe(
        "Could not stop the indexing service: launchctl did not finish in time.",
      );
      expect(one({ kind: "failure", operation: "restart" })).toBe(
        "Could not restart the indexing service: launchctl could not be run.",
      );
    });
  });
});
