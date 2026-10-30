"""systemd --user control for the Linux indexing tray (stop / start / restart toggle).

Pure decision functions plus a small monitor that keeps the last known state in memory.
Every systemctl call can block, so the GTK thread only ever reads the cache: probes and
operations run on worker threads.
"""

from __future__ import annotations

import collections
import os
import subprocess
import threading
import time
from pathlib import Path

SERVICE_UNIT = "com.dst.p.code-index.service"
PROBE_TIMEOUT_SECONDS = 2.0
OPERATION_TIMEOUT_SECONDS = 30.0
CACHE_STALE_AFTER_SECONDS = 10.0

STATE_ACTIVE = "active"
STATE_INACTIVE = "inactive"
STATE_UNKNOWN = "unknown"

OP_STOP = "stop"
OP_START = "start"
OP_RESTART = "restart"

ServiceMenuPlan = collections.namedtuple(
    "ServiceMenuPlan", ["toggle_title", "toggle_enabled", "toggle_operation", "controls_enabled"])

_PENDING_TITLES = {
    OP_STOP: "Stopping Indexing Service...",
    OP_START: "Starting Indexing Service...",
    OP_RESTART: "Restarting Indexing Service...",
}


def unit_file_path(config_home: str | None = None) -> Path:
    """Where scripts/install-indexing-service.js writes the user unit."""
    home = config_home or os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
    return Path(home) / "systemd" / "user" / SERVICE_UNIT


def systemctl_command(action: str) -> list[str]:
    return ["systemctl", "--user", action, SERVICE_UNIT]


def state_from_probe(stdout: str | None) -> str:
    """Map `systemctl --user is-active` output to a state (the exit code alone cannot tell
    "stopping" from "stopped", so the printed word decides)."""
    word = (stdout or "").strip()
    if word in ("active", "activating", "reloading"):
        return STATE_ACTIVE
    if word in ("inactive", "failed"):
        return STATE_INACTIVE
    return STATE_UNKNOWN


def plan_service_menu(state: str, unit_installed: bool, pending: str | None) -> ServiceMenuPlan:
    if pending is not None:
        return ServiceMenuPlan(_PENDING_TITLES[pending], False, None, False)
    if state == STATE_ACTIVE:
        return ServiceMenuPlan("Stop Indexing Service", True, OP_STOP, True)
    if state == STATE_INACTIVE and unit_installed:
        return ServiceMenuPlan("Start Indexing Service", True, OP_START, False)
    if state == STATE_INACTIVE:
        return ServiceMenuPlan("Start Indexing Service (not installed)", False, None, False)
    return ServiceMenuPlan("Checking Indexing Service...", False, None, False)


def run_systemctl(command: list[str], timeout: float) -> subprocess.CompletedProcess:
    return subprocess.run(command, capture_output=True, text=True, timeout=timeout, check=False)


def probe_state(runner=run_systemctl) -> str:
    try:
        result = runner(systemctl_command("is-active"), PROBE_TIMEOUT_SECONDS)
    except (OSError, subprocess.SubprocessError):
        return STATE_UNKNOWN
    return state_from_probe(result.stdout)


def run_operation(operation: str, runner=run_systemctl) -> tuple[bool, str]:
    """Returns (ok, message); message is empty on success."""
    try:
        result = runner(systemctl_command(operation), OPERATION_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        return False, f"Could not {operation} the indexing service: systemctl did not finish in time."
    except (OSError, subprocess.SubprocessError):
        return False, f"Could not {operation} the indexing service: systemctl could not be run."
    if result.returncode == 0:
        return True, ""
    detail = (result.stderr or "").strip() or f"systemctl exited with status {result.returncode}."
    return False, f"Could not {operation} the indexing service: {detail}"


def spawn_thread(target) -> None:
    threading.Thread(target=target, daemon=True).start()


class ServiceMonitor:
    """In-memory view of the unit. `plan()` never blocks; refreshes happen on worker threads."""

    def __init__(self, runner=run_systemctl, unit_exists=None, spawn=spawn_thread, clock=time.monotonic):
        self._runner = runner
        self._unit_exists = unit_exists or (lambda: unit_file_path().exists())
        self._spawn = spawn
        self._clock = clock
        self._lock = threading.Lock()
        self.state = STATE_UNKNOWN
        self.unit_installed = False
        self.checked_at: float | None = None
        self.pending: str | None = None
        self._probing = False

    def refresh(self) -> None:
        """Blocking probe: call from a worker thread only."""
        state = probe_state(self._runner)
        installed = bool(self._unit_exists())
        with self._lock:
            self.state, self.unit_installed, self.checked_at = state, installed, self._clock()

    def refresh_async(self) -> None:
        with self._lock:
            if self._probing or self.pending is not None:
                return
            self._probing = True

        def worker() -> None:
            try:
                self.refresh()
            finally:
                with self._lock:
                    self._probing = False

        self._spawn(worker)

    def operate_async(self, operation: str, on_done=None) -> bool:
        with self._lock:
            if self.pending is not None:
                return False
            self.pending = operation

        def worker() -> None:
            ok, message = run_operation(operation, self._runner)
            self.refresh()
            with self._lock:
                self.pending = None
            if on_done is not None:
                on_done(ok, message)

        self._spawn(worker)
        return True

    def plan(self) -> ServiceMenuPlan:
        with self._lock:
            return plan_service_menu(self.state, self.unit_installed, self.pending)

    def is_stale(self) -> bool:
        with self._lock:
            return self.checked_at is not None and self._clock() - self.checked_at > CACHE_STALE_AFTER_SECONDS
