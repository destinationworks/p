#!/usr/bin/env node

// CI entry point for the `select-runner` job in .github/workflows/ci.yml. Writes the chosen
// `runs-on` labels to $GITHUB_OUTPUT. A configuration error exits non-zero; the workflow then runs
// `build-check-test` on the self-hosted fallback, so selection can never skip the required check.

import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { parseRunnerConfig, readSelfHostedLoad, selectRunner } from "./ci-runner-selection.js";

const API_TIMEOUT_MS = 10_000;

function parseRepositoryPrivate(value) {
  if (value === "false") return false;
  if (value === "true") return true;
  return null;
}

function createGetJson({ apiUrl, token, fetchImpl }) {
  return async (path) => {
    const response = await fetchImpl(`${apiUrl}${path}`, {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(API_TIMEOUT_MS),
    });
    if (!response.ok) {
      throw new Error(`GET ${path} returned HTTP ${response.status}`);
    }
    return response.json();
  };
}

/** Runs the selection against `env` and returns the decision after writing workflow outputs. */
export async function runSelection({ env, fetchImpl = fetch, now = Date.now(), log = console.log }) {
  const config = parseRunnerConfig({
    policy: env.CI_HOSTED_RUNNER_POLICY,
    selfHostedSlots: env.CI_SELF_HOSTED_SLOTS,
  });
  const repositoryPrivate = parseRepositoryPrivate(env.REPOSITORY_PRIVATE);
  let load = null;
  if (repositoryPrivate === false && config.policy === "overflow") {
    try {
      load = await readSelfHostedLoad({
        getJson: createGetJson({
          apiUrl: env.GITHUB_API_URL || "https://api.github.com",
          token: env.GITHUB_TOKEN,
          fetchImpl,
        }),
        repository: env.GITHUB_REPOSITORY,
        currentRunId: env.GITHUB_RUN_ID,
        now,
      });
    } catch (error) {
      log(`::warning title=Runner selection::Could not read self-hosted occupancy: ${error.message}`);
    }
  }
  const decision = selectRunner({ repositoryPrivate, ...config, load });
  const labels = JSON.stringify(decision.labels);
  appendFileSync(env.GITHUB_OUTPUT, `labels=${labels}\npool=${decision.pool}\n`);
  if (env.GITHUB_STEP_SUMMARY) {
    appendFileSync(env.GITHUB_STEP_SUMMARY, `build-check-test runs on \`${labels}\`: ${decision.reason}\n`);
  }
  log(`Selected ${decision.pool} ${labels}: ${decision.reason}`);
  return decision;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await runSelection({ env: process.env });
  } catch (error) {
    console.log(`::error title=Runner selection::${error.message}`);
    process.exit(1);
  }
}
