import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isTrayLaunchdJobRunning,
  LAUNCHCTL_SERVICE_NOT_FOUND,
  type LaunchctlResult,
  renderTrayLaunchdPlist,
  runLaunchctl,
  startTrayLaunchdJob,
  TRAY_BINARY_DIGEST_ENV,
  TRAY_MANAGED_ENV,
  type TrayLaunchdJob,
  trayBinaryDigest,
  trayLaunchdJob,
} from "../src/core/indexing-tray-launchd-job.ts";

// The macOS tray must not be a child of the indexing daemon: launchd throttles the daemon's job
// (no ProcessType = light resource limits, utility QoS), the child inherits the clamp, and under
// load the menu took 10-30 s to open. These tests pin the launchd job that replaces the child.

type Reply = Partial<LaunchctlResult>;

/**
 * Records launchctl invocations and answers them from a per-subcommand script. Unscripted calls
 * succeed, except `print`, which reports the job as unknown (as right after a completed bootout).
 */
function fakeLaunchctl(replies: Record<string, Reply[] | Reply> = {}) {
  const calls: string[][] = [];
  const run = (args: string[]): LaunchctlResult => {
    calls.push(args);
    const scripted = replies[args[0]];
    const fallback: Reply = args[0] === "print" ? { status: LAUNCHCTL_SERVICE_NOT_FOUND } : {};
    const reply = Array.isArray(scripted) ? (scripted.shift() ?? fallback) : (scripted ?? fallback);
    return { status: 0, stdout: "", stderr: "", ...reply };
  };
  return { run, calls, subcommands: () => calls.map((args) => args[0]) };
}

const noSleep = () => {};
const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

