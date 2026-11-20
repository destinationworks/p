import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

import { HOSTED_RUNNER_LABELS, SELF_HOSTED_RUNNER_LABELS } from "./ci-runner-selection.js";

const workflow = readFileSync(resolve(".github/workflows/ci.yml"), "utf8");

/** Returns the text of one top-level job, from its key to the next job key. */
function job(name) {
  const start = workflow.indexOf(`\n  ${name}:\n`);
  assert.notEqual(start, -1, `ci.yml must define job ${name}`);
  const rest = workflow.slice(start + 1);
  const next = rest.slice(1).search(/\n {2}[\w-]+:\n/);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

/** Returns the text of one step, from its `- name:` line to the next step. */
function step(jobText, name) {
  const start = jobText.indexOf(`- name: ${name}\n`);
  assert.notEqual(start, -1, `missing step ${name}`);
  const rest = jobText.slice(start);
  const next = rest.slice(1).search(/\n\s+- name: /);
  return next === -1 ? rest : rest.slice(0, next + 1);
}

const trustGate =
  "github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository";

test("CI grants least privilege: read-only contents, plus actions read only for runner selection", () => {
  assert.match(workflow, /^permissions:\n {2}contents: read\n\njobs:/m);
  assert.match(job("select-runner"), /\n {4}permissions:\n {6}actions: read\n {6}contents: read\n/);
  assert.doesNotMatch(job("build-check-test"), /permissions:/);
});

test("runner selection runs only in a public repository and only for trusted commits", () => {
  const selector = job("select-runner");
  assert.match(selector, new RegExp(`\\n {4}if: github\\.event\\.repository\\.private == false && \\(${escape(trustGate)}\\)\\n`));
  assert.match(selector, new RegExp(`\\n {4}runs-on: ${escape(HOSTED_RUNNER_LABELS[0])}\\n`));
  assert.match(selector, /\n {4}timeout-minutes: [1-5]\n/);
  assert.match(selector, /\n {6}labels: \$\{\{ steps\.select\.outputs\.labels \}\}\n/);
});

test("the selector checks out exactly the scripts it imports, without persisted credentials", () => {
  const checkout = step(job("select-runner"), "Checkout selection script");
  assert.match(checkout, /uses: actions\/checkout@[a-f0-9]{40} # v\d+\.\d+\.\d+/);
  assert.match(checkout, /persist-credentials: false/);
  assert.match(checkout, /sparse-checkout-cone-mode: false/);
  const listed = [...checkout.matchAll(/^\s+((?:scripts\/[\w.-]+\.js|package\.json))$/gm)]
    .map(([, path]) => path)
    .sort();
  const imported = [...readFileSync(resolve("scripts/select-ci-runner.js"), "utf8").matchAll(/from "\.\/([\w.-]+)"/g)];
  const scripts = ["scripts/select-ci-runner.js", ...imported.map(([, file]) => `scripts/${file}`)];
  // Without the root package.json the ESM scripts load only where Node detects module syntax.
  assert.equal(JSON.parse(readFileSync(resolve("package.json"), "utf8")).type, "module");
  assert.deepEqual(listed, ["package.json", ...scripts].sort());
  for (const file of scripts.filter((path) => path !== "scripts/select-ci-runner.js")) {
    const source = readFileSync(resolve(file), "utf8");
    assert.doesNotMatch(source, /from "\.\//, `${file} must not need further sparse-checkout entries`);
  }
});

test("the selector passes repository visibility, the token and both policy variables", () => {
  const select = step(job("select-runner"), "Select runner");
  for (const line of [
    "GITHUB_TOKEN: ${{ github.token }}",
    "REPOSITORY_PRIVATE: ${{ github.event.repository.private }}",
    "CI_HOSTED_RUNNER_POLICY: ${{ vars.CI_HOSTED_RUNNER_POLICY }}",
    "CI_SELF_HOSTED_SLOTS: ${{ vars.CI_SELF_HOSTED_SLOTS }}",
  ]) {
    assert.ok(select.includes(line), line);
  }
  assert.match(select, /run: node scripts\/select-ci-runner\.js\n/);
});

test("the required check still runs on the self-hosted fallback when selection fails or is skipped", () => {
  const build = job("build-check-test");
  assert.match(build, /\n {4}needs: select-runner\n/);
  // Without !cancelled() a failed or skipped selector would skip build-check-test, and a skipped
  // required check reports success.
  assert.ok(build.includes(`    if: \${{ !cancelled() && (${trustGate}) }}\n`));
  const fallback = /runs-on: \$\{\{ fromJSON\(needs\.select-runner\.outputs\.labels \|\| '(\[[^']+\])'\) \}\}/.exec(build);
  assert.ok(fallback, "runs-on must fall back to a literal label list");
  assert.deepEqual(JSON.parse(fallback[1]), SELF_HOSTED_RUNNER_LABELS);
});

test("package installation is confined to GitHub-hosted runners", () => {
  const build = job("build-check-test");
  const install = step(build, "Install ripgrep on GitHub-hosted runner");
  assert.match(install, /\n\s+if: runner\.environment == 'github-hosted'\n/);
  assert.match(install, /sudo apt-get install -y --no-install-recommends ripgrep/);
  // A sudo invocation: `sudo` followed by an argument, outside a comment. Prose like "(no sudo)" is not one.
  const sudoLines = workflow.split("\n").filter((line) => /(?:^|[\s;&|(])sudo\s+[\w-]/.test(line.replace(/#.*/, "")));
  assert.equal(sudoLines.length, 2);
  for (const line of sudoLines) {
    assert.ok(install.includes(line), `sudo outside the hosted install step: ${line.trim()}`);
  }
  assert.ok(build.indexOf("Install ripgrep on GitHub-hosted runner") < build.indexOf("- name: Verify runner prerequisites"));
});

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
