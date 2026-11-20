import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { HOSTED_RUNNER_LABELS, SELF_HOSTED_RUNNER_LABELS } from "./ci-runner-selection.js";
import { runSelection } from "./select-ci-runner.js";

const execFileAsync = promisify(execFile);
const script = resolve("scripts/select-ci-runner.js");

async function withApi(handler, body) {
  const requests = [];
  const server = createServer((request, response) => {
    requests.push({ url: request.url, headers: request.headers });
    const { status, json } = handler(request.url);
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(json));
  });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  try {
    return await body(`http://127.0.0.1:${server.address().port}`, requests);
  } finally {
    await new Promise((done) => server.close(done));
  }
}

async function withWorkflowFiles(body) {
  const directory = mkdtempSync(join(tmpdir(), "select-ci-runner-"));
  const output = join(directory, "output");
  const summary = join(directory, "summary");
  writeFileSync(output, "");
  try {
    return await body({ output, summary, read: (path) => readFileSync(path, "utf8") });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function baseEnv(files, apiUrl, overrides = {}) {
  return {
    PATH: process.env.PATH,
    GITHUB_API_URL: apiUrl,
    GITHUB_TOKEN: "test-token",
    GITHUB_REPOSITORY: "o/r",
    GITHUB_RUN_ID: "7",
    GITHUB_OUTPUT: files.output,
    GITHUB_STEP_SUMMARY: files.summary,
    REPOSITORY_PRIVATE: "false",
    ...overrides,
  };
}

function runScript(env) {
  return execFileAsync(process.execPath, [script], { env, timeout: 20_000 }).then(
    ({ stdout }) => ({ code: 0, stdout }),
    (error) => ({ code: error.code, stdout: error.stdout }),
  );
}

const busyPool = (url) => {
  if (url.startsWith("/repos/o/r/actions/runs?status=queued")) return { status: 200, json: { workflow_runs: [] } };
  if (url.startsWith("/repos/o/r/actions/runs?status=in_progress")) {
    return { status: 200, json: { workflow_runs: [{ id: 1 }, { id: 2 }] } };
  }
  const running = { status: "in_progress", labels: ["self-hosted", "Linux"], created_at: "2026-11-21T00:00:00Z" };
  return { status: 200, json: { jobs: [running] } };
};

test("CLI spills to the hosted runner when the self-hosted pool is full", async () => {
  await withWorkflowFiles(async (files) => {
    await withApi(busyPool, async (apiUrl, requests) => {
      const result = await runScript(baseEnv(files, apiUrl));
      assert.equal(result.code, 0, result.stdout);
      assert.equal(files.read(files.output), `labels=${JSON.stringify(HOSTED_RUNNER_LABELS)}\npool=github-hosted\n`);
      assert.match(files.read(files.summary), /runs on `\["ubuntu-24\.04"\]`: 2 self-hosted job\(s\) running/);
      assert.equal(requests.length, 4);
      for (const { headers } of requests) {
        assert.equal(headers.authorization, "Bearer test-token");
        assert.equal(headers["x-github-api-version"], "2022-11-28");
      }
    });
  });
});

test("CLI keeps the self-hosted pool and warns when the occupancy API fails", async () => {
  await withWorkflowFiles(async (files) => {
    await withApi(
      () => ({ status: 403, json: { message: "Resource not accessible by integration" } }),
      async (apiUrl) => {
        const result = await runScript(baseEnv(files, apiUrl, { CI_SELF_HOSTED_SLOTS: "1" }));
        assert.equal(result.code, 0, result.stdout);
        assert.match(result.stdout, /::warning title=Runner selection::.*HTTP 403/);
        assert.match(files.read(files.output), /^labels=\["self-hosted","Linux"\]\npool=self-hosted\n$/);
      },
    );
  });
});

test("CLI fails on a misspelled policy without writing labels, leaving the workflow fallback", async () => {
  await withWorkflowFiles(async (files) => {
    const result = await runScript(baseEnv(files, "http://127.0.0.1:9", { CI_HOSTED_RUNNER_POLICY: "hosted" }));
    assert.equal(result.code, 1);
    assert.match(result.stdout, /::error title=Runner selection::CI_HOSTED_RUNNER_POLICY must be one of/);
    assert.equal(files.read(files.output), "");
  });
});

test("a private or unknown repository visibility never queries the API and stays self-hosted", async () => {
  for (const visibility of ["true", "", undefined]) {
    await withWorkflowFiles(async (files) => {
      const fetchImpl = () => assert.fail("must not call the API");
      const env = { ...baseEnv(files, "http://unused"), REPOSITORY_PRIVATE: visibility };
      const decision = await runSelection({ env, fetchImpl, log: () => {} });
      assert.deepEqual(decision.labels, SELF_HOSTED_RUNNER_LABELS);
      assert.match(files.read(files.output), /pool=self-hosted/);
    });
  }
});

test("policy always selects hosted without reading occupancy and tolerates a missing summary file", async () => {
  await withWorkflowFiles(async (files) => {
    const fetchImpl = () => assert.fail("must not call the API");
    const env = { ...baseEnv(files, "http://unused", { CI_HOSTED_RUNNER_POLICY: "always" }) };
    delete env.GITHUB_STEP_SUMMARY;
    const lines = [];
    const decision = await runSelection({ env, fetchImpl, log: (line) => lines.push(line) });
    assert.equal(decision.pool, "github-hosted");
    assert.deepEqual(lines, [`Selected github-hosted ["ubuntu-24.04"]: ${decision.reason}`]);
  });
});

test("defaults the API base URL to api.github.com when the runner does not set it", async () => {
  await withWorkflowFiles(async (files) => {
    const urls = [];
    const fetchImpl = async (url) => {
      urls.push(url);
      return { ok: true, json: async () => ({ workflow_runs: [] }) };
    };
    const env = baseEnv(files, "");
    const decision = await runSelection({ env, fetchImpl, log: () => {} });
    assert.equal(decision.pool, "self-hosted");
    assert.deepEqual(urls, [
      "https://api.github.com/repos/o/r/actions/runs?status=queued&per_page=100",
      "https://api.github.com/repos/o/r/actions/runs?status=in_progress&per_page=100",
    ]);
  });
});
