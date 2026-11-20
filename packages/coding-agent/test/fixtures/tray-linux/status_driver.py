"""Test-only driver for the pure Linux tray status logic in packages/code-index/indexing_tray_status.py.

Usage: python3 -I -B status_driver.py <code-index dir>
Reads a JSON array of requests on stdin and writes a JSON array of results on stdout.
"""

import json
import sys

sys.path.insert(0, sys.argv[1])

import indexing_tray_status as status  # noqa: E402


def handle(request: dict):
    kind = request.get("kind")
    if kind == "statusLine":
        return status.status_line(request["status"], request["serviceState"], request.get("stale", False))
    if kind == "repoState":
        return status.repo_state_description(request["repo"], request["daemonRunning"])
    if kind == "tooltip":
        return status.tooltip_text(request["status"], request["serviceState"])
    return f"unknown request kind: {kind}"


json.dump([handle(request) for request in json.load(sys.stdin)], sys.stdout)
