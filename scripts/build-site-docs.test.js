import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DOCS_DATA_PATH, DOCS_DIR, REGENERATE_COMMAND } from "./build-site-docs.js";

const SCRIPT = fileURLToPath(new URL("./build-site-docs.js", import.meta.url));
const REPO_ROOT = path.resolve(path.dirname(SCRIPT), "..");

const DOCS_CONFIG = {
  navigation: [{ title: "Start here", items: [{ title: "Overview", path: "index.md" }] }],
  redirects: [{ from: "old.md", to: "index.md" }],
};

function withTempDir(callback) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "p-site-docs-"));
  try {
    return callback(fs.realpathSync(directory));
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
}

function writeDoc(root, name, content) {
  fs.mkdirSync(path.join(root, DOCS_DIR), { recursive: true });
  fs.writeFileSync(path.join(root, DOCS_DIR, name), content);
}

function writeDocsCheckout(root, config = DOCS_CONFIG) {
  writeDoc(root, "docs.json", `${JSON.stringify(config, null, 2)}\n`);
  writeDoc(root, "usage.md", "# Usage\n");
  writeDoc(root, "index.md", "# Overview\n");
  writeDoc(root, "notes.txt", "not a doc\n");
}

function run(root, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args, root], { encoding: "utf8" });
}

function readDocsData(root) {
  return fs.readFileSync(path.join(root, DOCS_DATA_PATH), "utf8");
}

/** A checkout whose docsData.json the generator has just written, i.e. one that is up to date. */
function withGeneratedCheckout(callback) {
  return withTempDir((root) => {
    writeDocsCheckout(root);
    const generated = run(root);
    assert.equal(generated.status, 0, generated.stderr);
    return callback(root, readDocsData(root));
  });
}

function assertDriftFailure(result, root, committed) {
  assert.equal(result.status, 1);
  assert.match(result.stderr, new RegExp(`${DOCS_DATA_PATH} is out of date with ${DOCS_DIR}:`));
  assert.ok(result.stderr.includes(`Run \`${REGENERATE_COMMAND}\` and commit ${DOCS_DATA_PATH}.`));
  assert.equal(readDocsData(root), committed, "--check must never rewrite the committed file");
}

test("the generator writes navigation, redirects and every top-level Markdown doc in name order", () => {
  withGeneratedCheckout((_root, committed) => {
    assert.deepEqual(JSON.parse(committed), {
      ...DOCS_CONFIG,
      files: { "index.md": "# Overview\n", "usage.md": "# Usage\n" },
    });
    assert.deepEqual(Object.keys(JSON.parse(committed).files), ["index.md", "usage.md"]);
  });
});

test("only top-level Markdown files are included, sorted by name rather than creation order", () => {
  withTempDir((root) => {
    writeDocsCheckout(root);
    writeDoc(root, "zeta.md", "# Zeta\n");
    writeDoc(root, "Alpha.md", "# Alpha\n");
    fs.mkdirSync(path.join(root, DOCS_DIR, "images"));
    fs.writeFileSync(path.join(root, DOCS_DIR, "images", "nested.md"), "# Nested\n");
    fs.mkdirSync(path.join(root, DOCS_DIR, "folder.md"));
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(Object.keys(JSON.parse(readDocsData(root)).files), ["Alpha.md", "index.md", "usage.md", "zeta.md"]);
  });
});

test("redirects default to an empty list when docs.json has none", () => {
  withTempDir((root) => {
    writeDocsCheckout(root, { navigation: DOCS_CONFIG.navigation });
    assert.equal(run(root).status, 0);
    assert.deepEqual(JSON.parse(readDocsData(root)).redirects, []);
    assert.equal(run(root, "--check").status, 0);
  });
});

test("an up-to-date docsData.json passes the check without being rewritten", () => {
  withGeneratedCheckout((root, committed) => {
    const before = fs.statSync(path.join(root, DOCS_DATA_PATH)).mtimeMs;
    const result = run(root, "--check");
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /is up to date with 2 docs/);
    assert.equal(readDocsData(root), committed);
    assert.equal(fs.statSync(path.join(root, DOCS_DATA_PATH)).mtimeMs, before);
  });
});

test("a changed doc fails the check and names only that doc", () => {
  withGeneratedCheckout((root, committed) => {
    writeDoc(root, "usage.md", "# Usage\n\nA new paragraph.\n");
    const result = run(root, "--check");
    assertDriftFailure(result, root, committed);
    assert.ok(result.stderr.includes(`${DOCS_DIR}/usage.md changed`));
    assert.ok(!result.stderr.includes("index.md"));

    assert.equal(run(root).status, 0, "the suggested regeneration overwrites the stale file");
    assert.equal(JSON.parse(readDocsData(root)).files["usage.md"], "# Usage\n\nA new paragraph.\n");
    assert.equal(run(root, "--check").status, 0);
  });
});

test("a new doc that is not in docsData.json fails the check and names it", () => {
  withGeneratedCheckout((root, committed) => {
    writeDoc(root, "tray.md", "# Tray\n");
    const result = run(root, "--check");
    assertDriftFailure(result, root, committed);
    assert.ok(result.stderr.includes(`${DOCS_DIR}/tray.md is new (not in docsData.json)`));
  });
});

