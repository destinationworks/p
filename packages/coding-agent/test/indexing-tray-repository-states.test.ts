import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  INDEXING_PROGRESS_PHASES,
  INDEXING_REPOSITORY_STATES,
  type IndexingProgressPhase,
  REPOSITORY_SERVICE_STATES,
  type RepositoryServiceState,
} from "./indexing-repository-service-states.ts";
import { canCompileTrayLogic, type Json, trayStatus, useTrayLogicHarness } from "./tray-macos-logic-test-harness.ts";

// Both trays read the daemon's status file. Every repository state and progress phase the daemon can
// write (checked against RepositoryServiceStatus at type-check time) is fed through the real macOS
// Swift logic and the real Linux Python logic, so neither tray can key on a state the daemon never writes.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const codeIndexDir = path.resolve(testDir, "..", "..", "code-index");
const linuxDriver = path.join(testDir, "fixtures", "tray-linux", "status_driver.py");
const canRunPython = spawnSync("python3", ["-c", "import sys; sys.exit(sys.version_info < (3, 8))"]).status === 0;
// CI does not run the Python unit tests, so there a missing python3 must fail this suite instead of skipping it.
const runLinuxTray = canRunPython || Boolean(process.env.CI);

const midIndexing = { phase: "indexing", percent: 42.9, processedFiles: 3, totalFiles: 7 };
const isIndexingState = (state: RepositoryServiceState) => INDEXING_REPOSITORY_STATES.includes(state);
const repoOf = (status: Json): Json => (status.repos as Json[])[0];
const withRepos = (...repos: Array<[string, RepositoryServiceState, Json?]>): Json => ({
  ...trayStatus("ready"),
  repos: repos.map(([name, state, extra]) => ({ ...repoOf(trayStatus(state, extra)), path: `/work/${name}` })),
});
// Labels of repositories that are not indexing. Only queued and error are distinguished today.
const idleRepoLabel = (state: RepositoryServiceState) =>
  state === "queued" ? "Queued" : state === "error" ? "Error" : "Ready (7 files)";
// The daemon rounds percent to 0.1 and both trays truncate it. Without a phase, or before the first
// progress report (the drain worker clears progress when it starts a run), there is no label.
const progressLabels: Array<[Json | undefined, string | undefined]> = [
  [{ phase: "indexing", percent: 0 }, "0%"],
  [{ phase: "indexing", percent: 99.9 }, "99%"],
  [{ phase: "indexing", percent: 100 }, "100%"],
  [{ percent: 42 }, undefined],
  [undefined, undefined],
];
const progressOf = (progress: Json | undefined) => trayStatus("initializing", progress ? { progress } : {});
const byState = (results: unknown[], width: number) =>
  Object.fromEntries(REPOSITORY_SERVICE_STATES.map((state, i) => [state, results.slice(i * width, (i + 1) * width)]));
const byPhase = (results: unknown[], width: number) =>
  Object.fromEntries(INDEXING_PROGRESS_PHASES.map((phase, i) => [phase, results.slice(i * width, (i + 1) * width)]));
// "preparing" can report 100% before any chunk is indexed and "finalizing" restarts at 0%, so only the
// indexing phase's percent is shown; the other phases are named instead.
const phaseLabel = (phase: IndexingProgressPhase) => (phase === "indexing" ? "42%" : phase);
const phaseProgress = (phase: IndexingProgressPhase) => ({ phase, percent: phase === "preparing" ? 100 : 42.9 });

describe("daemon repository states", () => {
  it("lists the indexing states among the states the daemon writes", () => {
    expect(REPOSITORY_SERVICE_STATES).toEqual(expect.arrayContaining([...INDEXING_REPOSITORY_STATES]));
    expect(REPOSITORY_SERVICE_STATES).not.toContain("indexing");
  });
});

