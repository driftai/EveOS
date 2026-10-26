#!/usr/bin/env python3
"""Deterministic contract checks for EveOS Local MoE lifecycle ownership."""

from __future__ import annotations

import ast
import os
import sys
import tempfile
import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import eveos_control_helper, local_moe_control  # noqa: E402


def require(condition: bool, message: str) -> None:
    if not condition:
        raise AssertionError(message)


def load_harness_config(path: Path) -> ModuleType:
    spec = importlib.util.spec_from_file_location("eveos_local_moe_harness_config", path)
    if spec is None or spec.loader is None:
        raise ImportError(f"Unable to load Local MoE config: {path}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeProcess:
    def __init__(self, command, **kwargs):
        self.command = command
        self.kwargs = kwargs
        self.pid = 42420

    def poll(self):
        return None


def check_config_ports() -> None:
    module = load_harness_config(ROOT / "tools" / "Local-MoE-Harness" / "app" / "config.py")
    with patch.dict(os.environ, {"LOCAL_MOE_HARNESS_PORT": "15180", "FREETOKEN_PORT": "11919"}):
        settings = module.load_settings()
    require(settings["harness_port"] == 15180, "Harness ignored the EveOS port environment")
    require(settings["runtime_base_url"] == "http://127.0.0.1:11919", "Runtime ignored EveOS port environment")


def check_runtime_status_endpoint_is_lightweight() -> None:
    source = (ROOT / "tools" / "Local-MoE-Harness" / "app" / "services" / "runtime_status.py").read_text(
        encoding="utf-8"
    )
    tree = ast.parse(source)
    function = next(
        (
            node
            for node in tree.body
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef))
            and node.name == "lightweight_runtime_status"
        ),
        None,
    )
    require(function is not None, "Harness is missing the lightweight runtime status endpoint")
    calls = {
        node.func.attr if isinstance(node.func, ast.Attribute) else node.func.id
        for node in ast.walk(function)
        if isinstance(node, ast.Call)
        and isinstance(node.func, (ast.Attribute, ast.Name))
    }
    require("system_snapshot" not in calls, "Runtime status still performs system storage scans")
    require("public_models" not in calls, "Runtime status still scans every model location")
    require("status" not in calls and "lifecycle_status" in calls,
            "Runtime status still uses the full two-request adapter probe")


def check_live_details_uses_lightweight_runtime_status() -> None:
    calls = []

    def fake_http(port, path, **kwargs):
        calls.append((port, path, kwargs))
        return {
            "runtime": {"ready": False, "reachable": True, "health_status": "loading"},
            "runtime_lifecycle": {
                "managed_running": True,
                "startup_stage": "loading_weights",
                "last_error": None,
            },
            "active_model": {
                "id": "qwen36-nvfp4",
                "display_name": "Qwen",
                "validation": "validated",
            },
            "settings": {
                "active_model_id": "qwen36-nvfp4",
                "active_profile_label": "Fast 8K",
            },
        }

    details = local_moe_control.local_moe_runtime_bootstrap.live_details(fake_http, 5180)
    require(calls == [(5180, "/api/runtime/status", {"timeout": 4.5})],
            "Local Control still uses the heavyweight Harness status endpoint")
    require(details["runtimeManagedRunning"] is True
            and details["runtimeStartupStage"] == "loading_weights",
            "Lightweight lifecycle status was not projected correctly")
    require(details["activeModel"]["label"] == "Qwen",
            "Lightweight active-model metadata was not projected correctly")


def check_status_is_passive() -> None:
    local_moe_control._STATUS_GRACE.clear()
    with patch.object(local_moe_control, "_harness_health", return_value=None), \
            patch.object(local_moe_control, "_port_open", return_value=False), \
            patch.object(local_moe_control, "_managed_harness_pid", return_value=None), \
            patch.object(local_moe_control, "_managed_runtime_pid", return_value=None), \
            patch.object(local_moe_control, "_setup_ready", return_value=True), \
            patch.object(local_moe_control.subprocess, "Popen") as popen:
        status = local_moe_control.get_status()
    require(status["state"] == "stopped", "Passive status did not report stopped")
    require(status["explicitStartRequired"] is True, "Explicit-start contract is missing")
    popen.assert_not_called()


