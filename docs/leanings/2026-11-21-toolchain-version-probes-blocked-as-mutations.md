# 2026-11-21 — Toolchain version probes were blocked as mutations before the checklist

- **Status:** Resolved
- **Task/context:** Reviewing the newest `p` session (2026-11-18, strict verification tier, local `qwen3.8-27b` behind the LAN orchestrator) for harness defects.
- **Unexpected observation or failure:** The model's first call was `pwd && ls -la && node --version && npm --version`. The evidence gate rejected it with "Cannot perform this mutation: record one completion checklist ... before the first matching mutation". The model then had to spend a separate turn re-running the identical probe after recording the checklist.
- **Evidence:** Session JSONL line 11 (`bash` tool result `isError: true` with the checklist message) and line 23 (the same command re-issued at 21:11:56Z, 78 output tokens over ~23k prompt tokens on a ~20 tok/s local model).
- **Approaches tried:**
  - **Attempt:** Check `BASH_MUTATION_PATTERN` and `WRITE_REDIRECT_PATTERN`.
    - **Outcome:** Did not explain it
    - **Why:** Neither matches the command. The block came from `canPotentiallyChangeWorkspace`, which treats every shell command outside the read-only discovery allowlist as a `workspace_write` effect.
  - **Attempt:** Allow single-argument version probes for a fixed toolchain list in the discovery-only classifier.
    - **Outcome:** Worked
    - **Why:** `node --version` and peers print a version and exit; the narrow project-rule trust allowlist stays unchanged.
- **Root cause:** `read-only-shell-command-classification.ts` knew `pwd`, `ls`, `which` and git discovery commands but no toolchain version probes, so one unknown word made the whole `&&` chain a potential mutation.
- **Resolution:** `DISCOVERY_VERSION_PROBE_FLAGS` accepts `<tool> <flag>` with exactly one argument for node, npm, npx, bun, deno, python, python3, pip, pip3, uv, go (`go version`), git and tsc. Short flags are listed only where they mean "version" (`python -v` is verbose and stays rejected; `go version -m` and `npm version` stay rejected). An adversarial review pointed out that yarn (`.yarnrc.yml` yarnPath), pnpm (packageManager self-switching), cargo and rustc (rust-toolchain.toml path toolchains) let the workspace choose which program `--version` runs, so they stay gated.
- **Verification:** `test/task-verification-read-only-shell-discovery.test.ts` adds the exact run command and a per-tool table that pins every accepted and rejected probe flag; the run command failed before the change and passes after it. Mutants that add `git -v`, re-add yarn, or drop the discovery guard each fail the suite. Related gate and classifier suites pass.
- **Prevention/follow-up:** When a strict-tier run shows a blocked read-only command, add the exact command to the "commands a model ran and was blocked on before the checklist" table first.
- **Reusable learning:** Open-weights models usually open with an environment probe chain. Every word in that chain must be a recognized read-only command, or the whole chain is gated as a mutation and costs a model turn.
- **References:** `packages/coding-agent/src/core/task-verification/read-only-shell-command-classification.ts`, `packages/coding-agent/docs/usage.md` (evidence mode section).
