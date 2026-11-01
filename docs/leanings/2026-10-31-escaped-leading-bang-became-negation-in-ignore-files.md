# 2026-10-31 — Escaped leading `\!` became a negation at the root of skill and package ignore files

- **Status:** Resolved
- **Task/context:** Reviewing the helpers that re-root `.gitignore`/`.ignore`/`.fdignore` lines found in skill directories and extension packages before feeding them to the `ignore` npm library (`packages/coding-agent/src/core/skills.ts`, `packages/coding-agent/src/core/package-manager/version-resolution.ts`, `packages/agent/src/harness/skills.ts`).
- **Unexpected observation or failure:** A line `\!bang.md` (gitignore escape for a file literally named `!bang.md`) did not ignore that file when the ignore file sat at the scan root. The same line worked in a nested directory.
- **Evidence:** `prefixIgnorePattern` stripped the backslash unconditionally. With an empty prefix the result was `!bang.md`, which `ignore` 7.0.5 reads as a negation (it matches nothing). With a prefix the result was `sub/!bang.md`, where the `!` is no longer leading and is literal, so only the root case was wrong. Probing the library directly: `\!bang.md` ignores `!bang.md`; `!bang.md` ignores nothing; `sub/\!bang.md` and `sub/!bang.md` both ignore `sub/!bang.md`; `\#hash.md` and `sub/\#hash.md` both ignore `#hash.md`.
- **Approaches tried:**
  - **Attempt:** Keep the backslash only when the prefix is empty and drop it otherwise.
    - **Outcome:** Not needed.
    - **Why:** The library accepts the escape in the middle of a pattern, so keeping it everywhere is correct and simpler than a prefix-dependent branch.
  - **Attempt:** Delete the `else if (startsWith("\\!"))` branch so only an unescaped leading `!` is treated specially.
    - **Outcome:** Worked.
    - **Why:** `\#` was already handled this way (the code only exempts `\#` from the comment check and never strips it), so `\!` now follows the same rule.
- **Root cause:** The escape was removed to "normalize" the line, but the escape is what keeps the leading `!` literal once no prefix is prepended. Two identical private copies in `coding-agent` and a third in `agent` carried the bug, and no test used a root-level `\!` line through a real loader.
- **Resolution:** One shared `prefixIgnorePattern`/`addIgnoreRules` in `packages/coding-agent/src/core/ignore-file-patterns.ts` used by the skill loader and the package manager; the `agent` harness copy (separate package) got the same one-branch fix.
- **Verification:** `test/skills-ignore-escaped-bang.test.ts`, `test/package-manager-ignore-escaped-bang.test.ts`, `test/ignore-file-patterns.test.ts` (coding-agent) and `test/harness/skills-ignore-escaped-bang.test.ts` (agent). With the old branch restored, 12 of 29 coding-agent tests fail (all root-level `\!` cases); with the fix all pass. Negation (`!keep`), `\#`, comments, a slash after `\!`, and trailing-space lines are covered at root and nested levels.
- **Prevention/follow-up:** Open, not fixed here: the directory prefix is prepended unescaped, so a nested ignore file inside a directory whose own name starts with `!` or `#`, or contains `*`, `?` or `[`, is still misread by the matcher (same class of bug, found by adversarial review). Escape the prefix in a separate change with its own regressions. Test ignore-file handling through the real loaders at the scan root and in a nested directory; `resolve()`-level package-manager tests also discover resources from the real home directory, so assert only on paths under the fixture directory.
- **Reusable learning:** When re-rooting gitignore lines, never strip an escape that protects a leading `!` or `#`; the prefix hides the bug in nested directories, so always test the empty-prefix case.
- **References:** `packages/coding-agent/src/core/ignore-file-patterns.ts`, `packages/agent/src/harness/skills.ts`.