def check_healthy_status_skips_slow_windows_ownership_lookup() -> None:
    health = {"info": {"title": "Local MoE Harness"}}
    details = {
        "runtimeReady": False,
        "runtimeReachable": False,
        "runtimeHealth": "offline",
        "activeModel": {},
        "activeProfile": "",
        "system": {},
        "gpuCoexistence": {},
    }
    with patch.object(local_moe_control, "_harness_health", return_value=health), \
            patch.object(local_moe_control, "_managed_harness_pid") as managed, \
            patch.object(local_moe_control, "_live_details", return_value=details), \
            patch.object(local_moe_control, "_setup_ready", return_value=True):
        status = local_moe_control.get_status()
    managed.assert_not_called()
    require(status["running"] is True and status["state"] == "running",
            "Healthy Harness status did not remain online on the fast path")


def check_transient_health_miss_retains_verified_session() -> None:
    cached = local_moe_control._STATUS_GRACE.recover(True)
    require(cached is not None and cached["running"] is True,
            "A brief health miss discarded the verified Harness session")
    require(cached.get("statusStale") is True and "resynchronizing" in cached["message"],
            "Transient Harness recovery is not identified to the UI")


def check_owned_health_blip_stays_starting() -> None:
    local_moe_control._STATUS_GRACE.clear()
    with patch.object(local_moe_control, "_harness_health", return_value=None), \
            patch.object(local_moe_control, "_port_open", side_effect=lambda port: port == local_moe_control.HARNESS_PORT), \
            patch.object(local_moe_control, "_managed_harness_pid", return_value=42420), \
            patch.object(local_moe_control, "_managed_runtime_pid", return_value=None), \
            patch.object(local_moe_control, "_setup_ready", return_value=True):
        status = local_moe_control.get_status()
    require(status["state"] == "starting" and status["ok"] is True,
            "Owned process was misclassified during a transient health miss")
    require("different service" not in status["message"],
            "Owned process was mislabeled as a foreign service")


def check_unowned_listener_stays_blocked() -> None:
    local_moe_control._STATUS_GRACE.clear()
    with patch.object(local_moe_control, "_harness_health", return_value=None), \
            patch.object(local_moe_control, "_port_open", side_effect=lambda port: port == local_moe_control.HARNESS_PORT), \
            patch.object(local_moe_control, "_managed_harness_pid", return_value=None), \
            patch.object(local_moe_control, "_managed_runtime_pid", return_value=None), \
            patch.object(local_moe_control, "_setup_ready", return_value=True):
        status = local_moe_control.get_status()
    require(status["state"] == "blocked" and status["ok"] is False,
            "Unowned Harness listener did not fail closed")


def check_start_passes_canonical_ports() -> None:
    stopped = {"running": False, "state": "stopped", "setupReady": True, "ok": True}
    harness_only = {
        "running": True, "state": "running", "setupReady": True, "ok": True,
        "runtimeReady": False, "runtimeReachable": False, "runtimeManagedRunning": False,
    }
    loading = {
        **harness_only,
        "runtimeManagedRunning": True,
        "runtimeStartupStage": "loading_weights",
    }
    fake = FakeProcess([], env={})
    with patch.object(local_moe_control, "_status", side_effect=[stopped, harness_only, loading]), \
            patch.object(local_moe_control, "_harness_health", return_value={"info": {}}), \
            patch.object(local_moe_control, "_write_pid") as write_pid, \
            patch.object(local_moe_control, "_http_json",
                         return_value={"lifecycle": {"started": True}}) as runtime_start, \
            patch.object(local_moe_control.eveos_console_prefs, "headless_for", return_value=True), \
            patch.object(local_moe_control.subprocess, "Popen", return_value=fake) as popen:
        result = local_moe_control.start_server()
    environment = popen.call_args.kwargs["env"]
    launch = popen.call_args.kwargs
    require(environment["LOCAL_MOE_HARNESS_PORT"] == str(local_moe_control.HARNESS_PORT),
            "Start lost the canonical Harness port")
    require(environment["FREETOKEN_PORT"] == str(local_moe_control.RUNTIME_PORT),
            "Start lost the canonical runtime port")
    require(environment["LOCAL_MOE_RUNTIME_AUTOSTART"] == "0",
            "Harness lifespan unexpectedly owns implicit model startup")
    require(environment["LOCAL_MOE_HEADLESS"] == "1",
            "Local MoE runtime did not inherit the shared headless preference")
    require(Path(launch["cwd"]).resolve() == local_moe_control._tool_root().resolve(),
            "Harness did not launch from its isolated tool root")
    if local_moe_control.os.name == "nt":
        require(launch["creationflags"] & getattr(local_moe_control.subprocess, "CREATE_NO_WINDOW", 0),
                "Headless Local MoE did not request a hidden terminal")
        require(launch["stdout"] == local_moe_control.subprocess.DEVNULL
                and launch["stderr"] == local_moe_control.subprocess.DEVNULL,
                "Headless Local MoE did not suppress its terminal streams")
    runtime_start.assert_called_once_with(
        local_moe_control.HARNESS_PORT, "/api/runtime/start", method="POST", timeout=30.0
    )
    require(result.get("runtimeStartAccepted") is True,
            "Explicit Local MoE start did not request the selected model runtime")
    require(result["ok"] is True, "Start did not return its lifecycle result")
    write_pid.assert_called_once_with(fake.pid)
    local_moe_control._PROCESS = None