test("a removed doc still present in docsData.json fails the check and names it", () => {
  withGeneratedCheckout((root, committed) => {
    fs.rmSync(path.join(root, DOCS_DIR, "usage.md"));
    const result = run(root, "--check");
    assertDriftFailure(result, root, committed);
    assert.ok(result.stderr.includes(`${DOCS_DIR}/usage.md was removed (still in docsData.json)`));
  });
});

test("navigation or redirect changes in docs.json fail the check and name the field", () => {
  withGeneratedCheckout((root, committed) => {
    const config = { ...DOCS_CONFIG, redirects: [] };
    writeDoc(root, "docs.json", JSON.stringify(config));
    const result = run(root, "--check");
    assertDriftFailure(result, root, committed);
    assert.ok(result.stderr.includes(`${DOCS_DIR}/docs.json redirects changed`));
    assert.ok(!result.stderr.includes("navigation changed"));
  });
});

test("equal content with different formatting still fails, because the build would rewrite the file", () => {
  withGeneratedCheckout((root) => {
    const minified = JSON.stringify(JSON.parse(readDocsData(root)));
    fs.writeFileSync(path.join(root, DOCS_DATA_PATH), minified);
    const result = run(root, "--check");
    assertDriftFailure(result, root, minified);
    assert.match(result.stderr, /formatting, key order, or extra fields differ/);
  });
});

test("a missing or unparsable docsData.json fails the check with the regeneration command", () => {
  withTempDir((root) => {
    writeDocsCheckout(root);
    const missing = run(root, "--check");
    assert.equal(missing.status, 1);
    assert.ok(missing.stderr.includes(`${DOCS_DATA_PATH} does not exist`));
    assert.ok(missing.stderr.includes(REGENERATE_COMMAND));
    assert.ok(!fs.existsSync(path.join(root, DOCS_DATA_PATH)), "--check must not create the file");

    fs.mkdirSync(path.dirname(path.join(root, DOCS_DATA_PATH)), { recursive: true });
    fs.writeFileSync(path.join(root, DOCS_DATA_PATH), '{"files": {');
    const corrupt = run(root, "--check");
    assertDriftFailure(corrupt, root, '{"files": {');
    assert.ok(corrupt.stderr.includes(`${DOCS_DATA_PATH} is not valid JSON`));
  });
});

test("a docsData.json without a files map reports every doc as new", () => {
  withTempDir((root) => {
    writeDocsCheckout(root);
    fs.mkdirSync(path.dirname(path.join(root, DOCS_DATA_PATH)), { recursive: true });
    fs.writeFileSync(path.join(root, DOCS_DATA_PATH), "null");
    const result = run(root, "--check");
    assertDriftFailure(result, root, "null");
    for (const doc of ["index.md", "usage.md"]) assert.ok(result.stderr.includes(`${DOCS_DIR}/${doc} is new`));
    assert.ok(result.stderr.includes(`${DOCS_DIR}/docs.json navigation changed`));
  });
});

test("a missing docs.json fails both modes without writing", () => {
  withTempDir((root) => {
    for (const args of [[], ["--check"]]) {
      const result = run(root, ...args);
      assert.equal(result.status, 1);
      assert.ok(result.stderr.includes(`docs.json not found at ${path.join(root, DOCS_DIR, "docs.json")}`));
    }
    assert.ok(!fs.existsSync(path.join(root, DOCS_DATA_PATH)));
  });
});

test("a mistyped flag or a second root is rejected instead of regenerating the file", () => {
  withGeneratedCheckout((root, committed) => {
    writeDoc(root, "usage.md", "# Usage, edited\n");
    for (const args of [["--chek"], ["-c"], [root]]) {
      const result = run(root, ...args);
      assert.equal(result.status, 1, `${args.join(" ")} must fail`);
      assert.match(result.stderr, /^Unexpected arguments: /);
      assert.match(result.stderr, /Usage: node scripts\/build-site-docs\.js \[--check\]/);
    }
    assert.equal(readDocsData(root), committed);
  });
});

test("npm run check and CI run the drift check, and CI runs it before the build rewrites the file", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
  assert.equal(manifest.scripts["check:site-docs"], "node scripts/build-site-docs.js --check");
  assert.ok(manifest.scripts.check.split(" && ").includes("npm run check:site-docs"));
  assert.ok(manifest.scripts["test:scripts"].includes("scripts/build-site-docs.test.js"));

  const workflow = fs.readFileSync(path.join(REPO_ROOT, ".github/workflows/ci.yml"), "utf8");
  const jobStart = workflow.indexOf("\n  build-check-test:\n");
  assert.notEqual(jobStart, -1, "ci.yml must define the build-check-test job");
  const nextJob = workflow.slice(jobStart + 1).search(/\n {2}[\w-]+:\n/);
  const job = nextJob === -1 ? workflow.slice(jobStart) : workflow.slice(jobStart, jobStart + 1 + nextJob);
  const driftCheck = job.indexOf("run: npm run check:site-docs\n");
  const build = job.indexOf("- name: Build\n        run: npm run build\n");
  assert.notEqual(driftCheck, -1, "build-check-test must run npm run check:site-docs");
  assert.notEqual(build, -1, "build-check-test must run npm run build");
  assert.ok(driftCheck < build, "the drift check must run before the build rewrites docsData.json");
});
