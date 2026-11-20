import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  CODE_INDEX_DIR,
  interpreterCandidates,
  managedIndexingVenvPython,
  OVERRIDE_ENV,
  probeInterpreter,
  runCodeIndexPythonTests,
  selectInterpreter,
} from "./code-index-python-tests.js";

const SCRIPT = fileURLToPath(new URL("./code-index-python-tests.js", import.meta.url));
const UNITTEST_ARGS = ["-m", "unittest", "discover", "-s", "test", "-p", "test_*.py"];

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p-code-index-python-"));
  try {
    return callback(fs.realpathSync(directory));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

const PROBES = {
  numpy: "exit 0",
  "missing-numpy": `echo 'Traceback (most recent call last):' >&2; echo "ModuleNotFoundError: No module named 'numpy'" >&2; exit 1`,
  silent: "exit 5",
};

// A stand-in interpreter that needs only /bin/sh builtins: `-c "import ..."` behaves as `probe`;
// any other invocation records its cwd and arguments, then exits with `runStatus`.
function writeFakePython(file, { probe, runStatus = 0, record }) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `#!/bin/sh\nif [ "$1" = "-c" ]; then ${PROBES[probe]}; fi\n` +
      (record ? `pwd -P > '${record}'; printf '%s\\n' "$@" >> '${record}'\n` : "") +
      `exit ${runStatus}\n`,
    { mode: 0o755 },
  );
  return file;
}

function venvPythonUnder(home) {
  return path.join(home, ".p", "agent", "indexing-service", "venv", "bin", "python");
}

// PATH holds only the fake interpreters, so the host's real python3 can never stand in for one.
function isolatedEnv(directory, extra = {}) {
  const env = { ...process.env, HOME: path.join(directory, "home"), PATH: path.join(directory, "bin") };
  for (const name of [OVERRIDE_ENV, "P_CODING_AGENT_DIR", "INIT_CWD", "PYTHONPATH", "PYTHONHOME"]) delete env[name];
  return { ...env, ...extra };
}

function runScript(directory, extraEnv = {}) {
  return spawnSync(process.execPath, [SCRIPT], { cwd: directory, env: isolatedEnv(directory, extraEnv), encoding: "utf8" });
}

function readRecord(record) {
  const [cwd, ...args] = fs.readFileSync(record, "utf8").trim().split("\n");
  return { cwd, args };
}

test("an explicit interpreter override is the only candidate, even when the managed venv exists", () => {
  withTempDir((home) => {
    writeFakePython(venvPythonUnder(home), { probe: "numpy" });
    assert.deepEqual(interpreterCandidates({ [OVERRIDE_ENV]: " python3.13 " }, home), [
      { command: "python3.13", source: OVERRIDE_ENV },
    ]);
  });
});

test("a path-like override resolves from the npm invocation directory, not the package directory", () => {
  assert.deepEqual(interpreterCandidates({ [OVERRIDE_ENV]: "./venv/bin/python", INIT_CWD: "/work/repo" }, "/home/x"), [
    { command: "/work/repo/venv/bin/python", source: OVERRIDE_ENV },
  ]);
  assert.equal(interpreterCandidates({ [OVERRIDE_ENV]: "venv/bin/python" }, "/home/x")[0].command, path.resolve("venv/bin/python"));
});

test("python3 comes first and the managed indexing venv is the fallback only when it exists", () => {
  withTempDir((home) => {
    assert.deepEqual(interpreterCandidates({}, home), [{ command: "python3", source: "PATH" }]);
    const venvPython = writeFakePython(venvPythonUnder(home), { probe: "numpy" });
    assert.equal(managedIndexingVenvPython({}, home), venvPython);
    assert.deepEqual(interpreterCandidates({ [OVERRIDE_ENV]: "  " }, home), [
      { command: "python3", source: "PATH" },
      { command: venvPython, source: "managed indexing venv" },
    ]);
  });
});

test("the managed venv follows P_CODING_AGENT_DIR, resolving a relative one from the invocation directory", () => {
  assert.equal(
    managedIndexingVenvPython({ P_CODING_AGENT_DIR: "/agents/a" }, "/home/x"),
    "/agents/a/indexing-service/venv/bin/python",
  );
  assert.equal(
    managedIndexingVenvPython({ P_CODING_AGENT_DIR: "agent", INIT_CWD: "/work/repo" }, "/home/x"),
    "/work/repo/agent/indexing-service/venv/bin/python",
  );
});

test("probing reports the import error, a silent failure, a missing executable, and success", () => {
  withTempDir((directory) => {
    assert.deepEqual(probeInterpreter(writeFakePython(path.join(directory, "with"), { probe: "numpy" })), { ok: true });
    assert.deepEqual(probeInterpreter(writeFakePython(path.join(directory, "without"), { probe: "missing-numpy" })), {
      ok: false,
      reason: "ModuleNotFoundError: No module named 'numpy'",
    });
    assert.deepEqual(probeInterpreter(writeFakePython(path.join(directory, "silent"), { probe: "silent" })), {
      ok: false,
      reason: "exit status 5",
    });
    const missing = probeInterpreter(path.join(directory, "absent-python"));
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /ENOENT/);
  });
});

