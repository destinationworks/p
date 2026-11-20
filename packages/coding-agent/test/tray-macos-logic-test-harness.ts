import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect } from "vitest";
import type { RepositoryServiceState } from "./indexing-repository-service-states.ts";

// Compiles the real Foundation-only Swift tray logic (models, service_state, status_headline) with the
// JSON driver in fixtures/tray-macos/main.swift, so tray decisions are tested without AppKit.

const SWIFTC = "/usr/bin/swiftc";
const testDir = path.dirname(fileURLToPath(import.meta.url));
const swiftDir = path.resolve(testDir, "..", "src", "tray", "macos");
const harnessSource = path.join(testDir, "fixtures", "tray-macos", "main.swift");

export type Json = Record<string, unknown>;

export const canCompileTrayLogic = process.platform === "darwin" && fs.existsSync(SWIFTC);

/** A daemon status file with one repository in the given state. */
export function trayStatus(repoState: RepositoryServiceState, extra: Json = {}): Json {
  return {
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
  };
}

/** Builds the harness once for the calling describe block and returns its request runners. */
export function useTrayLogicHarness(): { evaluate: (requests: Json[]) => unknown[]; one: (request: Json) => unknown } {
  let buildDir = "";
  let binary = "";

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

  const evaluate = (requests: Json[]): unknown[] => {
    const run = spawnSync(binary, { input: JSON.stringify(requests), encoding: "utf8", timeout: 20_000 });
    expect(run.status, run.stderr).toBe(0);
    return JSON.parse(run.stdout) as unknown[];
  };
  return { evaluate, one: (request) => evaluate([request])[0] };
}
