import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentDir } from "../config.ts";
import {
  isTrayLaunchdJobRunning,
  type LaunchctlRunner,
  renderTrayLaunchdPlist,
  runLaunchctl,
  startTrayLaunchdJob,
  type TrayLaunchdJob,
  trayBinaryDigest,
  trayLaunchdJob,
} from "./indexing-tray-launchd-job.ts";

export interface IndexingTrayManagerOptions {
  agentDir?: string;
  platform?: NodeJS.Platform;
  spawnProcess?: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  /** macOS: runs `launchctl` for the tray's launchd job. */
  runLaunchctl?: LaunchctlRunner;
  uid?: number;
  now?: () => number;
  resolveCommand?: (agentDir: string, platform: NodeJS.Platform) => TrayCommandPlan | undefined;
}

export interface IndexingTrayService {
  start(): boolean;
  stop(): void;
  isRunning(): boolean;
}

/**
 * After a successful macOS start, further starts within this window skip `launchctl`: the daemon
 * calls start() on every config-file event, and each spawn blocks its throttled event loop.
 */
export const TRAY_LAUNCHD_RECHECK_MS = 60_000;

export function isGuiDesktopAvailable(platform: NodeJS.Platform = process.platform): boolean {
  if (platform === "darwin" || platform === "win32") {
    return true;
  }
  if (platform === "linux") {
    return Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
  }
  return false;
}

export function isTrayEnabled(agentDir: string = getAgentDir()): boolean {
  const configPath = path.join(agentDir, "code-rag.json");
  try {
    if (fs.existsSync(configPath)) {
      const parsed = JSON.parse(fs.readFileSync(configPath, "utf8")) as Record<string, unknown>;
      if (parsed.enableTray === false) return false;
    }
  } catch {
    // Default to true on parse errors.
  }

  const settingsPath = path.join(agentDir, "settings.json");
  try {
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf8")) as Record<string, unknown>;
      if (parsed.enableIndexingTray === false) return false;
    }
  } catch {
    // Default to true on parse errors.
  }

  return true;
}

export interface TrayCommandPlan {
  command: string;
  args: string[];
}

export function resolveTrayCommand(
  agentDir: string = getAgentDir(),
  platform: NodeJS.Platform = process.platform,
): TrayCommandPlan | undefined {
  if (platform === "darwin") {
    const candidatePaths = [
      path.join(agentDir, "indexing-service", "bin", "p-indexing-tray"),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "dist", "bin", "p-indexing-tray"),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "p-indexing-tray"),
    ];
    for (const binPath of candidatePaths) {
      if (fs.existsSync(binPath)) {
        return { command: binPath, args: [] };
      }
    }
    return undefined;
  }

  if (platform === "linux") {
    const venvPython = path.join(agentDir, "indexing-service", "venv", "bin", "python");
    const pythonExec = fs.existsSync(venvPython) ? venvPython : "python3";
    const candidateScripts = [
      path.join(agentDir, "indexing-service", "indexing_tray.py"),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "code-index", "indexing_tray.py"),
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "code-index", "indexing_tray.py"),
    ];
    for (const scriptPath of candidateScripts) {
      if (fs.existsSync(scriptPath)) {
        return { command: pythonExec, args: [scriptPath] };
      }
    }
    return undefined;
  }

  return undefined;
}

/**
 * macOS: the tray is a separate launchd job (see indexing-tray-launchd-job.ts), so it is not
 * throttled with the daemon. Linux: a detached child of the daemon inside its systemd unit.
 */
export class IndexingTrayManager implements IndexingTrayService {
  private readonly agentDir: string;
  private readonly platform: NodeJS.Platform;
  private readonly spawnProcess: (command: string, args: string[], options: Record<string, unknown>) => ChildProcess;
  private readonly runLaunchctl: LaunchctlRunner;
  private readonly uid: number;
  private readonly now: () => number;
  private launchdStartedAt: number | undefined;
  private readonly resolveCommand: (agentDir: string, platform: NodeJS.Platform) => TrayCommandPlan | undefined;
  private process: ChildProcess | undefined;

  constructor(options: IndexingTrayManagerOptions = {}) {
    this.agentDir = options.agentDir ?? getAgentDir();
    this.platform = options.platform ?? process.platform;
    this.spawnProcess = options.spawnProcess ?? ((cmd, args, opts) => spawn(cmd, args, opts));
    this.runLaunchctl = options.runLaunchctl ?? runLaunchctl;
    this.uid = options.uid ?? process.getuid?.() ?? 0;
    this.now = options.now ?? Date.now;
    this.resolveCommand = options.resolveCommand ?? resolveTrayCommand;
  }

  private get launchdJob(): TrayLaunchdJob {
    return trayLaunchdJob(this.agentDir, this.uid);
  }

  start(): boolean {
    if (!isGuiDesktopAvailable(this.platform) || !isTrayEnabled(this.agentDir)) {
      return false;
    }
    if (this.platform !== "darwin" && this.isRunning()) {
      return true;
    }
    const plan = this.resolveCommand(this.agentDir, this.platform);
    if (!plan) {
      return false;
    }
    if (this.platform === "darwin") return this.startLaunchdJob(plan);
    try {
      const child = this.spawnProcess(plan.command, plan.args, {
        detached: true,
        stdio: "ignore",
        env: {
          ...process.env,
          P_CODING_AGENT_DIR: this.agentDir,
        },
      });
      child.unref();
      this.process = child;
      child.on("exit", () => {
        if (this.process === child) {
          this.process = undefined;
        }
      });
      return true;
    } catch {
      return false;
    }
  }

  stop(): void {
    if (this.platform === "darwin") {
      this.launchdStartedAt = undefined;
      // A signal, not `bootout`: during a tray-initiated service Stop the tray ignores SIGTERM,
      // which a bootout would escalate to SIGKILL.
      this.runLaunchctl(["kill", "TERM", this.launchdJob.target]);
      return;
    }
    if (!this.process) return;
    try {
      this.process.kill("SIGTERM");
    } catch {
      // Best effort process termination.
    }
    this.process = undefined;
  }

  private startLaunchdJob(plan: TrayCommandPlan): boolean {
    const startedAt = this.launchdStartedAt;
    if (startedAt !== undefined && this.now() - startedAt < TRAY_LAUNCHD_RECHECK_MS) return true;
    const job = this.launchdJob;
    let started = false;
    try {
      // Hashed before any launchctl call, so an unreadable binary leaves a running tray alone.
      const digest = trayBinaryDigest(plan.command);
      const plist = renderTrayLaunchdPlist(job.label, [plan.command, ...plan.args], this.agentDir, digest);
      started = startTrayLaunchdJob(job, plist, this.runLaunchctl);
    } catch {
      // An unreadable tray binary or an unwritable agent directory: report no tray and retry at
      // the next call.
    }
    this.launchdStartedAt = started ? this.now() : undefined;
    return started;
  }

  isRunning(): boolean {
    if (this.platform === "darwin") return isTrayLaunchdJobRunning(this.launchdJob, this.runLaunchctl);
    if (!this.process || this.process.killed || this.process.exitCode !== null) return false;
    if (typeof this.process.pid === "number" && this.process.pid > 0) {
      try {
        process.kill(this.process.pid, 0);
        return true;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM") return true;
        if (code === "ESRCH") {
          this.process = undefined;
          return false;
        }
      }
    }
    return this.process !== undefined;
  }
}
