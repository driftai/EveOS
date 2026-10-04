#!/usr/bin/env python3
"""Focused lifecycle and ownership checks for Nexus Browser integration."""

from __future__ import annotations

import os
import sys
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import eveos_control_helper, nexus_browser_control  # noqa: E402


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def stopped(**updates):
    payload = {
        "ok": True, "state": "stopped", "running": False, "owned": False,
        "installed": True, "nodeReady": True, "npmReady": True,
        "dependenciesReady": True, "setupAvailable": False,
    }
    payload.update(updates)
    return payload


def main():
    require(nexus_browser_control.NEXUS_BROWSER_PORT == 9088, "Nexus Browser port is not registry-backed")
    require(nexus_browser_control._tool_root() == ROOT / "tools" / "Nexus-Browser", "tool root drifted")

    with patch.object(nexus_browser_control, "_health", return_value=None), \
            patch.object(nexus_browser_control, "_port_open", return_value=False), \
            patch.object(nexus_browser_control, "_managed_pid", return_value=None), \
            patch.object(nexus_browser_control, "_deps_ready", return_value=True), \
            patch.object(nexus_browser_control, "_extension_ready", return_value=True):
        status = nexus_browser_control.get_status()
        require(status["state"] == "stopped" and status["running"] is False, "stopped status is not passive")
        require(status["onDemand"] is True and status["extensionReady"] is True, "on-demand/extension contract missing")

    with patch.object(nexus_browser_control, "_health", return_value=None), \
            patch.object(nexus_browser_control, "_port_open", return_value=True), \
            patch.object(nexus_browser_control, "_managed_pid", return_value=None), \
            patch.object(nexus_browser_control, "_deps_ready", return_value=True):
        require(nexus_browser_control.get_status()["state"] == "blocked", "foreign-port state is not detected")

    with patch.object(nexus_browser_control, "_read_pid", return_value=121672), \
            patch.object(nexus_browser_control, "_process_command_line",
                         side_effect=lambda pid: (
                             "node scripts\\bridge-supervisor.js" if pid == 121672 else
                             f'"C:\\Program Files\\nodejs\\node.exe" "{nexus_browser_control._tool_root()}\\server.js"'
                         )), \
            patch.object(nexus_browser_control, "_listener_pids", return_value=[116376]), \
            patch.object(nexus_browser_control, "_process_parent_pid", return_value=121672):
        require(nexus_browser_control._managed_pid() == 121672,
                "relative START.bat supervisor was not authenticated through its owned server child")

    with patch.object(nexus_browser_control, "_health", return_value={"ok": True}), \
            patch.object(nexus_browser_control, "_http_json", return_value={
                "extensionConnected": True, "dexUiConnected": True,
                "onlineTargets": 14, "localTargets": 1, "appTargets": 1, "dexRooms": 1,
                "appBinding": {"connected": True, "providerName": "ChatGPT App"},
                "extensionSessions": {
                    "connected": 2, "primaryReady": True, "primaryTabs": 14,
                    "standby": [{"ready": True, "tabs": 0}],
                },
            }), \
            patch.object(nexus_browser_control, "_managed_pid", return_value=43210), \
            patch.object(nexus_browser_control, "_listener_pids", return_value=[43210]), \
            patch.object(nexus_browser_control, "_deps_ready", return_value=True), \
            patch.object(nexus_browser_control, "_extension_ready", return_value=True):
        status = nexus_browser_control.get_status()
        require(status["onlineTargets"] == 14, "authoritative provider target count was lost")
        require(status["appTargets"] == 1, "App-Origin target count was lost")
        require(status["appBinding"]["providerName"] == "ChatGPT App", "App binding status was lost")
        require(status["extensionSessions"]["connected"] == 2, "extension session diagnostics were lost")
        require(status["extensionSessions"]["primaryTabs"] == 14, "primary extension tab count was lost")
        require(status["extensionSessions"]["standby"][0]["tabs"] == 0, "standby extension diagnostics were lost")

    fake = SimpleNamespace(pid=43210, poll=lambda: None)
    running = {**stopped(), "state": "running", "running": True, "owned": True}
    with patch.object(nexus_browser_control, "_status", side_effect=[stopped(), running]), \
            patch.object(nexus_browser_control, "_health", side_effect=[{"ok": True}, {"ok": True}]), \
            patch.object(nexus_browser_control, "_write_pid") as write_pid, \
            patch.object(nexus_browser_control.eveos_console_prefs, "headless_for", return_value=True), \
            patch.object(nexus_browser_control.subprocess, "Popen", return_value=fake) as popen:
        result = nexus_browser_control.start_server()
        launch = popen.call_args
        environment = launch.kwargs["env"]
        require(result["running"] is True, "start did not return running state")
        require(launch.args[0][1].endswith("bridge-supervisor.js"), "start bypassed deterministic supervisor")
        require(Path(launch.kwargs["cwd"]).resolve() == nexus_browser_control._tool_root().resolve(), "wrong runtime cwd")
        require(environment["NEXUS_BROWSER_PORT"] == "9088" and environment["PORT"] == "9088", "port override missing")
        require(Path(environment["NEXUS_BROWSER_DATA_DIR"]).resolve() == ROOT / "data" / "runtime" / "nexus-browser", "live state is not isolated")
        write_pid.assert_called_once_with(43210)
    nexus_browser_control._PROCESS = None

    with patch.object(nexus_browser_control, "_health", return_value={"ok": True}), \
            patch.object(nexus_browser_control, "_managed_pid", return_value=None), \
            patch.object(nexus_browser_control, "_terminate") as terminate:
        result = nexus_browser_control.stop_server()
        require(result["ok"] is False and result["state"] == "external", "foreign Nexus runtime was not protected")
        terminate.assert_not_called()

    with patch.object(nexus_browser_control, "_health", return_value={"ok": True}), \
            patch.object(nexus_browser_control, "_managed_pid", return_value=43210), \
            patch.object(nexus_browser_control, "_terminate", return_value=True) as terminate, \
            patch.object(nexus_browser_control, "_status", return_value=stopped()), \
            patch.object(Path, "unlink"):
        result = nexus_browser_control.stop_server()
        require(result["running"] is False, "owned runtime did not stop")
        terminate.assert_called_once_with(43210)

    source = (ROOT / "server_modules" / "eveos_control_helper.py").read_text(encoding="utf-8")
    for endpoint in ("/api/nexus-browser/status", "/api/nexus-browser/start", "/api/nexus-browser/stop",
                     "/api/nexus-browser/setup", "/api/nexus-browser/extension"):
        require(endpoint in source, f"control route missing: {endpoint}")
    require('(\"nexusBrowser\", nexus_browser_control.stop_server)' in source,
            "Global Stop does not include Nexus Browser")
    require("nexusBrowser" in nexus_browser_control.eveos_console_prefs.KNOWN_SERVICES,
            "Nexus Browser console preference is missing")
    require("nexus_browser_control.restore_desired_state_async" not in source,
            "Nexus Browser can autostart during control-plane boot")

    requests = eveos_control_helper.eveos_control_requests
    handler = SimpleNamespace(client_address=("127.0.0.1", 1),
                              server=SimpleNamespace(server_address=("127.0.0.1", 9082)),
                              headers={"Host": "127.0.0.1:9082", "Origin": requests.bridge_origin()})
    for route in ("/api/nexus-browser/start", "/api/watchfusion/start"):
        require(requests.can_start_bridge_service(handler, route), f"Bridge Start denied: {route}")
    for route in ("/api/watchfusion/stop", "/api/watchfusion/setup", "/api/watchfusion/extension", "/api/eveos-server/start"):
        require(not requests.can_start_bridge_service(handler, route), f"Unapproved Bridge authority: {route}")
    for key, value in (("Origin", "chrome-extension://untrusted"), ("Host", "remote.example:9082"), ("X-Forwarded-For", "127.0.0.1")):
        original = dict(handler.headers)
        handler.headers[key] = value
        require(not requests.can_start_bridge_service(handler, "/api/watchfusion/start"), f"Unsafe Bridge caller accepted: {key}")
        handler.headers = original
    handler.client_address = ("192.0.2.1", 1)
    require(not requests.can_start_bridge_service(handler, "/api/watchfusion/start"), "Remote Bridge client accepted")
    print("NEXUS_BROWSER_CONTROL_SMOKE_OK")


if __name__ == "__main__":
    main()
