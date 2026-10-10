import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const helper = join(dirname(fileURLToPath(import.meta.url)), "workspace-file-operations.js");
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "p-workspace-files-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const packageRoot = join(root, "packages", "coding-agent");
  mkdirSync(packageRoot, { recursive: true });
  return { root, packageRoot };
}

function put(root, relativePath, value = relativePath) {
  const file = join(root, relativePath);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, value);
}

function run(packageRoot, operation) {
  return spawnSync(process.execPath, [helper, operation], { cwd: packageRoot, encoding: "utf8" });
}

test("clean removes only package dist and coverage setup creates its directory", (t) => {
  const { root, packageRoot } = fixture(t);
  put(packageRoot, "dist/old.txt");
  put(root, "packages/other/dist/keep.txt");
  assert.equal(run(packageRoot, "clean").status, 0);
  assert.equal(existsSync(join(packageRoot, "dist")), false);
  assert.equal(existsSync(join(root, "packages/other/dist/keep.txt")), true);
  assert.equal(run(packageRoot, "coverage-dir").status, 0);
  assert.equal(existsSync(join(packageRoot, "coverage")), true);
  assert.equal(run(packageRoot, "clean").status, 0);
});

test("copy-assets copies the selected files, ignores other suffixes, and overwrites stale output", (t) => {
  const { packageRoot } = fixture(t);
  put(packageRoot, "src/modes/interactive/theme/dark.json", "new-theme");
  put(packageRoot, "src/modes/interactive/theme/.private.json");
  put(packageRoot, "src/modes/interactive/theme/ignored.txt");
  const logoBytes = Buffer.from([0, 255, 1, 127]);
  put(packageRoot, "src/modes/interactive/assets/logo.png", logoBytes);
  put(packageRoot, "src/core/export-html/template.html");
  put(packageRoot, "src/core/export-html/template.css");
  put(packageRoot, "src/core/export-html/template.js");
  put(packageRoot, "src/core/export-html/vendor/lib.js");
  put(packageRoot, "src/voice-server-cli/voice-page.html");
  put(packageRoot, "dist/modes/interactive/theme/dark.json", "old-theme");
  const result = run(packageRoot, "copy-assets");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(join(packageRoot, "dist/modes/interactive/theme/dark.json"), "utf8"), "new-theme");
  assert.equal(existsSync(join(packageRoot, "dist/modes/interactive/theme/ignored.txt")), false);
  assert.equal(existsSync(join(packageRoot, "dist/modes/interactive/theme/.private.json")), false);
  assert.deepEqual(readFileSync(join(packageRoot, "dist/modes/interactive/assets/logo.png")), logoBytes);
  for (const relativePath of [
    "dist/modes/interactive/assets/logo.png",
    "dist/core/export-html/template.html",
    "dist/core/export-html/template.css",
    "dist/core/export-html/template.js",
    "dist/core/export-html/vendor/lib.js",
    "dist/voice-server-cli/voice-page.html",
  ]) {
    assert.equal(existsSync(join(packageRoot, relativePath)), true, relativePath);
  }
});

