# 2026-10-31 — Stopping the indexing service also stops the tray that would restart it

- **Status:** Partial
- **Task/context:** Adding "Stop Indexing Service" / "Start Indexing Service" to the menu-bar and system-tray menus.
- **Unexpected observation or failure:** The tray is not an independent app. The daemon spawns it (`IndexingTrayManager.start()` in `do_start`, `do_reconcile`, and the registry watcher) and `do_stop` calls `trayManager.stop()`, which sends the tray `SIGTERM`. A naive `launchctl bootout` from the tray therefore removes the very menu that offers "Start".
- **Evidence:** Source reading: `indexing-daemon/indexingdaemon-methods/lifecycle.ts` (`do_stop` calls `self.trayManager.stop()` before draining), `indexing-tray-manager.ts` (`stop()` sends `SIGTERM` to the spawned child). Not reproduced against the live service because the session must not stop it.
- **Approaches tried:**
  - **Attempt:** On macOS, ignore `SIGTERM` in the tray for the duration of the `bootout` (`signal(SIGTERM, SIG_IGN)`, restored afterwards), and wait until `launchctl print` reports the job gone.
    - **Outcome:** Worked in design; not exercised against launchd
    - **Why:** The tray is spawned `detached: true` (so it calls `setsid`), and launchd is documented to clean up only the job's process group (`AbandonProcessGroup` defaults to false), so the expected only signal is the daemon's own `SIGTERM`. This launchd behaviour was not verified here. The ignored disposition is inherited by `launchctl`, so the timeout path kills it with `SIGKILL`. A later daemon start spawns a second tray, which exits at the single-instance lock, so the surviving tray keeps serving. The daemon respawns that no-op tray at each five-minute reconcile.
  - **Attempt:** On Linux, do the same.
    - **Outcome:** Rejected
    - **Why:** The tray is in the systemd unit's cgroup, which systemd kills as a whole (`KillMode=control-group`), and a tray that ignored `SIGTERM` would stall the stop until `TimeoutStopSec`. Surviving needs the tray to live outside the unit (for example `systemd-run --user --scope` in `resolveTrayCommand`), which could not be tested on this macOS host.
- **Root cause:** Ownership inversion: the controlled service owns the controller's process.
- **Resolution:** macOS uses the `SIGTERM` shield above. Linux Stop leaves no tray; the documented way back is `systemctl --user start com.dst.p.code-index.service`.
- **Verification:** The Swift sources compile; the decision logic is tested through a compiled harness. The live bootout/bootstrap round trip was not run.
- **Prevention/follow-up:** Verify on a real macOS session that the tray remains after Stop and that Start works. Linux: launch the tray outside the unit's cgroup, then drop the limitation from `docs/code-indexing.md`. Longer term, let the tray be a separate LaunchAgent so the daemon does not own it.
- **Reusable learning:** Before adding a "stop this service" control to a UI, check who owns the UI's process and what the service's shutdown does to it.
- **References:** `packages/coding-agent/src/tray/macos/service_control.swift`, `packages/coding-agent/src/core/indexing-daemon/indexingdaemon-methods/lifecycle.ts`, `packages/code-index/indexing_tray_service.py`
