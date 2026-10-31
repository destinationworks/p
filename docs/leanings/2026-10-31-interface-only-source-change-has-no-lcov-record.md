# 2026-10-31 — Changing an interface-only source file fails the changed-line coverage gate

- **Status:** Resolved
- **Task/context:** PR #185 (Shift+Enter new-line notice) added an optional `waitForKeyboardProtocolNegotiation?` member to the `Terminal` interface in `packages/tui/src/terminal/types.ts`.
- **Unexpected observation or failure:** CI "Test with coverage" failed in `scripts/check-changed-coverage.js` with 100% covered changed lines but `Missing LCOV records: packages/tui/src/terminal/types.ts`.
- **Evidence:** The gate requires an LCOV record for every changed `packages/*/src/**/*.ts` file. `packages/tui` coverage runs `node --test --experimental-test-coverage` with `--test-coverage-include=src/**/*.ts`, which only reports files that are loaded at runtime; `types.ts` contains only interfaces and types, which Node's type stripping erases, so no test ever loads it. The coding-agent vitest/v8 run lists every file matching `include`, so an interface-only file there still gets a record. Local reproduction: `npm run test:coverage` in `packages/tui`, then `node scripts/check-changed-coverage.js --base origin/main`.
- **Approaches tried:**
  - **Attempt:** Keep the interface member and add tests.
    - **Outcome:** Did not work.
    - **Why:** No test can make a type-only file load at runtime, and the gate must not be weakened or suppressed.
  - **Attempt:** Revert the interface edit, keep the method on the `ProcessTerminal` class, and detect the optional capability in coding-agent with a structural `NegotiatingTerminal` type and a runtime `canWaitForKeyboardProtocolNegotiation()` guard.
    - **Outcome:** Worked.
    - **Why:** Every changed source file is runtime-loaded, and the guard has direct tests for a present function, an absent member and a non-function member.
- **Root cause:** The local `npm run check` and focused tests do not run the changed-line coverage gate, so the type-only edit was invisible until CI.
- **Resolution:** `types.ts` is unchanged versus `main`; the guard lives in `terminal-newline-hint.ts`.
- **Verification:** `npm run test:coverage` in `packages/tui`, targeted coverage for the changed coding-agent tests, then `node scripts/check-changed-coverage.js --base origin/main`: 88/88 changed lines covered, no missing records.
- **Prevention/follow-up:** Run the coverage gate locally before pushing source changes that touch type-only files; `AGENTS.md` now states the rule. Related: `2026-10-31-shift-enter-hint-needs-settled-keyboard-negotiation.md`.
- **Reusable learning:** Do not edit interface-only or re-export-only source files in `packages/*/src` unless a test loads them at runtime; model optional capabilities structurally in the consumer instead.
- **References:** PR #185, `scripts/check-changed-coverage.js`, `packages/tui/package.json` (`test:coverage`).