test("probing resolves the command through the supplied environment and working directory", () => {
  withTempDir((directory) => {
    writeFakePython(path.join(directory, "bin", "p-fake-python"), { probe: "numpy" });
    assert.deepEqual(probeInterpreter("p-fake-python", { env: { PATH: path.join(directory, "bin") } }), { ok: true });
    assert.match(probeInterpreter("p-fake-python", { env: { PATH: path.join(directory, "empty") } }).reason, /ENOENT/);
    writeFakePython(path.join(directory, "relative", "python"), { probe: "numpy" });
    assert.deepEqual(probeInterpreter("./relative/python", { cwd: directory }), { ok: true });
  });
});

test("selection takes the first qualifying interpreter and keeps the reasons for the rejected ones", () => {
  const outcomes = { a: { ok: false, reason: "no numpy" }, b: { ok: true }, c: { ok: true } };
  const candidates = ["a", "b", "c"].map((command) => ({ command, source: "test" }));
  assert.deepEqual(selectInterpreter(candidates, (command) => outcomes[command]), {
    selected: { command: "b", source: "test" },
    rejected: [{ command: "a", source: "test", reason: "no numpy" }],
  });
  assert.deepEqual(selectInterpreter([], () => ({ ok: true })), { selected: undefined, rejected: [] });
});

test("falls back to the managed venv when python3 lacks numpy and propagates the suite's exit status", () => {
  withTempDir((directory) => {
    const record = path.join(directory, "record.txt");
    writeFakePython(path.join(directory, "bin", "python3"), { probe: "missing-numpy", runStatus: 9 });
    const venvPython = writeFakePython(venvPythonUnder(path.join(directory, "home")), { probe: "numpy", runStatus: 3, record });
    const result = runScript(directory);
    assert.equal(result.status, 3, result.stderr);
    assert.ok(result.stdout.includes(`code-index Python tests: ${venvPython} (managed indexing venv)`));
    assert.deepEqual(readRecord(record), { cwd: fs.realpathSync(CODE_INDEX_DIR), args: UNITTEST_ARGS });
  });
});

test("uses python3 from PATH when it already has numpy", () => {
  withTempDir((directory) => {
    const record = path.join(directory, "record.txt");
    writeFakePython(path.join(directory, "bin", "python3"), { probe: "numpy", record });
    writeFakePython(venvPythonUnder(path.join(directory, "home")), { probe: "numpy", runStatus: 4 });
    const result = runScript(directory);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /code-index Python tests: python3 \(PATH\)/);
    assert.deepEqual(readRecord(record).args, UNITTEST_ARGS);
  });
});

test("a relative override typed at the repository root runs the same interpreter it probed", () => {
  withTempDir((directory) => {
    const record = path.join(directory, "record.txt");
    writeFakePython(path.join(directory, "venv", "bin", "python"), { probe: "numpy", record });
    const result = runScript(directory, { [OVERRIDE_ENV]: "./venv/bin/python", INIT_CWD: directory });
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(readRecord(record), { cwd: fs.realpathSync(CODE_INDEX_DIR), args: UNITTEST_ARGS });
  });
});

test("fails with every rejected interpreter and the fix when none has numpy", () => {
  withTempDir((directory) => {
    writeFakePython(path.join(directory, "bin", "python3"), { probe: "missing-numpy" });
    const venvPython = writeFakePython(venvPythonUnder(path.join(directory, "home")), { probe: "missing-numpy" });
    const result = runScript(directory);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /code-index Python tests need numpy/);
    assert.match(result.stderr, /rejected python3 \(PATH\): ModuleNotFoundError: No module named 'numpy'/);
    assert.ok(result.stderr.includes(`rejected ${venvPython} (managed indexing venv)`));
    assert.match(result.stderr, new RegExp(`Set ${OVERRIDE_ENV} to an interpreter`));
  });
});

test("an override that lacks numpy or does not exist fails instead of falling back", () => {
  withTempDir((directory) => {
    writeFakePython(path.join(directory, "bin", "python3"), { probe: "numpy" });
    const override = writeFakePython(path.join(directory, "override-python"), { probe: "missing-numpy" });
    const withoutNumpy = runScript(directory, { [OVERRIDE_ENV]: override });
    assert.equal(withoutNumpy.status, 1);
    assert.ok(withoutNumpy.stderr.includes(`rejected ${override} (${OVERRIDE_ENV}): ModuleNotFoundError`));
    const absent = path.join(directory, "absent", "python");
    const missing = runScript(directory, { [OVERRIDE_ENV]: absent });
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, new RegExp(`rejected ${absent} \\(${OVERRIDE_ENV}\\): .*ENOENT`));
  });
});

test("a suite that cannot start or is killed by a signal fails the run", () => {
  const probe = () => ({ ok: true });
  const env = { [OVERRIDE_ENV]: "python-under-test" };
  const errors = [];
  const originalError = console.error;
  const originalLog = console.log;
  console.error = (message) => errors.push(message);
  console.log = () => {};
  try {
    assert.equal(runCodeIndexPythonTests({ env, probe, spawn: () => ({ error: new Error("spawn EACCES") }) }), 1);
    assert.equal(runCodeIndexPythonTests({ env, probe, spawn: () => ({ status: null, signal: "SIGKILL" }) }), 1);
    assert.equal(runCodeIndexPythonTests({ env, probe, spawn: () => ({ status: null, signal: null }) }), 1);
  } finally {
    console.error = originalError;
    console.log = originalLog;
  }
  assert.deepEqual(errors, ["Failed to start python-under-test: spawn EACCES", "code-index Python tests terminated by SIGKILL"]);
});
