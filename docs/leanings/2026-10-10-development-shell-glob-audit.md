# 2026-10-10 — Development shell wrapper retained the vulnerable glob chain

- **Status:** Resolved
- **Task/context:** Close the remaining full npm audit findings after the production glob migration.
- **Unexpected observation or failure:** The production audit was clean, but the full audit still reported five high findings.
- **Evidence:** The root and coding-agent manifests pinned `shx@0.4.0`; the lockfile traced it through `shelljs@0.9.2`, `fast-glob@3.3.3`, `micromatch@4.0.8`, and `braces@3.0.3`. The old scripts used only remove, mkdir, copy, and chmod operations.
- **Approaches tried:**
  - **Attempt:** Replace the shell wrapper with a Node filesystem helper and remove its two direct pins.
    - **Outcome:** Worked.
    - **Why:** The scripts need a fixed set of file operations and suffix matches, so no glob or shell parser dependency is needed.
- **Root cause:** Development package scripts retained a shell-command wrapper whose transitive glob engine carried the advisory chain.
- **Resolution:** Use explicit native file operations for package cleanup, coverage setup, executable bits, and build asset copies; refresh the root lockfile.
- **Verification:** Focused fixture tests cover cleanup scope, copied layouts, overwrite behavior, missing files, and executable bits; `npm audit --json --audit-level=low` reports zero advisories after the lockfile refresh.
- **Release-note trap:** The first `None` fragment used a `summary` and named `code-index` directly. Current fragment parsing rejected it: new `None` fragments need a concrete `reason`, and code-index paths map to the `coding-agent` changelog package. Parsing the actual new fragment caught this gap; release-fragment unit tests alone did not.
- **Prevention/follow-up:** Keep workspace file operations in the tested helper and review future dependency additions against the full audit. The repository rule is in `AGENTS.md`.
- **Reusable learning:** A clean production audit can coexist with vulnerable development tooling; inspect and close the full dependency graph separately.
- **References:** `scripts/workspace-file-operations.js`, `scripts/workspace-file-operations.test.js`, `docs/leanings/2026-10-10-production-glob-audit.md`.