test("copy-binary-assets preserves the published layout and recursive trees", (t) => {
  const { root, packageRoot } = fixture(t);
  for (const source of ["package.json", "README.md", "CHANGELOG.md"]) put(packageRoot, source, `source:${source}`);
  put(packageRoot, "src/modes/interactive/theme/dark.json");
  const logoBytes = Buffer.from([137, 80, 78, 71, 0]);
  put(packageRoot, "src/modes/interactive/assets/logo.png", logoBytes);
  put(packageRoot, "src/core/export-html/template.html");
  put(packageRoot, "src/core/export-html/vendor/lib.js");
  put(packageRoot, "docs/nested/guide.md", "guide-data");
  put(packageRoot, "examples/nested/example.ts", "example-data");
  put(root, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm", "wasm-data");
  put(packageRoot, "dist/README.md", "stale-readme");
  const result = run(packageRoot, "copy-binary-assets");
  assert.equal(result.status, 0, result.stderr);
  for (const relativePath of [
    "dist/package.json",
    "dist/README.md",
    "dist/CHANGELOG.md",
    "dist/theme/dark.json",
    "dist/assets/logo.png",
    "dist/export-html/template.html",
    "dist/export-html/vendor/lib.js",
    "dist/docs/nested/guide.md",
    "dist/examples/nested/example.ts",
    "dist/photon_rs_bg.wasm",
  ]) {
    assert.equal(existsSync(join(packageRoot, relativePath)), true, relativePath);
  }
  for (const [relativePath, contents] of [
    ["dist/README.md", "source:README.md"],
    ["dist/docs/nested/guide.md", "guide-data"],
    ["dist/examples/nested/example.ts", "example-data"],
    ["dist/photon_rs_bg.wasm", "wasm-data"],
  ]) {
    assert.equal(readFileSync(join(packageRoot, relativePath), "utf8"), contents, relativePath);
  }
  assert.deepEqual(readFileSync(join(packageRoot, "dist/assets/logo.png")), logoBytes);
});

test("missing source files and unmatched suffixes fail the copy command", (t) => {
  const { packageRoot } = fixture(t);
  const missing = run(packageRoot, "copy-assets");
  assert.notEqual(missing.status, 0);
  put(packageRoot, "src/modes/interactive/theme/ignored.txt");
  const unmatched = run(packageRoot, "copy-assets");
  assert.notEqual(unmatched.status, 0);
  assert.match(unmatched.stderr, /\.json/u);
});

test("copy commands fail when a later required asset is absent", (t) => {
  const { packageRoot } = fixture(t);
  put(packageRoot, "src/modes/interactive/theme/dark.json");
  put(packageRoot, "src/modes/interactive/assets/logo.png");
  put(packageRoot, "src/core/export-html/template.html");
  put(packageRoot, "src/core/export-html/template.css");
  put(packageRoot, "src/core/export-html/template.js");
  assert.match(run(packageRoot, "copy-assets").stderr, /vendor/u);
  put(packageRoot, "src/core/export-html/vendor/lib.js");
  put(packageRoot, "src/voice-server-cli/voice-page.html");
  for (const source of ["package.json", "README.md", "CHANGELOG.md"]) put(packageRoot, source);
  put(packageRoot, "docs/guide.md");
  put(packageRoot, "examples/example.ts");
  const missingWasm = run(packageRoot, "copy-binary-assets");
  assert.notEqual(missingWasm.status, 0);
  assert.match(missingWasm.stderr, /photon_rs_bg\.wasm/u);
});

test("package scripts route filesystem work through the helper", () => {
  for (const name of ["ai", "agent", "code-index", "tui", "coding-agent"]) {
    const manifest = JSON.parse(readFileSync(join(repoRoot, "packages", name, "package.json"), "utf8"));
    assert.equal(manifest.scripts.clean, "node ../../scripts/workspace-file-operations.js clean", name);
  }
  const tui = JSON.parse(readFileSync(join(repoRoot, "packages/tui/package.json"), "utf8"));
  assert.match(tui.scripts["test:coverage"], /^node \.\.\/\.\.\/scripts\/workspace-file-operations\.js coverage-dir &&/u);
  const codingAgent = JSON.parse(readFileSync(join(repoRoot, "packages/coding-agent/package.json"), "utf8"));
  assert.match(codingAgent.scripts.build, /workspace-file-operations\.js chmod-cli/u);
  assert.equal(codingAgent.scripts["copy-assets"], "node ../../scripts/workspace-file-operations.js copy-assets");
  assert.equal(codingAgent.scripts["copy-binary-assets"], "node ../../scripts/workspace-file-operations.js copy-binary-assets");
});

test("chmod-cli sets executable bits without clearing existing permissions", { skip: process.platform === "win32" }, (t) => {
  const { packageRoot } = fixture(t);
  put(packageRoot, "dist/cli.js");
  put(packageRoot, "dist/voice-server-cli.js");
  for (const name of ["cli.js", "voice-server-cli.js"]) chmodSync(join(packageRoot, "dist", name), 0o640);
  const result = run(packageRoot, "chmod-cli");
  assert.equal(result.status, 0, result.stderr);
  for (const name of ["cli.js", "voice-server-cli.js"]) {
    assert.equal(statSync(join(packageRoot, "dist", name)).mode & 0o777, 0o751);
  }
});
