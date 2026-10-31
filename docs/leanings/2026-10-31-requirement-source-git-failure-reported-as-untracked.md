# 2026-10-31 — Git failures were reported as untracked requirement sources

- **Status:** Resolved
- **Task/context:** Follow-up to `2026-10-12-certified-benchmark-git-toolchain.md` while merging that benchmark harness fix.
- **Unexpected observation or failure:** In the certified benchmark sandbox, P blocked every write with "Requirement source must be a Git-tracked file: requirements.md" although the file was tracked. The model was steered toward re-adding or untracking a file that was fine.
- **Evidence:** `requirement-source-file.ts` ran `git ls-files --error-unmatch` with stderr discarded and returned `status === 0`. The sandboxed `/usr/bin/git` xcrun shim exited 1 with `xcrun: error: unable to load libxcrun ... (file system sandbox blocked open())`. A workspace that is not a repository (exit 128) or a missing git binary (ENOENT) produced the same "must be a Git-tracked file" text.
- **Approaches tried:**
  - **Attempt:** Treat exit code 1 as "untracked" and anything else as a failure.
    - **Outcome:** Did not work
    - **Why:** The xcrun shim also exits 1, so the exit code alone cannot tell "not tracked" from "git broken".
- **Root cause:** The tracked check conflated "git answered no" with "git could not answer".
- **Resolution:** Only exit 1 with git's `did not match any file(s) known to git` message counts as untracked, and git runs with `LC_ALL=C` so a translated message is still recognized. Every other outcome returns "Cannot verify that requirement source ... is Git-tracked because git failed (...)" with the spawn error, signal, or the first stderr line (200 characters at most).
- **Found in review:** `--error-unmatch` treats the path as a glob pathspec, so an untracked file literally named `*.md` passed as tracked whenever a tracked `a.md` existed (pre-existing). git now also runs with `GIT_LITERAL_PATHSPECS=1`. The failure detail prefers git's `fatal:`/`error:` line over leading trace lines, and is redacted if it matches the secret pattern.
- **Verification:** `packages/coding-agent/test/task-requirement-source-git-failure.test.ts` covers tracked, untracked, non-repository, an xcrun-like shim exiting 1, missing git, a translated untracked message, a glob-like untracked file name (mutation-checked), the exit-1 guard, trace-line precedence, secret redaction, length bounding, and a signal-killed git. The three failure cases failed before the change, and the locale case was mutation-checked by removing `LC_ALL=C`. The existing `task-requirement-audit-source-security.test.ts` untracked assertion still passes.
- **Prevention/follow-up:** None beyond the regression.
- **Reusable learning:** Never map a tool's nonzero exit to a domain verdict without checking that the tool actually produced that verdict; report the tool failure itself.
- **References:** `packages/coding-agent/src/core/task-verification/requirement-source-file.ts`, `docs/leanings/2026-10-12-certified-benchmark-git-toolchain.md`.