def check_online_harness_start_bootstraps_stopped_runtime() -> None:
    harness_only = {
        "running": True, "state": "running", "setupReady": True, "ok": True,
        "runtimeReady": False, "runtimeReachable": False, "runtimeManagedRunning": False,
    }
    loading = {
        **harness_only,
        "runtimeManagedRunning": True,
        "runtimeStartupStage": "loading_weights",
    }
    with patch.object(local_moe_control, "_status", side_effect=[harness_only, loading]), \
            patch.object(local_moe_control, "_http_json",
                         return_value={"lifecycle": {"started": True}}) as runtime_start, \
            patch.object(local_moe_control.subprocess, "Popen") as popen:
        result = local_moe_control.start_server()
    popen.assert_not_called()
    runtime_start.assert_called_once_with(
        local_moe_control.HARNESS_PORT, "/api/runtime/start", method="POST", timeout=30.0
    )
    require(result.get("runtimeStartAccepted") is True
            and result.get("runtimeManagedRunning") is True,
            "Start on an online Harness did not recover its stopped model runtime")


def check_unowned_stop_fails_closed() -> None:
    running = {"running": True, "state": "running", "ok": True}
    with patch.object(local_moe_control, "_harness_health", return_value={"info": {}}), \
            patch.object(local_moe_control, "_managed_harness_pid", return_value=None), \
            patch.object(local_moe_control, "_status", return_value=running), \
            patch.object(local_moe_control, "_terminate_owned") as terminate:
        result = local_moe_control.stop_server()
    require(result["ok"] is False and result["state"] == "external",
            "Unowned Harness stop did not fail closed")
    terminate.assert_not_called()


def check_windows_tree_exit_is_idempotent() -> None:
    if local_moe_control.os.name != "nt":
        return
    with patch.object(local_moe_control.subprocess, "run", return_value=SimpleNamespace(returncode=128)), \
            patch.object(local_moe_control, "_process_command_line", return_value=""), \
            patch.object(local_moe_control, "_harness_health", return_value=None):
        require(local_moe_control._terminate_owned(731) is True,
                "A completed Windows process-tree exit was reported as a stop failure")


def check_owned_stop_uses_verified_pid() -> None:
    stopped = {"running": False, "state": "stopped", "ok": True}
    with tempfile.TemporaryDirectory() as raw:
        temp = Path(raw)
        harness_pid = temp / "harness.pid"
        runtime_pid = temp / "freetoken.pid"
        harness_pid.write_text("731", encoding="ascii")
        runtime_pid.write_text("732", encoding="ascii")
        with patch.object(local_moe_control, "_harness_health", side_effect=[{"info": {}}, None, None]), \
                patch.object(local_moe_control, "_managed_harness_pid", return_value=731), \
                patch.object(local_moe_control, "_terminate_owned", return_value=True) as terminate, \
                patch.object(local_moe_control, "_http_json", return_value={}) as request, \
                patch.object(local_moe_control, "_port_open", return_value=False), \
                patch.object(local_moe_control, "_pid_path", return_value=harness_pid), \
                patch.object(local_moe_control, "_runtime_pid_path", return_value=runtime_pid), \
                patch.object(local_moe_control, "_status", return_value=stopped):
            result = local_moe_control.stop_server()
    terminate.assert_called_once_with(731)
    request.assert_called_once_with(
        local_moe_control.HARNESS_PORT, "/api/runtime/stop", method="POST", timeout=20
    )
    require(result["state"] == "stopped", "Owned stop did not return stopped state")


