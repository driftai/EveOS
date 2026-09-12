"""Stop must leave nothing running, and servers must be visible by default.

Regressions covered here include visible-by-default consoles, silent handling of vanished clients,
and a global Stop that cascades through every managed service before closing the control plane.
All lifecycle calls are stubbed: this smoke must never stop a real local service.
"""

import os
import sys

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
              "the control plane closes itself, so Stop leaves nothing running")

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
              "the coordinator finalizer is scheduled even when the final web-stop stage raises")
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

    print("stop + console OK - headed by default, dead client silent, every managed service isolated")
    print("EVEOS_STOP_AND_CONSOLE_SMOKE_OK")


if __name__ == "__main__":
    main()
