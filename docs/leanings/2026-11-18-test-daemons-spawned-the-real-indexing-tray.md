# 2026-11-18 — Test and library daemons spawned the real indexing tray

- **Status:** Resolved
- **Task/context:** Moving the macOS tray into its own launchd job (see [2026-11-18-tray-inherited-launchd-throttle-of-indexing-daemon.md](2026-11-18-tray-inherited-launchd-throttle-of-indexing-daemon.md)).
- **Unexpected observation or failure:** `IndexingDaemon` defaulted to a real `IndexingTrayManager`. Nine test files construct a daemon without injecting a tray, and `do_start` calls `trayManager.start()`. On macOS, `resolveTrayCommand` falls back to the source tree's `packages/coding-agent/dist/bin/p-indexing-tray`, so in any built checkout those tests launched real menu-bar trays for temporary agent directories. After the launchd change they would also have created real launchd jobs.
- **Evidence:** `git grep "new IndexingDaemon(" -- test` lists 9 files, and only one of them passes `trayManager`. A built checkout contains `dist/bin/p-indexing-tray`. The new regression in `indexing-tray-daemon-integration.test.ts` failed before the fix: `start()` returned `true` for a daemon that had no tray manager injected.
- **Approaches tried:**
  - **Attempt:** Regression with an empty stand-in binary.
    - **Outcome:** Did not work
    - **Why:** Node's `spawn` throws `ENOEXEC` synchronously for an empty executable, so `start()` returned `false` and the test passed against the buggy code. The stand-in is now a runnable `#!/bin/sh` script.
  - **Attempt:** Default the daemon to `NO_INDEXING_TRAY` and inject the real manager only in `runIndexingService`.
    - **Outcome:** Worked
    - **Why:** Production wiring is explicit, and every other construction shows no tray.
- **Root cause:** A side-effecting collaborator defaulted to its real implementation in a class that tests construct directly.
- **Resolution:** `IndexingDaemonOptions.trayManager` defaults to `NO_INDEXING_TRAY`. `src/indexing-service-daemon.ts` passes `new IndexingTrayManager({ agentDir })`.
- **Verification:** The regression above passes. `indexing-runtime-startup.test.ts` asserts that the service entry point passes an `IndexingTrayManager`.
- **Prevention/follow-up:** None beyond the regression.
- **Reusable learning:** A collaborator that launches processes or touches launchd or systemd belongs in the production entry point, not in a class default. A stand-in executable in a test must actually run, or the spawn fails before the code under test does.
- **References:** `packages/coding-agent/src/core/indexing-daemon/indexingdaemon.ts`, `packages/coding-agent/src/indexing-service-daemon.ts`, `packages/coding-agent/test/indexing-tray-daemon-integration.test.ts`.
