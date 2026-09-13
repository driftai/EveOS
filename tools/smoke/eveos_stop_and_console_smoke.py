"""Stop must leave nothing running, and servers must be visible by default.

Regressions covered here include visible-by-default consoles, silent handling of vanished clients,
individual tool Stop ownership of Local Control, preference persistence, and a global Stop that
cascades through every managed service before closing the control plane. All lifecycle calls are
stubbed: this smoke must never stop a real local service.
"""

import os
import sys
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server_modules import eveos_control_helper as H  # noqa: E402
from server_modules import eveos_web_control as W  # noqa: E402


def check(condition, message):
    if not condition:
        raise AssertionError("ASSERT FAILED: " + message)


class _DeadSocket:
    def write(self, _data):
        raise ConnectionAbortedError(10053, "An established connection was aborted")


class _FakeHandler(H.EveOSControlHandler):
    def __init__(self):
        self.wfile = _DeadSocket()
        self.sent = []

    def send_response(self, code, *_a):
        self.sent.append(code)

    def send_header(self, *_a):
        pass

    def end_headers(self):
        pass


def main():
    os.environ.pop("EVEOS_HEADLESS", None)
    check(W.headless_mode() is False,
          "servers are HEADED by default so what is running is visible")
    for value in ("1", "true", "YES", "on"):
        os.environ["EVEOS_HEADLESS"] = value
        check(W.headless_mode() is True, f"EVEOS_HEADLESS={value} hides the consoles")
    for value in ("0", "false", "no", ""):
        os.environ["EVEOS_HEADLESS"] = value
        check(W.headless_mode() is False, f"EVEOS_HEADLESS={value!r} keeps them visible")
    os.environ.pop("EVEOS_HEADLESS", None)

    handler = _FakeHandler()
    handler._send({"ok": True}, 200)
    check(handler.sent == [200], "the response was still attempted before the socket failed")

    # The Local Control lifetime preference shares the console-preference file. Prove each writer
    # preserves the other fields without touching the user's actual runtime data.
    prefs = H.eveos_console_prefs
    original_pref_path = prefs._path
    try:
        with TemporaryDirectory() as tmp:
            prefs._path = lambda: Path(tmp) / "eveos-consoles.json"
            stored = prefs.read_all()
            check(stored.get("keepLocalControlAfterToolStop") is True,
                  "individual tool Stop keeps Local Control by default")
            prefs.set_keep_local_control_after_tool_stop(True)
            check(prefs.read_all().get("keepLocalControlAfterToolStop") is True,
                  "keep-Local-Control preference persists")
            prefs.set_console("gemini", True)
            stored = prefs.read_all()
            check(stored.get("keepLocalControlAfterToolStop") is True,
                  "console writes preserve the Local Control lifetime preference")
            check(stored.get("services", {}).get("gemini") is True,
                  "console preference still persists")
            prefs.clear("gemini")
            check(prefs.read_all().get("keepLocalControlAfterToolStop") is True,
                  "clearing a console override also preserves the lifetime preference")
    finally:
        prefs._path = original_pref_path

    # Individual tool Stop preserves 9082 by default. Only the explicit Settings opt-in (stored as
    # keepLocalControlAfterToolStop=False) may retire the coordinator after a successful tool stop.
    # Failures stay retryable regardless of the toggle.
    tool_shutdowns = []
    original_shutdown_after_response = H._shutdown_plane_after_response
    original_read_all = prefs.read_all
    try:
        H._shutdown_plane_after_response = lambda: tool_shutdowns.append(True) or True
        prefs.read_all = lambda: {
            "default": False,
            "services": {},
            "keepLocalControlAfterToolStop": True,
        }
        payload = H._stop_tool(lambda: {"ok": True, "running": False})
        check(payload.get("controlPlaneStopping") is False,
              "toggle OFF keeps Local Control alive after successful tool Stop")
        check(not tool_shutdowns, "toggle OFF schedules no coordinator close")

        prefs.read_all = lambda: {
            "default": False,
            "services": {},
            "keepLocalControlAfterToolStop": False,
        }
        payload = H._stop_tool(lambda: {"ok": True, "running": False})
        check(payload.get("controlPlaneStopping") is True,
              "toggle ON closes Local Control after successful tool Stop")
        check(len(tool_shutdowns) == 1, "toggle ON schedules exactly one coordinator close")

        payload = H._stop_tool(lambda: {"ok": False, "message": "still running"})
        check(payload.get("controlPlaneStopping") is False,
              "toggle ON still keeps Local Control alive after reported tool-stop failure")
        check(len(tool_shutdowns) == 1, "failed tool Stop does not schedule another close")

        def fail_tool_stop():
            raise RuntimeError("tool boom")

        payload = H._stop_tool(fail_tool_stop)
        check(payload.get("ok") is False and "tool boom" in payload.get("message", ""),
              "tool-stop exception is surfaced")
        check(payload.get("controlPlaneStopping") is False,
              "toggle ON still keeps Local Control alive after tool-stop exception")
        check(len(tool_shutdowns) == 1, "tool-stop exception does not schedule a close")
    finally:
        H._shutdown_plane_after_response = original_shutdown_after_response
        prefs.read_all = original_read_all

    calls = []
    shutdowns = []

    class _FakeServer:
        def shutdown(self):
            shutdowns.append(True)

    original = (
        H.watchfusion_control.stop_server,
        H.piano_player_control.stop_server,
        H.world_book_control.stop_server,
        H.gemini_control.stop_server,
        H.eveos_web_control.stop_server,
        H._SERVER,
    )
    try:
        H.watchfusion_control.stop_server = lambda: calls.append("watchFusion") or {"ok": True}
        H.piano_player_control.stop_server = lambda: calls.append("piano") or {"ok": True}
        H.world_book_control.stop_server = lambda: calls.append("worldBook") or {"ok": True}
        H.gemini_control.stop_server = lambda: calls.append("gemini") or {"ok": True}
        H.eveos_web_control.stop_server = lambda *a, **k: calls.append("web") or {"ok": True, "running": False}
        H._SERVER = _FakeServer()

        payload = H._stop_everything()

        expected = ["watchFusion", "piano", "worldBook", "gemini", "web"]
        check(calls == expected,
              f"managed dependents stop before the EveOS web surface (got {calls})")
        for key in ("watchFusion", "piano", "worldBook", "gemini"):
            check(payload.get("stoppedAlso", {}).get(key) == "stopped", f"{key} is reported")
        check(payload.get("controlPlaneStopping") is True,
              "the control plane closes itself, so Global Stop leaves nothing running")

        check(not shutdowns, "shutdown is deferred so the response can flush first")
        deadline = __import__("time").monotonic() + 3.0
        while not shutdowns and __import__("time").monotonic() < deadline:
            __import__("time").sleep(0.05)
        check(shutdowns, "the deferred shutdown actually runs")

        calls.clear()
        H.world_book_control.stop_server = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
        payload = H._stop_everything()
        check("error: boom" in payload["stoppedAlso"]["worldBook"], "the failure is reported, not hidden")
        check("watchFusion" in calls and "piano" in calls and "gemini" in calls and "web" in calls,
              "the rest still stop after one managed service fails")

        # The web stop runs after every child. If that final owned-service step raises, global Stop
        # must still schedule the coordinator shutdown instead of leaving Local Control 9082 behind.
        calls.clear()
        H.world_book_control.stop_server = lambda: calls.append("worldBook") or {"ok": True}

        def fail_web_stop(*_a, **_k):
            calls.append("web")
            raise RuntimeError("web boom")

        H.eveos_web_control.stop_server = fail_web_stop
        shutdown_count = len(shutdowns)
        payload = H._stop_everything()
        check(payload.get("ok") is False, "a web-stop failure is reported as a failed global Stop")
        check("web boom" in payload.get("message", ""), "the web-stop failure remains visible")
        check("error: web boom" in payload.get("stoppedAlso", {}).get("web", ""),
              "the failed web stage is identified")
        check(payload.get("controlPlaneStopping") is True,
              "Global Stop remains terminal even when the final web-stop stage raises")
        check(calls == expected,
              f"all children are attempted before the failing web stage (got {calls})")
        deadline = __import__("time").monotonic() + 3.0
        while len(shutdowns) == shutdown_count and __import__("time").monotonic() < deadline:
            __import__("time").sleep(0.05)
        check(len(shutdowns) > shutdown_count,
              "the deferred coordinator shutdown actually runs after a web-stop exception")
    finally:
        (
            H.watchfusion_control.stop_server,
            H.piano_player_control.stop_server,
            H.world_book_control.stop_server,
            H.gemini_control.stop_server,
            H.eveos_web_control.stop_server,
            H._SERVER,
        ) = original

    print("stop + console OK - partial-stop toggle is opt-in, failures stay retryable, Global Stop terminal")
    print("EVEOS_STOP_AND_CONSOLE_SMOKE_OK")


if __name__ == "__main__":
    main()
