import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { distProblemMessage, findDistProblems, REQUIRED_DIST_ENTRYPOINTS } from "./check-test-dist.js";

const SCRIPT = fileURLToPath(new URL("./check-test-dist.js", import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..");

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p-test-dist-"));
  try {
    return callback(fs.realpathSync(directory));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writeBuiltCheckout(root, entrypoints = REQUIRED_DIST_ENTRYPOINTS) {
  for (const entrypoint of entrypoints) {
    fs.mkdirSync(path.dirname(path.join(root, entrypoint)), { recursive: true });
    fs.writeFileSync(path.join(root, entrypoint), "export {};\n");
  }
}

function runCheck(root) {
  return spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });
}

test("required entrypoints are each workspace package's ESM main plus the daemon the reinstall tests spawn", () => {
  const packageMains = ["tui", "ai", "agent", "code-index", "coding-agent"].map((name) => {
    const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "packages", name, "package.json"), "utf8"));
    return path.posix.join("packages", name, manifest.exports?.["."]?.import ?? manifest.main);
  });
  assert.deepEqual(REQUIRED_DIST_ENTRYPOINTS, [...packageMains, "packages/coding-agent/dist/indexing-service-daemon.js"]);
  assert.ok(fs.existsSync(path.join(REPO_ROOT, "packages/coding-agent/src/indexing-service-daemon.ts")));
});

test("a fully built checkout passes silently", () => {
  withTempDir((root) => {
    writeBuiltCheckout(root);
    assert.deepEqual(findDistProblems(root), []);
    const result = runCheck(root);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
  });
});

test("a fresh checkout without dist fails before any test runs and names the sanctioned build", () => {
  withTempDir((root) => {
    const result = runCheck(root);
    assert.equal(result.status, 1);
    for (const entrypoint of REQUIRED_DIST_ENTRYPOINTS) assert.ok(result.stderr.includes(`missing ${entrypoint}`));
    assert.match(result.stderr, /Run `npm run build` in this checkout first/);
    assert.ok(result.stderr.includes(root));
  });
});

test("a partial build reports only the missing entrypoint", () => {
  withTempDir((root) => {
    writeBuiltCheckout(root);
    fs.rmSync(path.join(root, "packages/coding-agent/dist/indexing-service-daemon.js"));
    assert.deepEqual(findDistProblems(root), ["missing packages/coding-agent/dist/indexing-service-daemon.js"]);
  });
});

test("a dist path that is a file, not a directory, counts as missing", () => {
  withTempDir((root) => {
    writeBuiltCheckout(root, REQUIRED_DIST_ENTRYPOINTS.filter((entry) => !entry.startsWith("packages/tui/")));
    fs.mkdirSync(path.join(root, "packages/tui"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages/tui/dist"), "not a directory\n");
    assert.deepEqual(findDistProblems(root), ["missing packages/tui/dist/index.js"]);
  });
});

test("an entrypoint path that is a directory counts as missing", () => {
  withTempDir((root) => {
    writeBuiltCheckout(root, REQUIRED_DIST_ENTRYPOINTS.filter((entry) => entry !== "packages/ai/dist/index.js"));
    fs.mkdirSync(path.join(root, "packages/ai/dist/index.js"), { recursive: true });
    assert.deepEqual(findDistProblems(root), ["missing packages/ai/dist/index.js"]);
  });
});

test("the check still runs when the script is invoked through a symlink", () => {
  withTempDir((directory) => {
    const linkedScript = path.join(directory, "check-test-dist.js");
    fs.symlinkSync(SCRIPT, linkedScript);
    assert.ok(fs.lstatSync(linkedScript).isSymbolicLink(), "symlink must exist");
    const result = spawnSync(process.execPath, [linkedScript, path.join(directory, "empty-checkout")], { encoding: "utf8" });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing packages\/tui\/dist\/index\.js/);
  });
});

test("test.sh runs the dist check before it installs the auth trap or moves auth.json", () => {
  const lines = fs.readFileSync(path.join(REPO_ROOT, "test.sh"), "utf8").split("\n");
  const position = (pattern) => lines.findIndex((line) => pattern.test(line));
  const check = position(/^node "\$SCRIPT_DIR\/scripts\/check-test-dist\.js"$/);
  assert.ok(check > 0, "test.sh must call scripts/check-test-dist.js unconditionally");
  assert.ok(position(/^set -e$/) < check, "set -e must make a failed check stop the run");
  assert.ok(check < position(/^trap cleanup EXIT$/));
  assert.ok(check < position(/mv "\$AUTH_FILE"/));
});

test("a symlinked dist is rejected once per directory even when its files resolve", () => {
  withTempDir((directory) => {
    const root = path.join(directory, "checkout");
    const central = path.join(directory, "central");
    writeBuiltCheckout(root, REQUIRED_DIST_ENTRYPOINTS.filter((entry) => !entry.startsWith("packages/coding-agent/")));
    writeBuiltCheckout(central, REQUIRED_DIST_ENTRYPOINTS.filter((entry) => entry.startsWith("packages/coding-agent/")));
    fs.mkdirSync(path.join(root, "packages/coding-agent"), { recursive: true });
    fs.symlinkSync(path.join(central, "packages/coding-agent/dist"), path.join(root, "packages/coding-agent/dist"));
    assert.ok(fs.lstatSync(path.join(root, "packages/coding-agent/dist")).isSymbolicLink(), "symlink must exist");
    assert.ok(fs.existsSync(path.join(root, "packages/coding-agent/dist/index.js")), "link target must resolve");
    assert.deepEqual(findDistProblems(root), ["packages/coding-agent/dist is a symlink"]);
    assert.match(runCheck(root).stderr, /Do not symlink its dist/);
  });
});

test("the failure message lists every problem under the checkout path", () => {
  assert.equal(
    distProblemMessage(["missing a", "b is a symlink"], "/checkout").split("\n").slice(0, 3).join("\n"),
    "This checkout has no usable workspace build output for ./test.sh (/checkout):\n  missing a\n  b is a symlink",
  );
});
