#!/usr/bin/env python3
"""Contract smoke for detached Matrix native background-window control."""

from __future__ import annotations

import http.client
import http.server
import json
import socket
import sys
import threading
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import eveos_control_helper as helper  # noqa: E402
from server_modules import matrix_window_control as matrix_control  # noqa: E402
from server_modules import matrix_taskbar_control as taskbar_control  # noqa: E402


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def free_port():
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def post_json(port, body, origin="null"):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        encoded = json.dumps(body).encode("utf-8")
        connection.request("POST", "/api/matrix-window/control", body=encoded, headers={
            "Origin": origin,
            "Content-Type": "application/json",
            "Content-Length": str(len(encoded)),
            "Connection": "close",
        })
        response = connection.getresponse()
        return response.status, json.loads(response.read().decode("utf-8"))
    finally:
        connection.close()


def direct_contract():
    original = (
        matrix_control.is_supported,
        matrix_control._find_matrix_window,
        matrix_control._apply_window_lock,
        matrix_control._start_enforcement,
        matrix_control._stop_enforcement,
        matrix_control._set_taskbar_autohide,
    )
    calls = []
    try:
        matrix_control.is_supported = lambda: True
        matrix_control._find_matrix_window = lambda token: (321, matrix_control.TITLE_PREFIX + token, 1)
        matrix_control._apply_window_lock = lambda hwnd, enabled: (
            calls.append(("apply", hwnd, enabled))
            or {
                "ok": True,
                "supported": True,
                "backgroundLocked": bool(enabled),
                "noActivateApplied": bool(enabled),
                "appWindowApplied": True,
                "hwnd": hwnd,
            }
        )
        matrix_control._start_enforcement = lambda token, hwnd: calls.append(("start", token, hwnd))
        matrix_control._stop_enforcement = lambda token: calls.append(("stop", token)) or True
        matrix_control._set_taskbar_autohide = lambda token, hwnd, enabled: (
            calls.append(("taskbar", token, hwnd, enabled))
            or {
                "ok": True,
                "supported": True,
                "taskbarAutoHide": bool(enabled),
                "edgeGuard": bool(enabled),
            }
        )

        bad = matrix_control.apply_request({"token": "../bad", "enabled": True})
        assert_true(bad.get("ok") is False, f"invalid token was accepted: {bad}")

        token = "abcDEF12_345"
        locked = matrix_control.apply_request({
            "token": token, "action": "background-lock", "enabled": True
        })
        unlocked = matrix_control.apply_request({
            "token": token, "action": "background-lock", "enabled": False
        })
        taskbar_on = matrix_control.apply_request({
            "token": token, "action": "immersive-taskbar", "enabled": True
        })
        taskbar_off = matrix_control.apply_request({
            "token": token, "action": "immersive-taskbar", "enabled": False
        })

        assert_true(
            locked.get("backgroundLocked") is True
            and locked.get("enforcement") == "continuous"
            and locked.get("appWindowApplied") is True,
            f"continuous lock result mismatch: {locked}",
        )
        assert_true(
            unlocked.get("backgroundLocked") is False and unlocked.get("enforcement") == "off",
            f"unlock result mismatch: {unlocked}",
        )
        assert_true(
            taskbar_on.get("taskbarAutoHide") is True and taskbar_on.get("edgeGuard") is True,
            f"taskbar enable mismatch: {taskbar_on}",
        )
        assert_true(taskbar_off.get("taskbarAutoHide") is False,
                    f"taskbar restore mismatch: {taskbar_off}")
        assert_true(calls == [
            ("apply", 321, True),
            ("start", token, 321),
            ("stop", token),
            ("apply", 321, False),
            ("taskbar", token, 321, True),
            ("taskbar", token, None, False),
        ], f"native control calls mismatch: {calls}")
    finally:
        (
            matrix_control.is_supported,
            matrix_control._find_matrix_window,
            matrix_control._apply_window_lock,
            matrix_control._start_enforcement,
            matrix_control._stop_enforcement,
            matrix_control._set_taskbar_autohide,
        ) = original


def route_contract():
    original_apply = helper.matrix_window_control.apply_request
    calls = []
    helper.matrix_window_control.apply_request = lambda body: (
        calls.append(dict(body))
        or {
            "ok": True,
            "supported": True,
            "backgroundLocked": bool(body.get("enabled")),
        }
    )
    port = free_port()
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), helper.EveOSControlHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        body = {"token": "routeToken12", "action": "background-lock", "enabled": True}
        status, payload = post_json(port, body)
        assert_true(status == 200 and payload.get("backgroundLocked") is True,
                    f"local Matrix route failed: {status} {payload}")
        assert_true(calls == [body], f"Matrix route body mismatch: {calls}")

        forbidden_status, _ = post_json(
            port, body, origin="https://example.com"
        )
        assert_true(forbidden_status == 403, "non-local origin was allowed to control Matrix window")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        helper.matrix_window_control.apply_request = original_apply


