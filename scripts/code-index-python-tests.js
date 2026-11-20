#!/usr/bin/env node

// Runs the packages/code-index Python unittest suite with an interpreter that imports numpy, the
// one third-party module CI installs for it. A host `python3` can change underneath us (Homebrew
// upgrades it to a release without numpy), so fall back to the managed indexing venv, which
// ./reinstall.sh builds from the pinned packages/code-index/requirements.txt, and fail with the
// exact fix when neither qualifies. Never skip: a skip would turn a broken host into a pass.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const CODE_INDEX_DIR = path.join(ROOT, "packages", "code-index");
export const OVERRIDE_ENV = "P_CODE_INDEX_TEST_PYTHON";
export const REQUIRED_MODULES = ["numpy"];
const UNITTEST_ARGS = ["-m", "unittest", "discover", "-s", "test", "-p", "test_*.py"];

// npm runs workspace scripts inside the package directory; INIT_CWD is where the user invoked npm,
// so relative paths in the environment keep meaning what the user typed.
function invocationDirectory(env) {
  return env.INIT_CWD ? path.resolve(env.INIT_CWD) : process.cwd();
}

export function managedIndexingVenvPython(env = process.env, homedir = os.homedir()) {
  const agentDir = env.P_CODING_AGENT_DIR
    ? path.resolve(invocationDirectory(env), env.P_CODING_AGENT_DIR)
    : path.join(homedir, ".p", "agent");
  return path.join(agentDir, "indexing-service", "venv", "bin", "python");
}

export function interpreterCandidates(env = process.env, homedir = os.homedir()) {
  const override = env[OVERRIDE_ENV]?.trim();
  if (override) {
    // A bare name is looked up on PATH; anything with a separator is a path from the invocation directory.
    const command = override.includes("/") ? path.resolve(invocationDirectory(env), override) : override;
    return [{ command, source: OVERRIDE_ENV }];
  }
  const candidates = [{ command: "python3", source: "PATH" }];
  const venvPython = managedIndexingVenvPython(env, homedir);
  if (fs.existsSync(venvPython)) candidates.push({ command: venvPython, source: "managed indexing venv" });
  return candidates;
}

// Probe with the same working directory and environment as the suite so that a passing probe
// means the suite's own interpreter lookup and imports resolve the same way.
export function probeInterpreter(command, { env = process.env, cwd = CODE_INDEX_DIR, modules = REQUIRED_MODULES } = {}) {
  const result = spawnSync(command, ["-c", `import ${modules.join(", ")}`], { cwd, env, encoding: "utf8" });
  if (result.error) return { ok: false, reason: result.error.message };
  if (result.status !== 0) {
    const lines = (result.stderr ?? "").trim().split("\n");
    return { ok: false, reason: lines[lines.length - 1] || `exit status ${result.status ?? result.signal}` };
  }
  return { ok: true };
}

export function selectInterpreter(candidates, probe) {
  const rejected = [];
  for (const candidate of candidates) {
    const outcome = probe(candidate.command);
    if (outcome.ok) return { selected: candidate, rejected };
    rejected.push({ ...candidate, reason: outcome.reason });
  }
  return { selected: undefined, rejected };
}

export function missingInterpreterMessage(rejected) {
  const lines = [`code-index Python tests need ${REQUIRED_MODULES.join(", ")} (pinned in packages/code-index/requirements.txt).`];
  for (const candidate of rejected) lines.push(`  rejected ${candidate.command} (${candidate.source}): ${candidate.reason}`);
  lines.push(
    `Set ${OVERRIDE_ENV} to an interpreter that has them, run ./reinstall.sh to create the managed indexing venv, ` +
      "or install the pinned versions for python3.",
  );
  return lines.join("\n");
}

export function runCodeIndexPythonTests({ env = process.env, homedir = os.homedir(), probe, spawn = spawnSync } = {}) {
  const probeCandidate = probe ?? ((command) => probeInterpreter(command, { env, cwd: CODE_INDEX_DIR }));
  const { selected, rejected } = selectInterpreter(interpreterCandidates(env, homedir), probeCandidate);
  if (!selected) {
    console.error(missingInterpreterMessage(rejected));
    return 1;
  }
  console.log(`code-index Python tests: ${selected.command} (${selected.source})`);
  const result = spawn(selected.command, UNITTEST_ARGS, { cwd: CODE_INDEX_DIR, env, stdio: "inherit" });
  if (result.error) {
    console.error(`Failed to start ${selected.command}: ${result.error.message}`);
    return 1;
  }
  if (result.signal) {
    console.error(`code-index Python tests terminated by ${result.signal}`);
    return 1;
  }
  return result.status ?? 1;
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runCodeIndexPythonTests();
}
