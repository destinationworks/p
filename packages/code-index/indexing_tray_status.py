"""Status text and registry helpers for the Linux indexing tray (no GTK, no I/O beyond the registry)."""

from __future__ import annotations

import datetime
import json
import os
import uuid
from pathlib import Path

from indexing_tray_service import STATE_ACTIVE, STATE_INACTIVE

# RepositoryServiceStatus.state values the daemon writes while it refreshes a repository.
INDEXING_STATES = frozenset({"initializing", "updating"})


def read_json_file(path: Path) -> dict:
    if not path.exists():
        return {}
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
            return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def is_daemon_running(status_data: dict, service_state: str) -> bool:
    """The status file outlives the daemon, so an inactive unit overrides what it claims."""
    return bool(status_data.get("running", False)) and service_state != STATE_INACTIVE


def is_repo_indexing(repo: dict) -> bool:
    return repo.get("state") in INDEXING_STATES


def indexing_progress_label(repo: dict) -> str | None:
    """Only the indexing phase reports overall progress: "preparing" can reach 100% before any chunk is
    indexed and "finalizing" restarts at 0%, so those phases are named instead of given a percent."""
    progress = repo.get("progress")
    phase = progress.get("phase") if isinstance(progress, dict) else None
    if not isinstance(phase, str):
        return None
    if phase != "indexing":
        return phase
    percent = progress.get("percent")
    return f"{int(percent)}%" if isinstance(percent, (int, float)) else None


def tooltip_text(status_data: dict, service_state: str) -> str:
    if not is_daemon_running(status_data, service_state):
        return "P Code Indexing (Stopped)"
    if any(is_repo_indexing(r) for r in status_data.get("repos", [])):
        return "P Code Indexing (Indexing...)"
    return "P Code Indexing (Idle)"


def status_line(status_data: dict, service_state: str, stale: bool = False) -> str:
    repos = status_data.get("repos", [])
    if service_state == STATE_INACTIVE:
        text = "Stopped"
    elif not is_daemon_running(status_data, service_state):
        text = "Starting..." if service_state == STATE_ACTIVE else "Stopped"
    else:
        active = next((r for r in repos if is_repo_indexing(r)), None)
        if active is None:
            text = "Ready (Idle)"
        else:
            name = Path(active["path"]).name if "path" in active else "repo"
            label = indexing_progress_label(active)
            text = f"Indexing {name}" + (f" ({label})" if label else "")
    return f"  Status: {text}" + (" (refreshing...)" if stale else "")


def repo_state_description(repo: dict, daemon_running: bool) -> str:
    files = repo.get("indexedFiles", 0)
    if not daemon_running:
        return f"Stopped ({files} files)"
    if is_repo_indexing(repo):
        label = indexing_progress_label(repo)
        return "Indexing" + (f" [{label}]" if label else "")
    state = repo.get("state")
    if state == "error":
        return "Error"
    return "Queued" if state == "queued" else f"Ready ({files} files)"


def request_priority(registry_file: Path, repo_path: str) -> None:
    if not repo_path or not registry_file.exists():
        return
    data = read_json_file(registry_file)
    repos = data.get("repos", [])
    if not isinstance(repos, list):
        return
    now = datetime.datetime.now(datetime.timezone.utc).isoformat()
    for repo in repos:
        if isinstance(repo, dict) and repo.get("path") == repo_path:
            repo["priorityRequest"] = {"id": str(uuid.uuid4()), "requestedAt": now}
            break
    temp_file = registry_file.with_suffix(f".{os.getpid()}.tmp")
    try:
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2)
        temp_file.replace(registry_file)
    except Exception:
        pass
