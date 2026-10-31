"""Status text, repo descriptions and registry updates for the Linux tray."""
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import indexing_tray_status as st  # noqa: E402
from indexing_tray_service import STATE_ACTIVE, STATE_INACTIVE, STATE_UNKNOWN  # noqa: E402


def status(running=True, state="ready", progress=None):
    repo = {"path": "/work/alpha", "state": state, "indexedFiles": 7}
    if progress is not None:
        repo["progress"] = progress
    return {"running": running, "repos": [repo]}


class IndexingTrayStatusTest(unittest.TestCase):
    def test_inactive_unit_overrides_a_stale_running_status_file(self):
        data = status(running=True, state="indexing", progress={"percent": 42})
        self.assertFalse(st.is_daemon_running(data, STATE_INACTIVE))
        self.assertEqual(st.status_line(data, STATE_INACTIVE), "  Status: Stopped")

    def test_active_unit_with_a_dead_daemon_is_starting(self):
        self.assertEqual(st.status_line(status(running=False), STATE_ACTIVE), "  Status: Starting...")

    def test_unknown_unit_state_trusts_the_status_file(self):
        self.assertTrue(st.is_daemon_running(status(), STATE_UNKNOWN))
        self.assertEqual(st.status_line(status(), STATE_UNKNOWN), "  Status: Ready (Idle)")
        self.assertEqual(st.status_line(status(running=False), STATE_UNKNOWN), "  Status: Stopped")

    def test_indexing_progress_and_stale_marker(self):
        data = status(state="indexing", progress={"percent": 42.9})
        self.assertEqual(st.status_line(data, STATE_ACTIVE), "  Status: Indexing alpha (42%)")
        self.assertEqual(
            st.status_line(status(state="indexing"), STATE_ACTIVE, stale=True),
            "  Status: Indexing alpha (refreshing...)")

    def test_repo_descriptions(self):
        repo = {"state": "indexing", "indexedFiles": 7}
        self.assertEqual(st.repo_state_description(repo, False), "Stopped (7 files)")
        self.assertEqual(st.repo_state_description(repo, True), "Indexing")
        self.assertEqual(st.repo_state_description({"state": "error"}, True), "Error")
        self.assertEqual(st.repo_state_description({"state": "ready", "indexedFiles": 3}, True), "Ready (3 files)")

    def test_read_json_file_tolerates_missing_invalid_and_non_object(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "x.json"
            self.assertEqual(st.read_json_file(path), {})
            path.write_text("{ nope", encoding="utf-8")
            self.assertEqual(st.read_json_file(path), {})
            path.write_text("[1]", encoding="utf-8")
            self.assertEqual(st.read_json_file(path), {})
            path.write_text('{"a": 1}', encoding="utf-8")
            self.assertEqual(st.read_json_file(path), {"a": 1})

    def test_request_priority_marks_only_the_target_repo(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = Path(tmp) / "indexed-repos.json"
            registry.write_text(json.dumps({"repos": [{"path": "/a"}, {"path": "/b"}]}), encoding="utf-8")
            st.request_priority(registry, "/b")
            repos = json.loads(registry.read_text(encoding="utf-8"))["repos"]
            self.assertNotIn("priorityRequest", repos[0])
            self.assertIn("requestedAt", repos[1]["priorityRequest"])
            self.assertEqual(os.listdir(tmp), ["indexed-repos.json"])

    def test_request_priority_ignores_missing_registry_unknown_repo_and_bad_shape(self):
        with tempfile.TemporaryDirectory() as tmp:
            registry = Path(tmp) / "indexed-repos.json"
            st.request_priority(registry, "/a")
            self.assertFalse(registry.exists())
            registry.write_text(json.dumps({"repos": "nope"}), encoding="utf-8")
            st.request_priority(registry, "/a")
            registry.write_text(json.dumps({"repos": [{"path": "/a"}]}), encoding="utf-8")
            st.request_priority(registry, "")
            st.request_priority(registry, "/zzz")
            self.assertNotIn("priorityRequest", json.loads(registry.read_text(encoding="utf-8"))["repos"][0])


if __name__ == "__main__":
    unittest.main()
