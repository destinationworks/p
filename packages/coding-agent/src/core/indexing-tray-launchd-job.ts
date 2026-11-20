import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The macOS tray runs as its own per-session launchd job instead of a child of the indexing
// daemon. launchd gives the daemon's job (no ProcessType) light resource limits that clamp it to
// utility QoS; a child inherits that clamp, and under CPU load the tray's main thread starved and
// the menu took 10-30 s to open. `ProcessType = Interactive` gives the tray app-level scheduling.
// The plist lives in the agent directory, not ~/Library/LaunchAgents, so it never loads at login
// on its own: the daemon bootstraps it and stays the tray's owner.

export const TRAY_LAUNCHD_LABEL_PREFIX = "com.dst.p.code-index-tray";
/** Tells the tray it is the launchd-managed instance (see single_instance_lock.swift). */
export const TRAY_MANAGED_ENV = "P_INDEXING_TRAY_MANAGED";
/**
 * SHA-256 of the tray binary the job was defined for. Reinstall writes the new build to the same
 * path, and a running tray keeps executing the file it started from, so the digest is what makes a
 * new build a changed definition, which reloads the job and restarts the tray once.
 */
export const TRAY_BINARY_DIGEST_ENV = "P_INDEXING_TRAY_BINARY_SHA256";

/** `launchctl` exit status for "Could not find service". */
export const LAUNCHCTL_SERVICE_NOT_FOUND = 113;
const LAUNCHCTL_TIMEOUT_MS = 10_000;
/** launchd can still be dropping a job when `bootout` returns, and a bootstrap then fails with 5. */
const BOOTOUT_SETTLE_TIMEOUT_MS = 2_000;
const BOOTOUT_POLL_MS = 100;

export interface LaunchctlResult {
  /** null when launchctl could not be run or timed out. */
  status: number | null;
  stdout: string;
  stderr: string;
}

export type LaunchctlRunner = (args: string[]) => LaunchctlResult;
export type SyncSleep = (milliseconds: number) => void;

export interface TrayLaunchdJob {
  label: string;
  domain: string;
  target: string;
  plistPath: string;
}

export function runLaunchctl(args: string[]): LaunchctlResult {
  const result = spawnSync("/bin/launchctl", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: LAUNCHCTL_TIMEOUT_MS,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

function sleepSync(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

/** One job per agent directory, so a development daemon never replaces the installed tray's job. */
export function trayLaunchdJob(agentDir: string, uid: number): TrayLaunchdJob {
  const scope = createHash("sha256").update(path.resolve(agentDir)).digest("hex").slice(0, 12);
  const label = `${TRAY_LAUNCHD_LABEL_PREFIX}.${scope}`;
  const domain = `gui/${uid}`;
  return {
    label,
    domain,
    target: `${domain}/${label}`,
    plistPath: path.join(agentDir, "indexing-service", `${label}.plist`),
  };
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function trayBinaryDigest(binaryPath: string): string {
  return createHash("sha256").update(fs.readFileSync(binaryPath)).digest("hex");
}

export function renderTrayLaunchdPlist(
  label: string,
  programArguments: string[],
  agentDir: string,
  binaryDigest: string,
): string {
  const argumentLines = programArguments.map((argument) => `        <string>${escapeXml(argument)}</string>`);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    "<dict>",
    "    <key>Label</key>",
    `    <string>${escapeXml(label)}</string>`,
    "    <key>ProgramArguments</key>",
    "    <array>",
    ...argumentLines,
    "    </array>",
    "    <key>EnvironmentVariables</key>",
    "    <dict>",
    "        <key>P_CODING_AGENT_DIR</key>",
    `        <string>${escapeXml(agentDir)}</string>`,
    `        <key>${TRAY_MANAGED_ENV}</key>`,
    "        <string>1</string>",
    `        <key>${TRAY_BINARY_DIGEST_ENV}</key>`,
    `        <string>${escapeXml(binaryDigest)}</string>`,
    "    </dict>",
    "    <key>ProcessType</key>",
    "    <string>Interactive</string>",
    "    <key>RunAtLoad</key>",
    "    <true/>",
    "    <key>KeepAlive</key>",
    "    <false/>",
    "</dict>",
    "</plist>",
    "",
  ].join("\n");
}

function readFileIfPresent(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return undefined;
  }
}

function waitUntilUnloaded(job: TrayLaunchdJob, run: LaunchctlRunner, sleep: SyncSleep): void {
  for (let waited = 0; waited < BOOTOUT_SETTLE_TIMEOUT_MS; waited += BOOTOUT_POLL_MS) {
    if (run(["print", job.target]).status === LAUNCHCTL_SERVICE_NOT_FOUND) return;
    sleep(BOOTOUT_POLL_MS);
  }
}

/**
 * Starts the tray job, defining it first when needed. `kickstart` starts an idle job and leaves a
 * running one alone, so repeated calls are idempotent.
 */
export function startTrayLaunchdJob(
  job: TrayLaunchdJob,
  plist: string,
  run: LaunchctlRunner,
  sleep: SyncSleep = sleepSync,
): boolean {
  if (readFileIfPresent(job.plistPath) !== plist) {
    // A job loaded from an older definition keeps running its old binary; drop it first.
    if (run(["bootout", job.target]).status === 0) waitUntilUnloaded(job, run, sleep);
    fs.mkdirSync(path.dirname(job.plistPath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(job.plistPath, plist, { mode: 0o600 });
    fs.chmodSync(job.plistPath, 0o600);
    if (run(["bootstrap", job.domain, job.plistPath]).status === 0) return true;
    // Without the file, the next attempt repeats the reload instead of kickstarting a stale job.
    fs.rmSync(job.plistPath, { force: true });
    return false;
  }
  const kickstart = run(["kickstart", job.target]);
  if (kickstart.status === 0) return true;
  if (kickstart.status !== LAUNCHCTL_SERVICE_NOT_FOUND) return false;
  return run(["bootstrap", job.domain, job.plistPath]).status === 0;
}

export function isTrayLaunchdJobRunning(job: TrayLaunchdJob, run: LaunchctlRunner): boolean {
  const result = run(["print", job.target]);
  return result.status === 0 && /^\s*pid = \d+\s*$/m.test(result.stdout);
}
