import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// The "Resources:" row is updated once a second while the menu is open. Restructuring an open
// NSMenu makes it jump, so rows must be retitled in place and only added or removed when the
// number of processes changes. Runs the real AppKit section through a JSON driver.

const SWIFTC = "/usr/bin/swiftc";
const testDir = path.dirname(fileURLToPath(import.meta.url));
const swiftDir = path.resolve(testDir, "..", "src", "tray", "macos");
const driverSource = path.join(testDir, "fixtures", "tray-macos-menu-section", "main.swift");
const canCompile = process.platform === "darwin" && fs.existsSync(SWIFTC);

type Row = { id: number; title: string; separator: boolean; hidden: boolean; enabled: boolean };
type Snapshot = { id: number; title: string; enabled: boolean; rows: Row[] };
type Step = { serviceRunning: boolean; pids?: number[]; memoryMb?: number; unavailable?: boolean };

const FOOTER = [
  "Whole GPU (all apps): 42%",
  "100% CPU = one core. Memory = physical footprint, as in Activity Monitor.",
];

describe.skipIf(!canCompile)("macOS tray resource menu section (compiled AppKit)", () => {
  let buildDir = "";
  let binary = "";

  beforeAll(() => {
    buildDir = fs.mkdtempSync(path.join(os.tmpdir(), "p-tray-menu-section-"));
    binary = path.join(buildDir, "menu-section");
    const sources = ["resource_usage.swift", "resource_menu_section.swift"].map((name) => path.join(swiftDir, name));
    const compile = spawnSync(SWIFTC, ["-Onone", ...sources, driverSource, "-o", binary], {
      encoding: "utf8",
      timeout: 240_000,
    });
    expect(compile.status, compile.stderr).toBe(0);
  }, 300_000);

  afterAll(() => {
    fs.rmSync(buildDir, { recursive: true, force: true });
  });

  const run = (initial: Step, updates: Step[] = []): { created: boolean; snapshots: Snapshot[] } => {
    const result = spawnSync(binary, {
      input: JSON.stringify({ unifiedMemory: false, initial, updates }),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(result.status, result.stderr).toBe(0);
    return JSON.parse(result.stdout) as { created: boolean; snapshots: Snapshot[] };
  };
  const visible = (snapshot: Snapshot | undefined) =>
    (snapshot?.rows ?? []).filter((row) => !row.hidden).map((row) => (row.separator ? "---" : row.title));

  it("adds no resource row to a menu opened while the service is stopped", () => {
    expect(run({ serviceRunning: false })).toEqual({ created: false, snapshots: [] });
  });

  it("opens as an enabled measuring row whose submenu can already be opened", () => {
    const [opened] = run({ serviceRunning: true }).snapshots;
    expect(opened).toMatchObject({ title: "  Resources: measuring...", enabled: true });
    expect(visible(opened)).toEqual(["Measuring..."]);
    expect(opened?.rows.every((row) => row.separator || !row.enabled)).toBe(true);
  });

  it("retitles the same row objects when a new sample changes only the numbers", () => {
    const { snapshots } = run({ serviceRunning: true, pids: [10, 20], memoryMb: 100 }, [
      { serviceRunning: true, pids: [10, 20], memoryMb: 300 },
    ]);
    const [before, after] = snapshots;
    expect(visible(after)).toEqual([
      "node (10) — CPU … · Memory 300 MB",
      "node (20) — CPU … · Memory 300 MB",
      "---",
      ...FOOTER,
    ]);
    expect(after?.title).toBe("  Resources: CPU … · Memory 600 MB");
    expect(after?.rows.map((row) => row.id)).toEqual(before?.rows.map((row) => row.id));
    expect(after?.id).toBe(before?.id);
  });

  it("grows and shrinks the process rows above the separator, keeping the surviving rows", () => {
    const { snapshots } = run({ serviceRunning: true }, [
      { serviceRunning: true, pids: [10, 20, 30] },
      { serviceRunning: true, pids: [10] },
    ]);
    const [measuring, three, one] = snapshots;
    expect(visible(three)).toEqual([
      "node (10) — CPU … · Memory 1 MB",
      "node (20) — CPU … · Memory 1 MB",
      "node (30) — CPU … · Memory 1 MB",
      "---",
      ...FOOTER,
    ]);
    // The "Measuring..." row is reused for the first process rather than replaced.
    expect(three?.rows[0]?.id).toBe(measuring?.rows[0]?.id);
    expect(visible(one)).toEqual(["node (10) — CPU … · Memory 1 MB", "---", ...FOOTER]);
    expect(one?.rows.map((row) => row.id)).toEqual(
      three?.rows.filter((_, index) => index === 0 || index >= 3).map((row) => row.id),
    );
  });

  it("keeps the row in an open menu when the service stops, and hides the separator and footer", () => {
    const { snapshots } = run({ serviceRunning: true, pids: [10] }, [{ serviceRunning: false }]);
    const stopped = snapshots[1];
    expect(stopped?.title).toBe("  Resources: unavailable (service stopped)");
    expect(visible(stopped)).toEqual(["The indexing service is not running."]);
    expect(stopped?.rows.some((row) => row.separator && row.hidden)).toBe(true);
  });

  it("reports a daemon pid that no longer belongs to the daemon without listing footer rows", () => {
    const { snapshots } = run({ serviceRunning: true, pids: [10] }, [{ serviceRunning: true, unavailable: true }]);
    expect(snapshots[1]?.title).toBe("  Resources: unavailable (daemon process not found)");
    expect(visible(snapshots[1])).toEqual(["The status file names a process that is not the running daemon."]);
  });
});