def state_transition_contract():
    class FakeWindowApi:
        def __init__(self, foreground, above):
            self.foreground = foreground
            self.above = above

        def GetForegroundWindow(self):
            return self.foreground

        def GetWindow(self, hwnd, direction):
            assert direction == 3
            return self.above.get(hwnd, 0)

    api = FakeWindowApi(22, {11: 22})
    locked_style = matrix_control.WS_EX_NOACTIVATE | matrix_control.WS_EX_APPWINDOW
    with patch.object(matrix_control, "_read_extended_style", return_value=locked_style):
        assert_true(not matrix_control._lock_needs_reassertion(api, 11),
                    "already-background Matrix should not rewrite z-order")
        api.foreground = 11
        assert_true(matrix_control._lock_needs_reassertion(api, 11),
                    "activated Matrix must be pinned again")
        api.foreground = 33
        assert_true(matrix_control._lock_needs_reassertion(api, 11),
                    "Matrix above active app must be pinned again")
    with patch.object(matrix_control, "_read_extended_style", return_value=0):
        assert_true(matrix_control._lock_needs_reassertion(api, 11),
                    "missing native lock style must be repaired")

    class FakeTrayApi:
        def __init__(self, top):
            self.top = top

        def FindWindowW(self, *_args):
            return 9

        def IsWindowVisible(self, _hwnd):
            return True

        def GetWindowRect(self, _hwnd, pointer):
            rect = pointer._obj
            rect.left, rect.top, rect.right, rect.bottom = 0, self.top, 1920, 1246
            return True

    assert_true(not taskbar_control._tray_revealed(FakeTrayApi(1198), 1920, 1200),
                "hidden 2px taskbar strip must keep the Matrix cover visible")
    assert_true(taskbar_control._tray_revealed(FakeTrayApi(1152), 1920, 1200),
                "revealed taskbar must hide the cover for normal interaction")

    class FakePointerApi:
        def __init__(self, x, y):
            self.x, self.y = x, y

        def GetCursorPos(self, pointer):
            pointer._obj.x, pointer._obj.y = self.x, self.y
            return True

    assert_true(taskbar_control._pointer_at_bottom_edge(
        FakePointerApi(960, 1199), 1920, 1200),
        "taskbar edge hover must release the Matrix cover")
    assert_true(not taskbar_control._pointer_at_bottom_edge(
        FakePointerApi(960, 1197), 1920, 1200),
        "ordinary Matrix pointer position must keep the edge covered")
    assert_true(not taskbar_control._pointer_at_bottom_edge(
        FakePointerApi(2000, 1199), 1920, 1200),
        "pointer on another display must not release the primary edge cover")

    class FakeClickApi:
        def __init__(self, states):
            self.states = states

        def GetAsyncKeyState(self, key):
            return self.states.get(key, 0)

    assert_true(taskbar_control._mouse_button_pressed(FakeClickApi({0x01: 0x0001})),
                "a short taskbar click between polls must be retained")
    assert_true(taskbar_control._mouse_button_pressed(FakeClickApi({0x02: 0x8000})),
                "a held taskbar mouse button must count as shell interaction")
    assert_true(not taskbar_control._mouse_button_pressed(FakeClickApi({})),
                "idle pointer state must not suppress hover-only focus cleanup")
    restore_args = dict(edge_triggered=True, near_edge=False, in_open_tray=False,
                        tray_owns_foreground=True)
    assert_true(taskbar_control._should_restore_matrix_focus(
        tray_interacted=False, **restore_args),
        "hover-only taskbar reveal should restore Matrix keyboard focus")
    assert_true(not taskbar_control._should_restore_matrix_focus(
        tray_interacted=True, **restore_args),
        "taskbar app click must not be stolen while Windows activates its target")

    stop = threading.Event()
    taskbar_control._SESSION.update({"token": "restore12", "originalState": 0,
                                     "stop": stop, "watchdog": object()})
    writes = []
    with patch.object(taskbar_control, "_taskbar_state", return_value=1), \
            patch.object(taskbar_control, "_write_taskbar_state",
                         side_effect=lambda state: writes.append(state) or state), \
            patch.object(taskbar_control, "_cancel_watchdog") as cancel:
        assert_true(taskbar_control.restore_taskbar_session("restore12"),
                    "taskbar session should restore on control-plane shutdown")
        assert_true(writes == [0] and stop.is_set() and cancel.call_count == 1,
                    "taskbar restore must stop guard and cancel independent watchdog")
    assert_true(not taskbar_control._SESSION, "restored session must be cleared")


def watchdog_contract():
    class FakeStdin:
        def __init__(self, payload):
            self.buffer = self
            self.payload = payload

        def readline(self):
            return self.payload

    writes = []
    with patch.object(taskbar_control.sys, "stdin", FakeStdin(b"")), \
            patch.object(taskbar_control.os, "name", "nt"), \
            patch.object(taskbar_control, "_taskbar_state", return_value=1), \
            patch.object(taskbar_control, "_write_taskbar_state",
                         side_effect=lambda state: writes.append(state)):
        taskbar_control._watchdog_main(0, 1)
    assert_true(writes == [0], "abrupt owner exit must restore prior taskbar state")
    writes.clear()
    with patch.object(taskbar_control.sys, "stdin", FakeStdin(b"cancel\n")), \
            patch.object(taskbar_control.os, "name", "nt"), \
            patch.object(taskbar_control, "_write_taskbar_state",
                         side_effect=lambda state: writes.append(state)):
        taskbar_control._watchdog_main(0, 1)
    assert_true(not writes, "normal cancellation must not rewrite taskbar state")


if __name__ == "__main__":
    direct_contract()
    route_contract()
    state_transition_contract()
    watchdog_contract()
    print("MATRIX_WINDOW_CONTROL_SMOKE_OK")