def check_orphan_runtime_stop_uses_verified_pid() -> None:
    stopped = {"running": False, "state": "stopped", "ok": True}
    with tempfile.TemporaryDirectory() as raw:
        temp = Path(raw)
        harness_pid = temp / "harness.pid"
        runtime_pid = temp / "freetoken.pid"
        harness_pid.write_text("731", encoding="ascii")
        runtime_pid.write_text("844", encoding="ascii")
        with patch.object(local_moe_control, "_harness_health", return_value=None), \
                patch.object(local_moe_control, "_managed_harness_pid", return_value=None), \
                patch.object(local_moe_control, "_managed_runtime_pid", return_value=844), \
                patch.object(local_moe_control, "_terminate_owned_runtime", return_value=True) as terminate, \
                patch.object(local_moe_control, "_pid_path", return_value=harness_pid), \
                patch.object(local_moe_control, "_runtime_pid_path", return_value=runtime_pid), \
                patch.object(local_moe_control, "_status", return_value=stopped):
            result = local_moe_control.stop_server()
            terminate.assert_called_once_with(844)
            require(result["state"] == "stopped", "Orphan runtime stop did not return stopped state")
            require(not harness_pid.exists(), "Orphan cleanup retained the stale Harness PID")
            require(not runtime_pid.exists(), "Orphan cleanup retained the stopped runtime PID")


def check_failed_orphan_runtime_stop_stays_retryable() -> None:
    stale = {"running": False, "state": "stopped", "ok": True}
    with tempfile.TemporaryDirectory() as raw:
        temp = Path(raw)
        harness_pid = temp / "harness.pid"
        runtime_pid = temp / "freetoken.pid"
        harness_pid.write_text("731", encoding="ascii")
        runtime_pid.write_text("844", encoding="ascii")
        with patch.object(local_moe_control, "_harness_health", return_value=None), \
                patch.object(local_moe_control, "_managed_harness_pid", return_value=None), \
                patch.object(local_moe_control, "_managed_runtime_pid", return_value=844), \
                patch.object(local_moe_control, "_terminate_owned_runtime", return_value=False), \
                patch.object(local_moe_control, "_pid_path", return_value=harness_pid), \
                patch.object(local_moe_control, "_runtime_pid_path", return_value=runtime_pid), \
                patch.object(local_moe_control, "_status", return_value=stale):
            result = local_moe_control.stop_server()
            require(result["ok"] is False and result["state"] == "error",
                    "A surviving orphan runtime was reported as stopped")
            require(runtime_pid.exists(), "A failed stop erased the PID required for retry")


def check_control_plane_wiring() -> None:
    source = Path(eveos_control_helper.__file__).read_text(encoding="utf-8")
    for endpoint in ("/api/local-moe/status", "/api/local-moe/start", "/api/local-moe/stop",
                     "/api/local-moe/launch", "/api/local-moe/setup"):
        require(endpoint in source, f"Control plane is missing {endpoint}")
    require("local_moe_control.restore_desired_state_async" not in source,
            "Local MoE must never auto-restore when Local Control opens")
    require('(\"localMoe\", local_moe_control.stop_server)' in source,
            "Global Stop does not include the Local MoE Harness")
    require("localMoe" in local_moe_control.eveos_console_prefs.KNOWN_SERVICES,
            "Local MoE is missing from the shared terminal preference registry")


def main() -> None:
    checks = (
        check_config_ports,
        check_runtime_status_endpoint_is_lightweight,
        check_live_details_uses_lightweight_runtime_status,
        check_status_is_passive,
        check_healthy_status_skips_slow_windows_ownership_lookup,
        check_transient_health_miss_retains_verified_session,
        check_owned_health_blip_stays_starting,
        check_unowned_listener_stays_blocked,
        check_start_passes_canonical_ports,
        check_online_harness_start_bootstraps_stopped_runtime,
        check_unowned_stop_fails_closed,
        check_windows_tree_exit_is_idempotent,
        check_owned_stop_uses_verified_pid,
        check_orphan_runtime_stop_uses_verified_pid,
        check_failed_orphan_runtime_stop_stays_retryable,
        check_control_plane_wiring,
    )
    for check in checks:
        check()
    print(f"local-moe-control-smoke: PASS ({len(checks)} checks)")


if __name__ == "__main__":
    main()
