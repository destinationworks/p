# CI runners

The required `build-check-test` job in `.github/workflows/ci.yml` runs either on the self-hosted
Linux pool (`[self-hosted, Linux]`) or on a standard GitHub-hosted runner (`ubuntu-24.04`). A small
`select-runner` job picks one for each run.

## Cost boundary

- `destinationworks/p` is public. GitHub documents standard GitHub-hosted runners as free and
  unlimited in public repositories, and their minutes do not draw on the included quota. The
  billing usage API (`/organizations/{org}/settings/billing/usage`, November 2026) agrees: every
  hosted minute this repository used is fully discounted, and a public repository on a Free
  personal account used about 10,500 hosted Linux minutes against 2,000 included, with a net
  charge of 0.
- The limit that still applies is concurrency: on the Free plan at most 20 standard GitHub-hosted
  jobs run at once across the organization. Extra jobs wait; nothing is billed. Sources:
  [Actions limits](https://docs.github.com/en/actions/reference/limits),
  [GitHub-hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).
- Larger runners are always billed, so selection only ever uses the standard `ubuntu-24.04` label.
- In a private repository hosted minutes would draw on the included quota. `select-runner` (which
  itself runs on a hosted runner) is skipped unless `github.event.repository.private` is `false`,
  and the selection script independently refuses hosted runners unless visibility is known to be
  public. A repository made private therefore returns to self-hosted-only CI without a code change.

## Selection policy

Repository variables (Settings → Secrets and variables → Actions → Variables) control the choice
without a pull request:

| Variable | Values | Default |
| --- | --- | --- |
| `CI_HOSTED_RUNNER_POLICY` | `overflow`: self-hosted first, hosted when the pool is busy. `always`: always hosted. `never`: self-hosted only; `select-runner` is skipped (see below). | `overflow` |
| `CI_SELF_HOSTED_SLOTS` | 1–99: how many of this repository's self-hosted Linux jobs may run before new runs overflow | `2` |

With `overflow`, `select-runner` reads this repository's queued and in-progress workflow runs with
the read-only `GITHUB_TOKEN` (`actions: read`), counts their jobs labelled `self-hosted` and `Linux`
(other self-hosted pools are ignored), and chooses the hosted runner when:

- another such job has been queued for at least 30 seconds (no idle runner), or
- this repository already has `CI_SELF_HOSTED_SLOTS` such jobs in progress.

Limits of this signal:

- The token cannot list runners or see other repositories' jobs, so a pool busy with other
  repositories is detected only once a job here has waited 30 seconds.
- Runs that start within the same few seconds can all pick the self-hosted pool before either job
  appears.
- Only the first 100 runs per status are read; a longer backlog is undercounted, which can only keep
  a job on the self-hosted pool.

## Independent self-hosted CI

Hosted runners are an addition. The full CI run on the self-hosted pool must keep working without
GitHub-hosted capacity:

- `build-check-test` is the same job, with the same steps and check name, on either runner type.
- `CI_HOSTED_RUNNER_POLICY=never` is checked in the `if:` of `select-runner`, so the job is skipped
  before any runner is requested. `build-check-test` then starts on the self-hosted pool at once,
  exactly as before this change, with no dependency on GitHub-hosted runners or the selection
  script. Use it whenever GitHub-hosted runners are unavailable.
- With `overflow` or `always`, `build-check-test` waits for `select-runner`, which needs a
  GitHub-hosted runner. Hosted jobs normally start within seconds, but if GitHub-hosted capacity is
  unavailable (an incident, or all 20 concurrent hosted jobs in use) CI waits until it returns or
  the policy is set to `never`.

## Failure behaviour

- A misspelled variable fails `select-runner` with an error annotation.
- An unreadable occupancy API logs a warning and keeps the self-hosted pool.
- In both cases, and when `select-runner` is skipped, `build-check-test` still runs on the
  self-hosted fallback: its condition uses `!cancelled()`, because a skipped required check would
  report success.

## Runner prerequisites

- Self-hosted runners have no privilege escalation; the administrator preinstalls `ripgrep`.
- GitHub-hosted runners install `ripgrep` with `sudo apt-get` in a step guarded by
  `runner.environment == 'github-hosted'`. No other step may call `sudo`.

## Out of scope

- The release `validate` job in `.github/workflows/build-binaries.yml` stays self-hosted because it
  runs optional local-LLM tests against the runner's Ollama daemon.
- Fork pull requests still skip CI. GitHub-hosted runners are ephemeral and could run them safely,
  but changing that trust gate is a separate decision.
