"""ServiceMonitor keeps systemctl off the GTK thread: plan() reads the cache, workers do the I/O."""
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import indexing_tray_service as svc  # noqa: E402


def make_monitor(states=("active",), op_returncode=0, op_stderr="", clock=lambda: 100.0):
    """Monitor with a scripted systemctl and a deferred spawner; returns (monitor, calls, queue)."""
    calls, queue, probe_answers = [], [], list(states)

    def runner(command, timeout):
        calls.append(command[2])
        if command[2] == "is-active":
            word = probe_answers.pop(0) if len(probe_answers) > 1 else probe_answers[0]
            return subprocess.CompletedProcess(command, 0 if word == "active" else 3, word + "\n", "")
        return subprocess.CompletedProcess(command, op_returncode, "", op_stderr)

    monitor = svc.ServiceMonitor(runner=runner, unit_exists=lambda: True, spawn=queue.append, clock=clock)
    return monitor, calls, queue


class IndexingTrayServiceMonitorTest(unittest.TestCase):
    def test_plan_reads_the_cache_and_never_calls_systemctl(self):
        monitor, calls, _ = make_monitor()
        self.assertEqual(monitor.plan().toggle_title, "Checking Indexing Service...")
        monitor.refresh()
        calls.clear()
        for _ in range(5):
            self.assertEqual(monitor.plan().toggle_operation, svc.OP_STOP)
        self.assertEqual(calls, [])

    def test_refresh_async_defers_the_probe_to_the_worker_and_coalesces(self):
        monitor, calls, queue = make_monitor()
        monitor.refresh_async()
        monitor.refresh_async()
        self.assertEqual((len(queue), calls), (1, []))
        queue.pop()()
        self.assertEqual(calls, ["is-active"])
        self.assertEqual(monitor.state, svc.STATE_ACTIVE)
        monitor.refresh_async()
        self.assertEqual(len(queue), 1)

    def test_stop_locks_the_menu_until_done_then_reports_the_new_state(self):
        monitor, calls, queue = make_monitor(states=("active", "inactive"))
        monitor.refresh()
        results = []
        self.assertTrue(monitor.operate_async(svc.OP_STOP, lambda ok, msg: results.append((ok, msg))))
        self.assertEqual(monitor.plan().toggle_title, "Stopping Indexing Service...")
        self.assertEqual(calls, ["is-active"])
        queue.pop()()
        self.assertEqual(calls, ["is-active", "stop", "is-active"])
        plan = monitor.plan()
        self.assertEqual((plan.toggle_title, plan.toggle_operation, plan.controls_enabled),
                         ("Start Indexing Service", svc.OP_START, False))
        self.assertEqual(results, [(True, "")])

    def test_second_operation_is_rejected_while_one_is_pending(self):
        monitor, calls, queue = make_monitor()
        self.assertTrue(monitor.operate_async(svc.OP_STOP))
        self.assertFalse(monitor.operate_async(svc.OP_START))
        self.assertEqual(len(queue), 1)
        queue.pop()()
        self.assertEqual(calls.count("start"), 0)

    def test_failed_operation_unlocks_the_menu_and_reports_the_error(self):
        monitor, _, queue = make_monitor(states=("active",), op_returncode=1, op_stderr="Access denied")
        results = []
        monitor.operate_async(svc.OP_STOP, lambda ok, msg: results.append((ok, msg)))
        queue.pop()()
        self.assertEqual(results, [(False, "Could not stop the indexing service: Access denied")])
        self.assertIsNone(monitor.pending)
        self.assertEqual(monitor.plan().toggle_operation, svc.OP_STOP)

    def test_background_probes_pause_while_an_operation_is_pending(self):
        monitor, _, queue = make_monitor()
        monitor.operate_async(svc.OP_RESTART)
        monitor.refresh_async()
        self.assertEqual(len(queue), 1)

    def test_cache_goes_stale_after_ten_seconds_but_not_before_the_first_probe(self):
        now = [100.0]
        monitor, _, _ = make_monitor(clock=lambda: now[0])
        self.assertFalse(monitor.is_stale())
        monitor.refresh()
        now[0] = 109.9
        self.assertFalse(monitor.is_stale())
        now[0] = 110.1
        self.assertTrue(monitor.is_stale())

    def test_missing_unit_file_disables_start(self):
        monitor, _, _ = make_monitor(states=("inactive",))
        monitor._unit_exists = lambda: False
        monitor.refresh()
        plan = monitor.plan()
        self.assertEqual((plan.toggle_title, plan.toggle_enabled), ("Start Indexing Service (not installed)", False))


if __name__ == "__main__":
    unittest.main()
