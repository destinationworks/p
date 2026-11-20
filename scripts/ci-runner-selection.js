// Chooses where the CI `build-check-test` job runs: the self-hosted Linux pool or a standard
// GitHub-hosted runner. Standard GitHub-hosted runners cost nothing only in a public repository
// (private repositories draw on the account's included minutes), so hosted capacity is used only
// when the repository is public. See docs/ci-runners.md.

/** Standard GitHub-hosted label. Larger runners are always billed, so never select one. */
export const HOSTED_RUNNER_LABELS = Object.freeze(["ubuntu-24.04"]);
/** The self-hosted pool, and the fallback the workflow uses when selection did not succeed. */
export const SELF_HOSTED_RUNNER_LABELS = Object.freeze(["self-hosted", "Linux"]);

export const HOSTED_RUNNER_POLICIES = Object.freeze(["overflow", "always", "never"]);
export const DEFAULT_HOSTED_RUNNER_POLICY = "overflow";
export const DEFAULT_SELF_HOSTED_SLOTS = 2;
/** A self-hosted job queued at least this long means the pool has no idle runner. */
export const STALE_QUEUE_MS = 30_000;

/**
 * Validates the repository-variable configuration. Unset or empty values use the defaults; any
 * other invalid value throws, so a typo fails the selection job instead of silently changing policy.
 */
export function parseRunnerConfig({ policy, selfHostedSlots }) {
  const resolvedPolicy = policy?.trim() || DEFAULT_HOSTED_RUNNER_POLICY;
  if (!HOSTED_RUNNER_POLICIES.includes(resolvedPolicy)) {
    throw new Error(
      `CI_HOSTED_RUNNER_POLICY must be one of ${HOSTED_RUNNER_POLICIES.join(", ")}; got ${JSON.stringify(policy)}`,
    );
  }
  const slotsText = selfHostedSlots?.trim() || String(DEFAULT_SELF_HOSTED_SLOTS);
  if (!/^[1-9][0-9]?$/.test(slotsText)) {
    throw new Error(`CI_SELF_HOSTED_SLOTS must be an integer from 1 to 99; got ${JSON.stringify(selfHostedSlots)}`);
  }
  return { policy: resolvedPolicy, selfHostedSlots: Number(slotsText) };
}

function selfHosted(reason) {
  return { pool: "self-hosted", labels: [...SELF_HOSTED_RUNNER_LABELS], reason };
}

function hosted(reason) {
  return { pool: "github-hosted", labels: [...HOSTED_RUNNER_LABELS], reason };
}

/**
 * Pure selection policy. `load` is the self-hosted occupancy seen in this repository, or null when
 * it could not be read; an unknown load keeps the job on the self-hosted pool.
 */
export function selectRunner({ repositoryPrivate, policy, selfHostedSlots, load }) {
  if (repositoryPrivate !== false) {
    return selfHosted("repository is not public, so GitHub-hosted minutes would draw on the included quota");
  }
  if (policy === "never") {
    return selfHosted("CI_HOSTED_RUNNER_POLICY=never");
  }
  if (policy === "always") {
    return hosted("CI_HOSTED_RUNNER_POLICY=always (standard runner, free for a public repository)");
  }
  if (load === null) {
    return selfHosted("self-hosted occupancy is unknown, so the job stays on the self-hosted pool");
  }
  if (load.staleQueued > 0) {
    return hosted(`${load.staleQueued} self-hosted job(s) waited at least ${STALE_QUEUE_MS / 1000}s for a runner`);
  }
  if (load.inProgress >= selfHostedSlots) {
    return hosted(`${load.inProgress} self-hosted job(s) running; CI_SELF_HOSTED_SLOTS=${selfHostedSlots}`);
  }
  return selfHosted(`${load.inProgress} of ${selfHostedSlots} self-hosted slot(s) busy and no job waiting`);
}

/**
 * Counts this repository's other jobs on the self-hosted Linux pool that are running or waiting for
 * a runner. Reads one page of up to 100 runs per status; a longer backlog is undercounted, which
 * can only keep a job on the self-hosted pool. `getJson(path)` performs an authenticated GitHub
 * REST GET and returns the parsed body.
 */
export async function readSelfHostedLoad({ getJson, repository, currentRunId, now }) {
  const runIds = new Set();
  for (const status of ["queued", "in_progress"]) {
    const page = await getJson(`/repos/${repository}/actions/runs?status=${status}&per_page=100`);
    for (const run of page.workflow_runs) {
      if (String(run.id) !== String(currentRunId)) {
        runIds.add(run.id);
      }
    }
  }
  const load = { inProgress: 0, staleQueued: 0 };
  for (const runId of runIds) {
    const page = await getJson(`/repos/${repository}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
    for (const job of page.jobs) {
      if (!SELF_HOSTED_RUNNER_LABELS.every((label) => job.labels.includes(label))) {
        continue;
      }
      if (job.status === "in_progress") {
        load.inProgress += 1;
      } else if (job.status === "queued" && now - Date.parse(job.created_at) >= STALE_QUEUE_MS) {
        load.staleQueued += 1;
      }
    }
  }
  return load;
}
