#!/usr/bin/env python3
"""Lifecycle and HTTP contracts for the file-mode EveOS control plane."""

from __future__ import annotations

import http.client
import http.server
import json
import os
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import eveos_control_helper, eveos_web_control  # noqa: E402


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def assert_true(condition, message):
    if not condition:
        raise AssertionError(message)


def request_json(port: int, method: str, path: str, origin: str = "null") -> tuple[int, dict]:
    for attempt in range(3):
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
        try:
            connection.request(
                method,
                path,
                body=b"{}" if method == "POST" else None,
                headers={"Origin": origin, "Content-Type": "application/json", "Connection": "close"},
            )
            response = connection.getresponse()
            return response.status, json.loads(response.read().decode("utf-8"))
        except (ConnectionResetError, ConnectionAbortedError):
            if attempt == 2:
                raise
            import time; time.sleep(0.05)
        finally:
            connection.close()


def file_mode_discovery_smoke():
    H = eveos_control_helper
    original_last_port = H._read_last_launcher_port
    original_health = eveos_web_control._health_payload
    original_desired = eveos_web_control._read_desired_port
    original_web_port = eveos_web_control.EVEOS_WEB_PORT
    original_process_port = getattr(eveos_web_control, "_PROCESS_PORT", None)
    try:
        H._read_last_launcher_port = lambda: 4321
        eveos_web_control._PROCESS_PORT = None
        eveos_web_control._read_desired_port = lambda: 8765
        eveos_web_control.EVEOS_WEB_PORT = 8765
        eveos_web_control._health_payload = lambda port=None: {"ok": True} if int(port or 0) == 4321 else None
        assert_true(H._discover_file_web_port() == 4321,
                    "file mode did not prefer the last verified launcher port")

        H._read_last_launcher_port = lambda: None
        eveos_web_control._health_payload = lambda port=None: {"ok": True} if int(port or 0) == 3000 else None
        assert_true(H._discover_file_web_port() == 3000,
                    "file mode did not fall back to the main launcher port")

        eveos_web_control._health_payload = lambda port=None: None
        assert_true(H._discover_file_web_port() is None,
                    "file mode accepted a port that did not identify as EveOS")
    finally:
        H._read_last_launcher_port = original_last_port
        eveos_web_control._health_payload = original_health
        eveos_web_control._read_desired_port = original_desired
        eveos_web_control.EVEOS_WEB_PORT = original_web_port
        eveos_web_control._PROCESS_PORT = original_process_port


def lifecycle_smoke(tmp: Path):
    canonical_port = free_port()
    alternate_port = free_port()
    fake_server = tmp / "fake-eveos-server.py"
    fake_server.write_text(
        textwrap.dedent(
            """
            import argparse
            import http.server
            import json

            parser = argparse.ArgumentParser()
            parser.add_argument("port", type=int)
            parser.add_argument("--no-browser", action="store_true")
            args = parser.parse_args()

            class Handler(http.server.BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path != "/api/status":
                        self.send_error(404)
                        return
                    body = json.dumps({
                        "ok": True,
                        "service": "eveos-local-server",
                        "port": args.port
                    }).encode("utf-8")
                    self.send_response(200)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(body)))
                    self.end_headers()
                    self.wfile.write(body)
                def log_message(self, *_args):
                    pass

            http.server.ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
            """
        ).strip()
        + "\n",
        encoding="utf-8",
    )

    original_port = eveos_web_control.EVEOS_WEB_PORT
    original_entry = eveos_web_control._entry_point
    original_preference = eveos_web_control._preference_path
    try:
        eveos_web_control.EVEOS_WEB_PORT = canonical_port
        eveos_web_control._entry_point = lambda: fake_server
        eveos_web_control._preference_path = lambda: tmp / "eveos-web-service.json"

        started = eveos_web_control.start_server()
        assert_true(started["ok"] and started["running"], f"web start failed: {started}")
        assert_true(started["port"] == canonical_port, "canonical web start used the wrong port")
        assert_true(started["desiredRunning"], "web desired state was not persisted")
        assert_true(started["url"].endswith(f":{canonical_port}/EveOS.html"), "web URL used the wrong port")

        stopped = eveos_web_control.stop_server()
        assert_true(stopped["ok"] and not stopped["running"], f"web stop failed: {stopped}")
        assert_true(not stopped["desiredRunning"], "web stopped state was not persisted")

        alternate = eveos_web_control.start_server(port=alternate_port)
        assert_true(alternate["ok"] and alternate["running"], f"alternate web start failed: {alternate}")
        assert_true(alternate["port"] == alternate_port, "alternate EveOS port was discarded")
        assert_true(eveos_web_control.get_status(port=alternate_port)["running"],
                    "targeted status did not see the alternate EveOS instance")
        assert_true(eveos_web_control._read_desired_port() == alternate_port,
                    "alternate desired port was not persisted")

        alternate_stopped = eveos_web_control.stop_server(port=alternate_port)
        assert_true(alternate_stopped["ok"] and not alternate_stopped["running"],
                    f"alternate web stop failed: {alternate_stopped}")
    finally:
        for candidate in (canonical_port, alternate_port):
            try:
                eveos_web_control.stop_server(persist=False, port=candidate)
            except Exception:
                pass
        eveos_web_control.EVEOS_WEB_PORT = original_port
        eveos_web_control._entry_point = original_entry
        eveos_web_control._preference_path = original_preference