describe("tray launchd job", () => {
  let agentDir: string;
  let job: TrayLaunchdJob;
  const program = ["/opt/p/bin/p-indexing-tray"];
  const digest = sha256("tray build 1");
  const plistFor = (binaryDigest = digest) => renderTrayLaunchdPlist(job.label, program, agentDir, binaryDigest);
  const defineJob = () => startTrayLaunchdJob(job, plistFor(), fakeLaunchctl().run, noSleep);

  beforeEach(() => {
    agentDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-tray-launchd-"));
    job = trayLaunchdJob(agentDir, 501);
  });

  afterEach(() => {
    fs.rmSync(agentDir, { recursive: true, force: true });
  });

  describe("job identity", () => {
    it("targets the user's gui domain with a label scoped to the agent directory", () => {
      expect(job.domain).toBe("gui/501");
      expect(job.label).toMatch(/^com\.dst\.p\.code-index-tray\.[0-9a-f]{12}$/);
      expect(job.target).toBe(`gui/501/${job.label}`);
      expect(job.plistPath).toBe(path.join(agentDir, "indexing-service", `${job.label}.plist`));
    });

    it("keeps the label stable per agent directory and distinct across agent directories", () => {
      expect(trayLaunchdJob(agentDir, 501).label).toBe(job.label);
      expect(trayLaunchdJob(path.join(agentDir, "other"), 501).label).not.toBe(job.label);
    });
  });

  describe("renderTrayLaunchdPlist", () => {
    it("runs the tray as an Interactive, launchd-managed job that starts once and is never respawned", () => {
      const plist = plistFor();
      expect(plist).toContain("<key>ProcessType</key>\n    <string>Interactive</string>");
      expect(plist).toContain("<key>RunAtLoad</key>\n    <true/>");
      expect(plist).toContain("<key>KeepAlive</key>\n    <false/>");
      expect(plist).toContain(`<key>Label</key>\n    <string>${job.label}</string>`);
      expect(plist).toContain("<string>/opt/p/bin/p-indexing-tray</string>");
      expect(plist).toContain(`<key>P_CODING_AGENT_DIR</key>\n        <string>${agentDir}</string>`);
      expect(plist).toContain(`<key>${TRAY_MANAGED_ENV}</key>\n        <string>1</string>`);
      expect(plist).toContain(`<key>${TRAY_BINARY_DIGEST_ENV}</key>\n        <string>${digest}</string>`);
    });

    it("escapes XML metacharacters in paths and arguments", () => {
      const plist = renderTrayLaunchdPlist("label", ["/a&b/<tray>", `it's "x"`], "/agent&dir", digest);
      expect(plist).toContain("<string>/a&amp;b/&lt;tray&gt;</string>");
      expect(plist).toContain("<string>it&apos;s &quot;x&quot;</string>");
      expect(plist).toContain("<string>/agent&amp;dir</string>");
      expect(plist).not.toMatch(/&(?!amp;|lt;|gt;|apos;|quot;)/);
    });

    it.skipIf(process.platform !== "darwin")("is a property list that plutil accepts", () => {
      const file = path.join(agentDir, "tray.plist");
      fs.writeFileSync(file, renderTrayLaunchdPlist(job.label, ["/a&b/<tray>", "--flag"], "/agent dir/it's", digest));
      const lint = spawnSync("/usr/bin/plutil", ["-lint", file], { encoding: "utf8" });
      expect(lint.status, lint.stdout + lint.stderr).toBe(0);
    });
  });

  describe("startTrayLaunchdJob", () => {
    it("on first start drops any job loaded from an older definition, writes a private plist and bootstraps it", () => {
      const launchctl = fakeLaunchctl({ bootout: { status: LAUNCHCTL_SERVICE_NOT_FOUND } });
      expect(startTrayLaunchdJob(job, plistFor(), launchctl.run, noSleep)).toBe(true);
      expect(launchctl.calls).toEqual([
        ["bootout", job.target],
        ["bootstrap", job.domain, job.plistPath],
      ]);
      expect(fs.readFileSync(job.plistPath, "utf8")).toBe(plistFor());
      expect(fs.statSync(job.plistPath).mode & 0o777).toBe(0o600);
    });

    it("kickstarts an already-defined job, which starts an idle tray and leaves a running one alone", () => {
      defineJob();
      const launchctl = fakeLaunchctl();
      expect(startTrayLaunchdJob(job, plistFor(), launchctl.run, noSleep)).toBe(true);
      expect(launchctl.calls).toEqual([["kickstart", job.target]]);
    });

    it("bootstraps again when launchd forgot the job (for example after logout)", () => {
      defineJob();
      const launchctl = fakeLaunchctl({ kickstart: { status: LAUNCHCTL_SERVICE_NOT_FOUND } });
      expect(startTrayLaunchdJob(job, plistFor(), launchctl.run, noSleep)).toBe(true);
      expect(launchctl.calls).toEqual([
        ["kickstart", job.target],
        ["bootstrap", job.domain, job.plistPath],
      ]);
    });

    it("reports failure when kickstart fails for another reason and leaves the definition in place", () => {
      defineJob();
      const launchctl = fakeLaunchctl({ kickstart: { status: 1 } });
      expect(startTrayLaunchdJob(job, plistFor(), launchctl.run, noSleep)).toBe(false);
      expect(launchctl.subcommands()).toEqual(["kickstart"]);
      expect(fs.existsSync(job.plistPath)).toBe(true);
    });

    it("reports failure when bootstrap of a forgotten job fails", () => {
      defineJob();
      const launchctl = fakeLaunchctl({ kickstart: { status: LAUNCHCTL_SERVICE_NOT_FOUND }, bootstrap: { status: 5 } });
      expect(startTrayLaunchdJob(job, plistFor(), launchctl.run, noSleep)).toBe(false);
    });

    it("reloads the job when the definition changes, waiting until launchd has dropped the old one", () => {
      defineJob();
      const moved = renderTrayLaunchdPlist(job.label, ["/new/p-indexing-tray"], agentDir, digest);
      const naps: number[] = [];
      const launchctl = fakeLaunchctl({ print: [{ status: 0 }, { status: 0 }] });
      expect(startTrayLaunchdJob(job, moved, launchctl.run, (ms) => naps.push(ms))).toBe(true);
      expect(launchctl.subcommands()).toEqual(["bootout", "print", "print", "print", "bootstrap"]);
      expect(naps).toEqual([100, 100]);
      expect(fs.readFileSync(job.plistPath, "utf8")).toBe(moved);
    });

    it("reloads a running tray once when only the binary at the same path changed", () => {
      defineJob();
      const rebuilt = fakeLaunchctl();
      expect(startTrayLaunchdJob(job, plistFor(sha256("tray build 2")), rebuilt.run, noSleep)).toBe(true);
      expect(rebuilt.subcommands()).toEqual(["bootout", "print", "bootstrap"]);

      const again = fakeLaunchctl();
      expect(startTrayLaunchdJob(job, plistFor(sha256("tray build 2")), again.run, noSleep)).toBe(true);
      expect(again.subcommands()).toEqual(["kickstart"]);
    });

    it("by default blocks between polls, so the daemon really gives launchd time to drop the old job", () => {
      const launchctl = fakeLaunchctl({ print: [{ status: 0 }] });
      const startedAt = performance.now();
      expect(startTrayLaunchdJob(job, plistFor(), launchctl.run)).toBe(true);
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(90);
      expect(launchctl.subcommands()).toEqual(["bootout", "print", "print", "bootstrap"]);
    });

    it("bounds the wait for a job launchd keeps reporting and still attempts the bootstrap", () => {
      const launchctl = fakeLaunchctl({ print: { status: 0 } });
      let slept = 0;
      expect(
        startTrayLaunchdJob(job, plistFor(), launchctl.run, (ms) => {
          slept += ms;
        }),
      ).toBe(true);
      expect(slept).toBe(2_000);
      expect(launchctl.subcommands().filter((name) => name === "print")).toHaveLength(20);
      expect(launchctl.subcommands().at(-1)).toBe("bootstrap");
    });

    it("removes a definition it could not load, so the next start retries the reload instead of kickstarting a stale job", () => {
      const failed = fakeLaunchctl({ bootstrap: { status: 5 } });
      expect(startTrayLaunchdJob(job, plistFor(), failed.run, noSleep)).toBe(false);
      expect(fs.existsSync(job.plistPath)).toBe(false);

      const retry = fakeLaunchctl();
      expect(startTrayLaunchdJob(job, plistFor(), retry.run, noSleep)).toBe(true);
      expect(retry.subcommands()).toEqual(["bootout", "print", "bootstrap"]);
    });

    it("treats a launchctl that could not run or timed out (no status) as failure", () => {
      const launchctl = fakeLaunchctl({ bootstrap: { status: null } });
      expect(startTrayLaunchdJob(job, plistFor(), launchctl.run, noSleep)).toBe(false);
    });
  });

  describe("trayBinaryDigest", () => {
    it("is the SHA-256 of the binary's bytes, independent of the file's identity and timestamps", () => {
      const binary = path.join(agentDir, "p-indexing-tray");
      fs.writeFileSync(binary, "tray build 1");
      expect(trayBinaryDigest(binary)).toBe(sha256("tray build 1"));

      const sameBytesNewFile = path.join(agentDir, "rebuilt");
      fs.writeFileSync(sameBytesNewFile, "tray build 1");
      fs.utimesSync(sameBytesNewFile, new Date(0), new Date(0));
      fs.renameSync(sameBytesNewFile, binary);
      expect(trayBinaryDigest(binary)).toBe(sha256("tray build 1"));

      fs.writeFileSync(binary, "tray build 2");
      expect(trayBinaryDigest(binary)).toBe(sha256("tray build 2"));
    });

    it("throws when the binary cannot be read", () => {
      expect(() => trayBinaryDigest(path.join(agentDir, "missing"))).toThrow(/ENOENT/);
    });
  });

  describe("isTrayLaunchdJobRunning", () => {
    it("is true only when launchd reports a live pid for the job", () => {
      const running = fakeLaunchctl({
        print: { status: 0, stdout: `${job.target} = {\n\tstate = running\n\tpid = 4242\n}` },
      });
      expect(isTrayLaunchdJobRunning(job, running.run)).toBe(true);
      expect(running.calls).toEqual([["print", job.target]]);

      const idle = fakeLaunchctl({ print: { status: 0, stdout: `${job.target} = {\n\tstate = not running\n}` } });
      expect(isTrayLaunchdJobRunning(job, idle.run)).toBe(false);

      // `pid-local endpoints` appears in every print output and must not be mistaken for a pid.
      const endpointsOnly = fakeLaunchctl({
        print: { status: 0, stdout: "\tstate = not running\n\tpid-local endpoints = {\n" },
      });
      expect(isTrayLaunchdJobRunning(job, endpointsOnly.run)).toBe(false);

      expect(isTrayLaunchdJobRunning(job, fakeLaunchctl().run)).toBe(false);
    });
  });

  describe("runLaunchctl", () => {
    it.skipIf(process.platform === "darwin")(
      "reports no status where launchctl does not exist, which callers treat as failure",
      () => {
        expect(runLaunchctl(["print", "gui/0/com.dst.p.code-index-tray.test-never-loaded"])).toEqual({
          status: null,
          stdout: "",
          stderr: "",
        });
      },
    );

    it.skipIf(process.platform !== "darwin")(
      "reports launchctl's own exit status for an unknown job (read-only)",
      () => {
        const result = runLaunchctl(["print", `gui/${process.getuid?.()}/com.dst.p.code-index-tray.test-never-loaded`]);
        expect(result.status).toBe(LAUNCHCTL_SERVICE_NOT_FOUND);
        expect(result.stdout + result.stderr).toContain("Could not find service");
      },
    );
  });
});
