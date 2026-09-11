"""Stop must leave nothing running, and servers must be visible by default.

Three regressions, all reported from a real session:

1. Stop left the control plane's own console open. The cascade already stopped World Book, Gemini
   and the web server, but the window that stayed up read as "the stop did not work" -- and it was
   the one thing still holding a port. Stop now closes the plane too.

2. Every spawned server used CREATE_NO_WINDOW, so a server that hung, spewed, or refused to die
   left no visible trace unless you already suspected it and went hunting for a log file. Consoles
   are shown by default now; EVEOS_HEADLESS=1 restores the quiet behaviour.

3. Pressing Stop dumped a WinError 10053 traceback. The page tears its polling down the instant it
   fires, so the reply was written to a socket that had already gone. The work had succeeded; only
   the response was lost -- but a traceback in a console the user is watching reads like a crash.

Runs offline: the lifecycle calls and the socket are stubbed.
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
    """A client that vanished: every write raises, exactly as Windows reports it."""

    def write(self, _data):
        raise ConnectionAbortedError(10053, "An established connection was aborted")


class _FakeHandler(H.EveOSControlHandler):
    def __init__(self):  # noqa: D107 - deliberately skips BaseHTTPRequestHandler.__init__
        self.wfile = _DeadSocket()
        self.sent = []

    def send_response(self, code, *_a):
        self.sent.append(code)

    def send_header(self, *_a):
        pass

    def end_headers(self):
        pass


def main():
    # ---- consoles are visible unless explicitly silenced ----
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

    # ---- a vanished client must not produce a traceback ----
    handler = _FakeHandler()
    handler._send({"ok": True}, 200)  # must not raise
    check(handler.sent == [200], "the response was still attempted before the socket failed")

    # ---- stop cascades to every surface AND closes the plane ----
    calls = []
    shutdowns = []

    class _FakeServer:
        def shutdown(self):
            shutdowns.append(True)

    original = (H.world_book_control.stop_server, H.gemini_control.stop_server,
                H.eveos_web_control.stop_server, H._SERVER)
    try:
        H.world_book_control.stop_server = lambda: calls.append("worldBook") or {"ok": True}
        H.gemini_control.stop_server = lambda: calls.append("gemini") or {"ok": True}
        H.eveos_web_control.stop_server = lambda *a, **k: calls.append("web") or {"ok": True, "running": False}
        H._SERVER = _FakeServer()

        payload = H._stop_everything()

        check(calls == ["worldBook", "gemini", "web"],
              f"dependents stop before the surface hosting them (got {calls})")
        check(payload.get("stoppedAlso", {}).get("worldBook") == "stopped", "World Book is reported")
        check(payload.get("stoppedAlso", {}).get("gemini") == "stopped", "Gemini is reported")
        check(payload.get("controlPlaneStopping") is True,
              "the control plane closes itself, so Stop leaves nothing running")

        # The timer fires shortly after, never inline: shutting down mid-write would kill the reply.
        check(not shutdowns, "shutdown is deferred so the response can flush first")
        deadline = __import__("time").monotonic() + 3.0
        while not shutdowns and __import__("time").monotonic() < deadline:
            __import__("time").sleep(0.05)
        check(shutdowns, "the deferred shutdown actually runs")

        # One surface failing must not stop the others, or a single bad service pins the rest up.
        calls.clear()
        H.world_book_control.stop_server = lambda: (_ for _ in ()).throw(RuntimeError("boom"))
        payload = H._stop_everything()
        check("error: boom" in payload["stoppedAlso"]["worldBook"], "the failure is reported, not hidden")
        check("gemini" in calls and "web" in calls, "the rest still stop after one fails")
    finally:
        (H.world_book_control.stop_server, H.gemini_control.stop_server,
         H.eveos_web_control.stop_server, H._SERVER) = original

    print("stop + console OK - headed by default, dead client is silent, stop closes the plane")
    print("EVEOS_STOP_AND_CONSOLE_SMOKE_OK")


if __name__ == "__main__":
    main()