def helper_http_smoke():
    port = free_port()
    H = eveos_control_helper
    original = (
        H._discover_file_web_port,
        H.eveos_web_control.get_status, H.eveos_web_control.start_server, H.eveos_web_control.stop_server,
        H.world_book_control.get_status, H.world_book_control.start_server, H.world_book_control.stop_server,
        H.watchfusion_control.get_status, H.watchfusion_control.start_server, H.watchfusion_control.stop_server,
        H.piano_player_control.stop_server, H.gemini_control.stop_server,
    )
    calls = []
    discovery = {"port": 3000}
    web_state = {
        "ok": True, "controllerAvailable": True, "running": False, "desiredRunning": False,
        "state": "stopped", "port": 8765, "url": "http://127.0.0.1:8765/EveOS.html",
        "message": "EveOS localhost is stopped.",
    }

    def get_status(port=None):
        target = int(port or 8765)
        calls.append(("status", target))
        snapshot = dict(web_state)
        snapshot.update(port=target, url=f"http://127.0.0.1:{target}/EveOS.html")
        return snapshot

    def set_running(enabled, port=None):
        target = int(port or 8765)
        calls.append(("start" if enabled else "stop", target))
        web_state.update(
            running=enabled, desiredRunning=enabled, state="running" if enabled else "stopped",
            port=target, url=f"http://127.0.0.1:{target}/EveOS.html",
            message="EveOS localhost is online." if enabled else "EveOS localhost is stopped.",
        )
        return dict(web_state)

    world_state = {
        "ok": True, "controllerAvailable": True, "installed": True, "running": False,
        "desiredRunning": False, "state": "stopped", "port": 8766,
        "url": "http://127.0.0.1:8766/", "message": "World Book is stopped.",
    }
    watch_state = {
        "ok": True, "controllerAvailable": True, "installed": True, "running": False,
        "desiredRunning": False, "state": "stopped", "port": 9085,
        "url": "http://127-0-0-1.sslip.io:9085/", "message": "WatchFusion is stopped.",
    }

    def set_world_running(enabled):
        world_state.update(running=enabled, desiredRunning=enabled,
                           state="running" if enabled else "stopped",
                           message="World Book is online." if enabled else "World Book is stopped.")
        return dict(world_state)

    def set_watch_running(enabled):
        watch_state.update(running=enabled, desiredRunning=enabled,
                           state="running" if enabled else "stopped",
                           message="WatchFusion is online." if enabled else "WatchFusion is stopped.")
        return dict(watch_state)

    H._discover_file_web_port = lambda: discovery["port"]
    H.eveos_web_control.get_status = get_status
    H.eveos_web_control.start_server = lambda *, persist=True, port=None: set_running(True, port)
    H.eveos_web_control.stop_server = lambda *, persist=True, port=None: set_running(False, port)
    H.world_book_control.get_status = lambda: dict(world_state)
    H.world_book_control.start_server = lambda: set_world_running(True)
    H.world_book_control.stop_server = lambda: set_world_running(False)
    H.watchfusion_control.get_status = lambda: dict(watch_state)
    H.watchfusion_control.start_server = lambda: set_watch_running(True)
    H.watchfusion_control.stop_server = lambda: set_watch_running(False)
    H.piano_player_control.stop_server = lambda: {"ok": True, "running": False}
    H.gemini_control.stop_server = lambda: {"ok": True, "running": False}

    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), H.EveOSControlHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status_code, payload = request_json(port, "GET", "/api/control-plane/health")
        assert_true(status_code == 200, "control-plane health was not reachable")
        assert_true(payload.get("service") == "eveos-control-plane", "control-plane identity is missing")
        assert_true(payload.get("controllerAvailable") is True, "health controller flag is missing")
        assert_true("web" not in payload, "fast health route performed detailed status discovery")

        probe = subprocess.run(
            [sys.executable, str(ROOT / "server" / "eveos-control-helper.py"), str(port),
             "--probe", "--timeout", "2"], cwd=ROOT, capture_output=True, text=True,
            timeout=4, check=False,
        )
        assert_true(probe.returncode == 0,
                    f"control-plane CLI probe failed: {probe.stderr or probe.stdout}")

        status_code, payload = request_json(port, "GET", "/api/control-plane/status")
        assert_true(status_code == 200, "file-mode control-plane status was not reachable")
        assert_true(payload.get("web", {}).get("port") == 3000,
                    "file-mode status did not discover the verified launcher port")
        assert_true(("status", 3000) in calls,
                    "file-mode status did not query the discovered EveOS port")

        discovery["port"] = None
        status_code, payload = request_json(port, "GET", "/api/control-plane/status")
        assert_true(status_code == 200 and payload.get("web", {}).get("port") == 8765,
                    "file-mode status did not fall back to canonical port when nothing was discovered")
        discovery["port"] = 3000

        status_code, payload = request_json(port, "GET", "/api/control-plane/status",
                                            origin="http://localhost:3000")
        assert_true(status_code == 200, "origin-aware control-plane status was not reachable")
        assert_true(payload.get("web", {}).get("port") == 3000,
                    "localhost:3000 origin was incorrectly reported as port 8765")
        assert_true(("status", 3000) in calls, "requesting localhost port did not reach web status")

        status_code, payload = request_json(port, "GET", "/api/eveos-server/status?port=4321",
                                            origin="null")
        assert_true(status_code == 200 and payload.get("port") == 4321,
                    "explicit connector port did not override file-mode discovery")

        status_code, payload = request_json(port, "POST", "/api/eveos-server/start",
                                            origin="http://127.0.0.1:3000")
        assert_true(status_code == 200 and payload.get("running") is True,
                    "web start route failed for localhost:3000")
        assert_true(payload.get("port") == 3000, "web start route dropped the requesting port")

        status_code, payload = request_json(port, "POST", "/api/eveos-server/stop",
                                            origin="http://127.0.0.1:3000")
        assert_true(status_code == 200 and payload.get("running") is False,
                    "web stop route failed for localhost:3000")
        assert_true(payload.get("port") == 3000, "web stop route targeted the wrong port")

        status_code, payload = request_json(port, "POST", "/api/world-book/start")
        assert_true(status_code == 200 and payload.get("running") is True, "World Book start route failed")
        assert_true(web_state["running"] is False, "World Book start also started EveOS localhost")
        status_code, payload = request_json(port, "POST", "/api/world-book/stop")
        assert_true(status_code == 200 and payload.get("running") is False, "World Book stop route failed")

        status_code, payload = request_json(port, "GET", "/api/watchfusion/status")
        assert_true(status_code == 200 and payload.get("port") == 9085,
                    "WatchFusion status route failed")
        status_code, payload = request_json(port, "POST", "/api/watchfusion/start")
        assert_true(status_code == 200 and payload.get("running") is True,
                    "WatchFusion start route failed")
        status_code, payload = request_json(port, "POST", "/api/watchfusion/stop")
        assert_true(status_code == 200 and payload.get("running") is False,
                    "WatchFusion stop route failed")
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)
        (
            H._discover_file_web_port,
            H.eveos_web_control.get_status, H.eveos_web_control.start_server, H.eveos_web_control.stop_server,
            H.world_book_control.get_status, H.world_book_control.start_server, H.world_book_control.stop_server,
            H.watchfusion_control.get_status, H.watchfusion_control.start_server, H.watchfusion_control.stop_server,
            H.piano_player_control.stop_server, H.gemini_control.stop_server,
        ) = original


def malformed_health_response_smoke():
    original_connection = eveos_web_control.http.client.HTTPConnection

    class BrokenConnection:
        def __init__(self, *_args, **_kwargs):
            pass

        def request(self, *_args, **_kwargs):
            pass

        def getresponse(self):
            raise http.client.BadStatusLine("GET /api/status HTTP/1.1\r\n")

        def close(self):
            pass

    try:
        eveos_web_control.http.client.HTTPConnection = BrokenConnection
        assert_true(eveos_web_control._health_payload() is None,
                    "malformed health responses must be treated as an offline probe")
    finally:
        eveos_web_control.http.client.HTTPConnection = original_connection


def main():
    malformed_health_response_smoke()
    file_mode_discovery_smoke()
    with tempfile.TemporaryDirectory(prefix="eveos-control-smoke-") as temp_dir:
        lifecycle_smoke(Path(temp_dir))
    helper_http_smoke()
    print("EVEOS_CONTROL_PLANE_SMOKE_OK")


if __name__ == "__main__":
    main()
