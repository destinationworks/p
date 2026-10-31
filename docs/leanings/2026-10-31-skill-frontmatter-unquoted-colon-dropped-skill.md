# 2026-10-31 — Skill with an unquoted `: ` in its description was dropped by strict YAML

- **Status:** Resolved
- **Task/context:** `p` startup printed a skill-load warning for `~/.agents/skills/onepassword-cli/SKILL.md`; the same shared skills directory loads fine in Claude Code and Codex.
- **Unexpected observation or failure:** `Nested mappings are not allowed in compact mappings at line 2, column 14` for a flat frontmatter whose unquoted `description:` value contains `web app: its editor`. The skill was skipped entirely.
- **Evidence:** `packages/coding-agent/src/utils/frontmatter.ts` passed the whole block to `yaml.parse`, which treats the second `: ` inside a plain scalar as a nested mapping and throws; `loadSkillFromFile` in `src/core/skills.ts` turned the throw into a warning and returned no skill. Regression: `packages/coding-agent/test/skill-frontmatter-plain-scalar-colon.test.ts`.
- **Approaches tried:**
  - **Attempt:** Considered (not implemented): repair every failing frontmatter by quoting values.
    - **Outcome:** Rejected.
    - **Why:** Too broad; it would also mask genuinely broken frontmatter such as unclosed flow sequences and nested blocks, which must keep reporting their YAML error.
  - **Attempt:** Retry strict-failing frontmatter line by line, only when every non-empty, non-comment line is an unindented `key: value` with a unique key and a plain scalar value.
    - **Outcome:** Worked.
    - **Why:** Lines strict YAML still parses keep their YAML type (`disable-model-invocation: true` stays a boolean); only the rejected lines are taken literally after the first `: `. Anything else rethrows the original error.
- **Root cause:** `p` parsed skill and prompt-template frontmatter with strict YAML only, while the other harnesses sharing `~/.agents/skills` accept the common unquoted-description style.
- **Resolution:** `parseFrontmatter` retries with `parseFlatPlainScalarMapping` (`src/utils/frontmatter-plain-scalar-fallback.ts`) when strict parsing throws.
- **Verification:** New regression file (fallback, typing, negatives for nested/indented/list/block-scalar/flow/anchor/tag/duplicate/empty-value input, and skill loading end to end) plus the existing `frontmatter`, `skills` and `prompt-templates` tests.
- **Prevention/follow-up:** `learnings-distiller.ts` still writes `description: ${description}` unquoted; such generated skills now load but are not valid strict YAML for other tools.
- **Reusable learning:** A shared skills directory means the loosest common parser defines what authors write; accept the narrow lenient case, never widen the fallback to structured YAML.
- **References:** `packages/coding-agent/src/utils/frontmatter.ts`, `packages/coding-agent/src/utils/frontmatter-plain-scalar-fallback.ts`.
