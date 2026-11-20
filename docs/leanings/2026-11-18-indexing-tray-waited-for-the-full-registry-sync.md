# 2026-11-18 — The indexing tray waited for the full registry sync

- **Status:** Resolved
- **Task/context:** Live verification of the macOS tray's own launchd job (see [2026-11-18-tray-inherited-launchd-throttle-of-indexing-daemon.md](2026-11-18-tray-inherited-launchd-throttle-of-indexing-daemon.md)) after restarting the indexing daemon.
- **Unexpected observation or failure:** The menu-bar item disappeared at the restart and came back about 7 minutes later. The launchd change was not the cause: the ordering predates it.
- **Evidence:** `do_start` in `packages/coding-agent/src/core/indexing-daemon/indexingdaemon-methods/lifecycle.ts` called `trayManager.start()` only after `await self.syncRegistry()`, while `do_stop` stops the old tray first thing. Under load that sync (Qdrant startup plus every repository's `initialize`) took about 7 minutes. The new regression with a deferred sync observed zero `start()` calls while the sync was pending.
- **Approaches tried:**
  - **Attempt:** Start the tray right after the daemon lock is acquired, inside the startup `try`.
    - **Outcome:** Worked
    - **Why:** Both trays render from cached state only. Before the new daemon's first status write they read "Starting...", so nothing needs the sync to finish. Inside the `try`, a startup failure still reaches `stop()`, which stops the tray.
  - **Attempt:** Start the tray before acquiring the lock.
    - **Outcome:** Rejected
    - **Why:** A second daemon that loses the lock would start (Linux: spawn another) tray for a daemon it does not own. The lock failure path does not call `stop()`, which also keeps it from stopping the running daemon's tray.
- **Root cause:** User-visible status was ordered behind the slowest startup step even though it does not depend on it.
- **Resolution:** `do_start` starts the tray immediately after `acquireDaemonLock`, before Qdrant maintenance and the registry sync.
- **Verification:** Regressions in `packages/coding-agent/test/indexing-tray-daemon-integration.test.ts`: the tray starts while Qdrant maintenance and the registry sync are pending (failed before the fix); a failure in the tray start, Qdrant maintenance or the registry sync stops the tray and releases the lock (the sync case failed before the fix); and a daemon that loses the lock neither starts nor stops the tray. An adversarial mutation pass placed the tray start after the sync, before the lock, outside the `try`, or between maintenance and the sync, and dropped the `stop()` call; each variant fails at least one test.
- **Prevention/follow-up:** None beyond the regressions.
- **Reusable learning:** Start status indicators that render from cached state before slow initialisation, but only after the step that establishes ownership, such as a single-instance lock.
- **References:** `packages/coding-agent/src/core/indexing-daemon/indexingdaemon-methods/lifecycle.ts`, `packages/coding-agent/test/indexing-tray-daemon-integration.test.ts`, `packages/coding-agent/docs/code-indexing.md`.