describe.skipIf(!canCompileTrayLogic)("macOS tray presentation of daemon repository states (compiled Swift)", () => {
  const { evaluate } = useTrayLogicHarness();
  const live = { service: "loaded", processRunning: true };
  const present = (status: Json) => [
    { kind: "buttonAppearance", ...live, status },
    { kind: "headline", ...live, status },
    { kind: "repoState", repo: repoOf(status), serviceRunning: true },
  ];

  it("shows the indexing dot, tooltip, headline and repo label exactly for the states written while indexing", () => {
    // Progress from the last run can outlive it, so a finished repository still carries a progress object.
    const results = evaluate(
      REPOSITORY_SERVICE_STATES.flatMap((state) => present(trayStatus(state, { progress: midIndexing }))),
    );
    const expected = Object.fromEntries(
      REPOSITORY_SERVICE_STATES.map((state) => [
        state,
        isIndexingState(state)
          ? [
              { isIndexing: true, isError: false, toolTip: "Indexing: alpha (42%)" },
              "Status: Indexing alpha (42%)",
              "Indexing [42%]",
            ]
          : [
              { isIndexing: false, isError: state === "error", toolTip: "P Code Indexing (Idle)" },
              "Status: Ready (Idle)",
              idleRepoLabel(state),
            ],
      ]),
    );
    expect(byState(results, 3)).toEqual(expected);
  });

  it("shows the overall percent only in the indexing phase and names every other phase", () => {
    const results = evaluate(
      INDEXING_PROGRESS_PHASES.flatMap((phase) => present(trayStatus("updating", { progress: phaseProgress(phase) }))),
    );
    const expected = Object.fromEntries(
      INDEXING_PROGRESS_PHASES.map((phase) => [
        phase,
        [
          { isIndexing: true, isError: false, toolTip: `Indexing: alpha (${phaseLabel(phase)})` },
          `Status: Indexing alpha (${phaseLabel(phase)})`,
          `Indexing [${phaseLabel(phase)}]`,
        ],
      ]),
    );
    expect(byPhase(results, 3)).toEqual(expected);
  });

  it("truncates the percent and shows a run without a phase or progress as indexing", () => {
    const results = evaluate(progressLabels.flatMap(([progress]) => present(progressOf(progress))));
    expect(results).toEqual(
      progressLabels.flatMap(([, label]) => [
        { isIndexing: true, isError: false, toolTip: `Indexing: alpha${label ? ` (${label})` : ""}` },
        `Status: Indexing alpha (${label ?? "in progress"})`,
        `Indexing${label ? ` [${label}]` : ""}`,
      ]),
    );
  });

  it("names the first indexing repository among several and keeps the error mark", () => {
    const status = withRepos(
      ["gamma", "ready"],
      ["delta", "error"],
      ["alpha", "updating", { progress: midIndexing }],
      ["beta", "initializing"],
    );
    expect(evaluate(present(status).slice(0, 2))).toEqual([
      { isIndexing: true, isError: true, toolTip: "Indexing: alpha (42%)" },
      "Status: Indexing alpha (42%)",
    ]);
  });
});

describe.skipIf(!runLinuxTray)("Linux tray presentation of daemon repository states (Python)", () => {
  const evaluate = (requests: Json[]): unknown[] => {
    const run = spawnSync("python3", ["-I", "-B", linuxDriver, codeIndexDir], {
      input: JSON.stringify(requests),
      encoding: "utf8",
      timeout: 20_000,
    });
    expect(run.error, "python3 >= 3.8 must be on PATH").toBeUndefined();
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as unknown[];
  };
  const present = (status: Json, serviceState = "active") => [
    { kind: "tooltip", status, serviceState },
    { kind: "statusLine", status, serviceState },
    { kind: "repoState", repo: repoOf(status), daemonRunning: true },
  ];

  it("shows the indexing tooltip, status and repo label exactly for the states written while indexing", () => {
    const results = evaluate(
      REPOSITORY_SERVICE_STATES.flatMap((state) => present(trayStatus(state, { progress: midIndexing }))),
    );
    const expected = Object.fromEntries(
      REPOSITORY_SERVICE_STATES.map((state) => [
        state,
        isIndexingState(state)
          ? ["P Code Indexing (Indexing...)", "  Status: Indexing alpha (42%)", "Indexing [42%]"]
          : ["P Code Indexing (Idle)", "  Status: Ready (Idle)", idleRepoLabel(state)],
      ]),
    );
    expect(byState(results, 3)).toEqual(expected);
  });

  it("shows the overall percent only in the indexing phase and names every other phase", () => {
    const results = evaluate(
      INDEXING_PROGRESS_PHASES.flatMap((phase) => present(trayStatus("updating", { progress: phaseProgress(phase) }))),
    );
    const expected = Object.fromEntries(
      INDEXING_PROGRESS_PHASES.map((phase) => [
        phase,
        [
          "P Code Indexing (Indexing...)",
          `  Status: Indexing alpha (${phaseLabel(phase)})`,
          `Indexing [${phaseLabel(phase)}]`,
        ],
      ]),
    );
    expect(byPhase(results, 3)).toEqual(expected);
  });

  it("truncates the percent and shows a run without a phase or progress as indexing", () => {
    // Unlike the macOS item, the Linux tooltip never names the repository or its progress.
    const results = evaluate(progressLabels.flatMap(([progress]) => present(progressOf(progress))));
    expect(results).toEqual(
      progressLabels.flatMap(([, label]) => [
        "P Code Indexing (Indexing...)",
        `  Status: Indexing alpha${label ? ` (${label})` : ""}`,
        `Indexing${label ? ` [${label}]` : ""}`,
      ]),
    );
  });

  it("names the first indexing repository among several and shows a stopped unit as stopped", () => {
    const status = withRepos(
      ["gamma", "ready"],
      ["delta", "error"],
      ["alpha", "updating", { progress: midIndexing }],
      ["beta", "initializing"],
    );
    expect(evaluate([...present(status).slice(0, 2), { kind: "tooltip", status, serviceState: "inactive" }])).toEqual([
      "P Code Indexing (Indexing...)",
      "  Status: Indexing alpha (42%)",
      "P Code Indexing (Stopped)",
    ]);
  });
});
