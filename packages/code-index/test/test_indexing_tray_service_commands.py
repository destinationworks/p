"""Decision logic and systemctl commands behind the Linux tray's Stop/Start toggle."""
import os
import subprocess
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import indexing_tray_service as svc  # noqa: E402

UNIT = "com.dst.p.code-index.service"


def fake_runner(returncode=0, stdout="", stderr="", raises=None):
    """Returns (runner, calls); calls records every (command, timeout) the runner received."""
    calls = []

    def runner(command, timeout):
        calls.append((command, timeout))
        if raises is not None:
            raise raises
        return subprocess.CompletedProcess(command, returncode, stdout, stderr)

    return runner, calls


class IndexingTrayServiceCommandsTest(unittest.TestCase):
    def test_unit_file_path_honours_config_home_like_the_installer(self):
        self.assertEqual(
            str(svc.unit_file_path("/cfg")), "/cfg/systemd/user/" + UNIT)

    def test_unit_file_path_falls_back_to_xdg_then_home(self):
        old = os.environ.get("XDG_CONFIG_HOME")
        try:
            os.environ["XDG_CONFIG_HOME"] = "/xdg"
            self.assertEqual(str(svc.unit_file_path()), "/xdg/systemd/user/" + UNIT)
            del os.environ["XDG_CONFIG_HOME"]
            self.assertTrue(str(svc.unit_file_path()).endswith("/.config/systemd/user/" + UNIT))
        finally:
            if old is not None:
                os.environ["XDG_CONFIG_HOME"] = old

    def test_systemctl_commands_target_the_user_manager_and_installer_unit(self):
        for action in ("is-active", "stop", "start", "restart"):
            self.assertEqual(svc.systemctl_command(action), ["systemctl", "--user", action, UNIT])

    def test_probe_output_maps_to_states(self):
        for word in ("active", "activating", "reloading", "active\n"):
            self.assertEqual(svc.state_from_probe(word), svc.STATE_ACTIVE, word)
        for word in ("inactive", "failed", "inactive\n"):
            self.assertEqual(svc.state_from_probe(word), svc.STATE_INACTIVE, word)
        for word in ("deactivating", "", None, "garbage"):
            self.assertEqual(svc.state_from_probe(word), svc.STATE_UNKNOWN, repr(word))

    def test_active_service_offers_stop_and_enables_controls(self):
        plan = svc.plan_service_menu(svc.STATE_ACTIVE, True, None)
        self.assertEqual(plan, svc.ServiceMenuPlan("Stop Indexing Service", True, svc.OP_STOP, True))

    def test_active_service_without_unit_file_still_offers_stop(self):
        plan = svc.plan_service_menu(svc.STATE_ACTIVE, False, None)
        self.assertEqual((plan.toggle_operation, plan.toggle_enabled), (svc.OP_STOP, True))

    def test_inactive_service_offers_start_and_disables_controls(self):
        plan = svc.plan_service_menu(svc.STATE_INACTIVE, True, None)
        self.assertEqual(plan, svc.ServiceMenuPlan("Start Indexing Service", True, svc.OP_START, False))

    def test_inactive_service_without_unit_file_cannot_be_started(self):
        plan = svc.plan_service_menu(svc.STATE_INACTIVE, False, None)
        self.assertEqual(
            plan, svc.ServiceMenuPlan("Start Indexing Service (not installed)", False, None, False))

    def test_unknown_state_exposes_no_action(self):
        plan = svc.plan_service_menu(svc.STATE_UNKNOWN, True, None)
        self.assertEqual(plan, svc.ServiceMenuPlan("Checking Indexing Service...", False, None, False))

    def test_pending_operation_locks_everything_regardless_of_state(self):
        titles = {
            svc.OP_STOP: "Stopping Indexing Service...",
            svc.OP_START: "Starting Indexing Service...",
            svc.OP_RESTART: "Restarting Indexing Service...",
        }
        for operation, title in titles.items():
            for state in (svc.STATE_ACTIVE, svc.STATE_INACTIVE, svc.STATE_UNKNOWN):
                plan = svc.plan_service_menu(state, True, operation)
                self.assertEqual(plan, svc.ServiceMenuPlan(title, False, None, False))

    def test_probe_state_runs_is_active_with_a_short_timeout(self):
        runner, calls = fake_runner(returncode=3, stdout="inactive\n")
        self.assertEqual(svc.probe_state(runner), svc.STATE_INACTIVE)
        self.assertEqual(calls, [(["systemctl", "--user", "is-active", UNIT], svc.PROBE_TIMEOUT_SECONDS)])
        self.assertLessEqual(svc.PROBE_TIMEOUT_SECONDS, 2.0)

    def test_probe_state_is_unknown_on_timeout_or_missing_systemctl(self):
        for error in (subprocess.TimeoutExpired("systemctl", 2), FileNotFoundError("systemctl")):
            runner, _ = fake_runner(raises=error)
            self.assertEqual(svc.probe_state(runner), svc.STATE_UNKNOWN)

    def test_run_operation_succeeds_on_zero_exit(self):
        runner, calls = fake_runner()
        self.assertEqual(svc.run_operation(svc.OP_STOP, runner), (True, ""))
        self.assertEqual(calls, [(["systemctl", "--user", "stop", UNIT], svc.OPERATION_TIMEOUT_SECONDS)])

    def test_run_operation_reports_systemctl_stderr(self):
        runner, _ = fake_runner(returncode=1, stderr="Unit not found.\n")
        self.assertEqual(
            svc.run_operation(svc.OP_START, runner), (False, "Could not start the indexing service: Unit not found."))

    def test_run_operation_falls_back_to_exit_status_timeout_and_spawn_failure(self):
        runner, _ = fake_runner(returncode=4)
        self.assertEqual(
            svc.run_operation(svc.OP_RESTART, runner),
            (False, "Could not restart the indexing service: systemctl exited with status 4."))
        runner, _ = fake_runner(raises=subprocess.TimeoutExpired("systemctl", 30))
        self.assertEqual(
            svc.run_operation(svc.OP_STOP, runner),
            (False, "Could not stop the indexing service: systemctl did not finish in time."))
        runner, _ = fake_runner(raises=OSError("boom"))
        self.assertEqual(
            svc.run_operation(svc.OP_STOP, runner),
            (False, "Could not stop the indexing service: systemctl could not be run."))


if __name__ == "__main__":
    unittest.main()
