# 2026-10-12 — Autocomplete visual snapshot race

- **Status:** Resolved
- **Task/context:** Full non-e2e suite for the dependency-security PR in an isolated P worktree.
- **Unexpected observation or failure:** The editor snapshot showed `/model` without its suggestions in the full suite, while the focused test passed.
- **Evidence:** `interactive-ui-regression.test.ts` failed in the full suite on the missing `→ model Select model` suggestion; the same four focused tests passed. The harness captured the viewport after a fixed 50 ms flush.
- **Approaches tried:**
  - **Attempt:** Rerun the focused test and full suite without changing the harness.
    - **Outcome:** Did not work.
    - **Why:** The fixed delay did not synchronize the asynchronous autocomplete request under full-suite load.
  - **Attempt:** Await `defaultEditor.autocompleteRequestTask` after input, then flush rendering.
    - **Outcome:** Worked in the focused regression.
    - **Why:** The assertion now observes completion of the actual feature work it tests.
- **Root cause:** The snapshot harness treated elapsed time as a completion signal for asynchronous autocomplete.
- **Resolution:** `typeText` awaits the editor's autocomplete request task before capturing the viewport.
- **Verification:** The focused `interactive-ui-regression.test.ts` suite passed 4/4 after the change; full-suite verification remains a delivery gate.
- **Prevention/follow-up:** The test guidance in `AGENTS.md` now requires awaiting an explicit completion signal for asynchronous visual states.
- **Reusable learning:** A sleep can make UI snapshots intermittently pass, but it cannot prove async feature completion.
- **References:** `packages/coding-agent/test/helpers/ui-visual-snapshot-harness.ts`; `packages/coding-agent/test/interactive-ui-regression.test.ts`.
