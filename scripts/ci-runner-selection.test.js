import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SELF_HOSTED_SLOTS,
  HOSTED_RUNNER_LABELS,
  parseRunnerConfig,
  readSelfHostedLoad,
  SELF_HOSTED_RUNNER_LABELS,
  STALE_QUEUE_MS,
  selectRunner,
} from "./ci-runner-selection.js";

const idle = { inProgress: 0, staleQueued: 0 };

function decide(overrides) {
  return selectRunner({ repositoryPrivate: false, policy: "overflow", selfHostedSlots: 2, load: idle, ...overrides });
}

test("never selects a GitHub-hosted runner unless the repository is known to be public", () => {
  for (const repositoryPrivate of [true, null, undefined]) {
    for (const policy of ["overflow", "always"]) {
      const decision = decide({ repositoryPrivate, policy, load: { inProgress: 9, staleQueued: 9 } });
      assert.equal(decision.pool, "self-hosted", `${repositoryPrivate}/${policy}`);
      assert.deepEqual(decision.labels, SELF_HOSTED_RUNNER_LABELS);
      assert.match(decision.reason, /not public/);
    }
  }
});

test("selects only the standard hosted label, never a billed larger runner", () => {
  assert.deepEqual(HOSTED_RUNNER_LABELS, ["ubuntu-24.04"]);
  const decision = decide({ policy: "always" });
  assert.equal(decision.pool, "github-hosted");
  assert.deepEqual(decision.labels, ["ubuntu-24.04"]);
  decision.labels.push("mutated");
  assert.deepEqual(HOSTED_RUNNER_LABELS, ["ubuntu-24.04"], "decisions must not alias the shared label list");
});

test("policy never keeps a saturated pool on self-hosted; always ignores occupancy", () => {
  const saturated = { inProgress: 5, staleQueued: 3 };
  assert.equal(decide({ policy: "never", load: saturated }).pool, "self-hosted");
  assert.equal(decide({ policy: "always", load: idle }).pool, "github-hosted");
  assert.equal(decide({ policy: "always", load: null }).pool, "github-hosted");
});

test("overflow stays self-hosted below the slot limit and spills to hosted at it", () => {
  assert.equal(decide({ load: { inProgress: 1, staleQueued: 0 } }).pool, "self-hosted");
  const atLimit = decide({ load: { inProgress: 2, staleQueued: 0 } });
  assert.equal(atLimit.pool, "github-hosted");
  assert.match(atLimit.reason, /2 self-hosted job\(s\) running; CI_SELF_HOSTED_SLOTS=2/);
  assert.equal(decide({ selfHostedSlots: 1, load: { inProgress: 1, staleQueued: 0 } }).pool, "github-hosted");
});

test("overflow spills to hosted when a self-hosted job is already waiting for a runner", () => {
  const decision = decide({ load: { inProgress: 0, staleQueued: 1 } });
  assert.equal(decision.pool, "github-hosted");
  assert.match(decision.reason, /waited at least 30s/);
});

test("overflow with unknown occupancy keeps the previous self-hosted behaviour", () => {
  const decision = decide({ load: null });
  assert.equal(decision.pool, "self-hosted");
  assert.match(decision.reason, /unknown/);
});

test("parses repository variables, defaulting unset and blank values", () => {
  const defaults = { policy: "overflow", selfHostedSlots: DEFAULT_SELF_HOSTED_SLOTS };
  assert.deepEqual(parseRunnerConfig({ policy: undefined, selfHostedSlots: undefined }), defaults);
  assert.deepEqual(parseRunnerConfig({ policy: "", selfHostedSlots: " " }), defaults);
  assert.deepEqual(parseRunnerConfig({ policy: " always ", selfHostedSlots: "4" }), {
    policy: "always",
    selfHostedSlots: 4,
  });
  assert.deepEqual(parseRunnerConfig({ policy: "never", selfHostedSlots: "99" }).selfHostedSlots, 99);
});

test("rejects misspelled policies and out-of-range slot counts", () => {
  assert.throws(() => parseRunnerConfig({ policy: "hosted" }), /CI_HOSTED_RUNNER_POLICY must be one of/);
  assert.throws(() => parseRunnerConfig({ policy: "Always" }), /got "Always"/);
  for (const slots of ["0", "-1", "1.5", "100", "two", "07"]) {
    assert.throws(() => parseRunnerConfig({ selfHostedSlots: slots }), /CI_SELF_HOSTED_SLOTS/, slots);
  }
});

function fakeApi(routes) {
  const requested = [];
  return {
    requested,
    getJson: async (path) => {
      requested.push(path);
      if (!(path in routes)) throw new Error(`unexpected request ${path}`);
      return routes[path];
    },
  };
}

const now = Date.parse("2026-11-21T00:10:00Z");
const ago = (ms) => new Date(now - ms).toISOString();
const job = (status, labels, createdMsAgo = 0) => ({ status, labels, created_at: ago(createdMsAgo) });
const runsPath = (status) => `/repos/o/r/actions/runs?status=${status}&per_page=100`;
const jobsPath = (id) => `/repos/o/r/actions/runs/${id}/jobs?filter=latest&per_page=100`;

test("counts other runs' self-hosted Linux jobs, ignoring hosted, other self-hosted pools and the current run", async () => {
  const api = fakeApi({
    [runsPath("queued")]: { workflow_runs: [{ id: 11 }] },
    [runsPath("in_progress")]: { workflow_runs: [{ id: 11 }, { id: 12 }, { id: 99 }] },
    [jobsPath(11)]: {
      jobs: [job("queued", ["self-hosted", "Linux"], STALE_QUEUE_MS), job("completed", ["self-hosted", "Linux"])],
    },
    [jobsPath(12)]: {
      jobs: [
        job("in_progress", ["self-hosted", "Linux", "X64"]),
        job("in_progress", ["ubuntu-24.04"]),
        job("in_progress", ["self-hosted", "macOS"]),
        job("queued", ["self-hosted", "macOS"], STALE_QUEUE_MS * 10),
      ],
    },
  });
  const load = await readSelfHostedLoad({ getJson: api.getJson, repository: "o/r", currentRunId: "99", now });
  assert.deepEqual(load, { inProgress: 1, staleQueued: 1 });
  assert.ok(!api.requested.includes(jobsPath(99)), "the selecting run's own jobs must not be counted");
  assert.equal(api.requested.filter((path) => path === jobsPath(11)).length, 1, "runs are de-duplicated");
});

test("a job queued for less than the stale threshold is a normal pickup, not saturation", async () => {
  const api = fakeApi({
    [runsPath("queued")]: { workflow_runs: [{ id: 5 }] },
    [runsPath("in_progress")]: { workflow_runs: [] },
    [jobsPath(5)]: {
      jobs: [job("queued", ["self-hosted", "Linux"], STALE_QUEUE_MS - 1), job("waiting", ["self-hosted"], 600_000)],
    },
  });
  const load = await readSelfHostedLoad({ getJson: api.getJson, repository: "o/r", currentRunId: "1", now });
  assert.deepEqual(load, { inProgress: 0, staleQueued: 0 });
});

test("propagates API failures so the caller can fall back", async () => {
  const getJson = async () => {
    throw new Error("GET failed");
  };
  await assert.rejects(readSelfHostedLoad({ getJson, repository: "o/r", currentRunId: "1", now }), /GET failed/);
});
