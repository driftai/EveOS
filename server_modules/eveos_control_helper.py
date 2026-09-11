"""General loopback control plane for file:// and localhost EveOS surfaces."""

from __future__ import annotations

import argparse
import http.server
import json
import os
import threading
import time
from http import HTTPStatus
from pathlib import Path
from urllib.parse import parse_qs, urlparse
from urllib.request import urlopen

from . import eveos_console_prefs
from . import eveos_ports
from . import eveos_web_control
from . import gemini_control
from . import gemini_credentials
from . import piano_player_control
from . import watchfusion_control
from . import world_book_control
from .eveos_http_cors import eveos_cors_origin


DEFAULT_PORT = eveos_ports.service_port("GEMINI_CONTROL_PORT")
MAIN_LAUNCHER_PORT = 3000
_SERVER = None
_LOOPBACK_HOSTS = {"127.0.0.1", "localhost", "::1"}


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _shutdown_plane_after_response(delay: float = 0.4) -> bool:
    if _SERVER is None:
        return False
    threading.Timer(delay, _SERVER.shutdown).start()
    return True


def _valid_port(value) -> int | None:
    try:
        port = int(value)
    except (TypeError, ValueError):
        return None
    return port if 1 <= port <= 65535 else None


def _last_launcher_port_path() -> Path:
    return _project_root() / "data" / "runtime" / "eveos-last-launcher-port.txt"


def _read_last_launcher_port() -> int | None:
    try:
        return _valid_port(_last_launcher_port_path().read_text(encoding="utf-8").strip())
    except OSError:
        return None


def _file_mode_discovery_candidates() -> list[int]:
    candidates = [
        _read_last_launcher_port(),
        getattr(eveos_web_control, "_PROCESS_PORT", None),
    ]
    try:
        candidates.append(eveos_web_control._read_desired_port())
    except Exception:  # noqa: BLE001
        pass
    candidates.extend((eveos_web_control.EVEOS_WEB_PORT, MAIN_LAUNCHER_PORT))

    ordered = []
    for candidate in candidates:
        port = _valid_port(candidate)
        if port is not None and port not in ordered:
            ordered.append(port)
    return ordered


def _discover_file_web_port() -> int | None:
    """Find a verified EveOS web surface when file:// cannot provide an origin port.

    This deliberately probes only ports EveOS itself knows about; it never scans arbitrary
    listeners. Every candidate must identify as eveos-local-server before it is accepted.
    """
    for port in _file_mode_discovery_candidates():
        try:
            if eveos_web_control._health_payload(port) is not None:
                return port
        except Exception:  # noqa: BLE001
            continue
    return None


def _request_web_port(handler) -> int | None:
    parsed_request = urlparse(handler.path)
    query = parse_qs(parsed_request.query)
    if query.get("port"):
        requested = _valid_port(query["port"][0])
        if requested is not None:
            return requested

    origin = str(handler.headers.get("Origin", "")).strip()
    if not origin or origin == "null" or origin.lower().startswith("file:"):
        return _discover_file_web_port()
    try:
        parsed_origin = urlparse(origin)
        host = (parsed_origin.hostname or "").lower()
        if parsed_origin.scheme not in {"http", "https"} or host not in _LOOPBACK_HOSTS:
            return None
        return _valid_port(parsed_origin.port)
    except ValueError:
        return None


def wait_for_control(port: int, timeout: float) -> int:
    deadline = time.monotonic() + max(0.1, timeout)
    url = f"http://127.0.0.1:{port}/api/control-plane/health"
    while time.monotonic() < deadline:
        try:
            with urlopen(url, timeout=min(1.0, max(0.1, deadline - time.monotonic()))) as response:
                payload = json.load(response)
            if payload.get("service") == "eveos-control-plane":
                return 0
        except (OSError, ValueError, json.JSONDecodeError):
            pass
        time.sleep(0.2)
    return 1


def _console_preferences() -> dict:
    prefs = eveos_console_prefs.read_all()
    return {
        "ok": True,
        "default": prefs["default"],
        "envForced": bool(str(os.environ.get("EVEOS_HEADLESS", "")).strip()),
        "preferencesOnly": True,
        "services": [
            {
                "key": key,
                "headless": eveos_console_prefs.headless_for(key),
                "overridden": key in prefs["services"],
            }
            for key in eveos_console_prefs.KNOWN_SERVICES
        ],
    }


def _console_overview(web_port=None) -> dict:
    prefs = eveos_console_prefs.read_all()
    services = []
    status_specs = (
        ("web", "EveOS localhost",
         (lambda: eveos_web_control.get_status()) if web_port is None else (lambda: eveos_web_control.get_status(port=web_port)),
         lambda s: [s.get("port")]),
        ("gemini", "Gemini backend", gemini_control.get_status,
         lambda s: [s.get("websocketPort"), s.get("statusPort")]),
        ("worldBook", "World Book", world_book_control.get_status,
         lambda s: [s.get("port")]),
        ("piano", "Piano Auto Player", piano_player_control.get_status,
         lambda s: [s.get("port")]),
        ("watchFusion", "WatchFusion", watchfusion_control.get_status,
         lambda s: [s.get("port")]),
    )
    for key, label, status_fn, ports in status_specs:
        try:
            status = status_fn() or {}
        except Exception as exc:  # noqa: BLE001
            status = {"running": False, "message": f"status unavailable: {exc}"}
        services.append({
            "key": key,
            "label": label,
            "running": status.get("running") is True,
            "ports": [p for p in ports(status) if p],
            "message": status.get("message") or "",
            "headless": eveos_console_prefs.headless_for(key),
            "overridden": key in prefs["services"],
        })
    return {
        "ok": True,
        "default": prefs["default"],
        "envForced": bool(str(os.environ.get("EVEOS_HEADLESS", "")).strip()),
        "controlPlanePort": _SERVER.server_port if _SERVER else None,
        "services": services,
    }


def _stop_everything(web_port=None) -> dict:
    also = {}
    for name, stop in (("watchFusion", watchfusion_control.stop_server),
                       ("piano", piano_player_control.stop_server),
                       ("worldBook", world_book_control.stop_server),
                       ("gemini", gemini_control.stop_server)):
        try:
            also[name] = "stopped" if (stop() or {}).get("ok", True) else "reported not-ok"
        except Exception as exc:  # noqa: BLE001
            also[name] = f"error: {exc}"

    payload = (
        eveos_web_control.stop_server()
        if web_port is None
        else eveos_web_control.stop_server(port=web_port)
    )
    payload["stoppedAlso"] = also
    payload["controlPlaneStopping"] = _shutdown_plane_after_response()
    return payload


class EveOSControlHandler(http.server.BaseHTTPRequestHandler):
    def end_headers(self):
        origin = eveos_cors_origin(self.headers.get("Origin"))
        if origin is not None:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Requested-With")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in {"/api/health", "/api/control-plane/health"}:
            self._send({
                "ok": True,
                "service": "eveos-control-plane",
                "controllerAvailable": True,
                "state": "running",
                "running": True,
                "port": self.server.server_port,
            })
            return

        if path in {"/api/status", "/status", "/api/control-plane/status"}:
            web_port = _request_web_port(self)
            web = eveos_web_control.get_status(port=web_port)
            self._send({
                "ok": True,
                "service": "eveos-control-plane",
                "controllerAvailable": True,
                "state": "running",
                "running": True,
                "port": self.server.server_port,
                "web": web,
                "message": "EveOS local control is ready.",
            })
            return
        if path == "/api/eveos-server/status":
            self._send(eveos_web_control.get_status(port=_request_web_port(self)))
            return
        if path == "/api/gemini-server/status":
            self._send(gemini_control.get_status())
            return
        if path == "/api/world-book/status":
            self._send(world_book_control.get_status())
            return
        if path == "/api/piano-player/status":
            self._send(piano_player_control.get_status())
            return
        if path == "/api/watchfusion/status":
            self._send(watchfusion_control.get_status())
            return
        if path == "/api/control-plane/consoles":
            self._send(_console_overview(_request_web_port(self)))
            return
        if path == "/api/gemini-credentials/status":
            if not gemini_control.request_can_control(self):
                self._send({"ok": False, "configured": False, "message": "Local access required."}, HTTPStatus.FORBIDDEN)
                return
            self._send(gemini_credentials.get_status())
            return
        self._send({"ok": False, "error": "Unknown endpoint"}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urlparse(self.path).path
        controlled_paths = {
            "/api/eveos-server/start", "/api/eveos-server/stop",
            "/api/gemini-server/start", "/api/gemini-server/stop",
            "/api/world-book/start", "/api/world-book/stop", "/api/world-book/launch",
            "/api/piano-player/start", "/api/piano-player/stop", "/api/piano-player/launch", "/api/piano-player/setup",
            "/api/watchfusion/start", "/api/watchfusion/stop", "/api/watchfusion/launch", "/api/watchfusion/setup",
            "/api/gemini-credentials", "/api/control-plane/consoles",
        }
        if path in controlled_paths and not gemini_control.request_can_control(self):
            self._send({
                "ok": False,
                "controllerAvailable": True,
                "state": "forbidden",
                "running": False,
                "message": "Lifecycle control is limited to local EveOS pages.",
            }, HTTPStatus.FORBIDDEN)
            return

        action = None
        if path == "/api/eveos-server/start":
            action = lambda: eveos_web_control.start_server(port=_request_web_port(self))
        elif path == "/api/eveos-server/stop":
            action = lambda: _stop_everything(_request_web_port(self))
        elif path == "/api/gemini-server/start":
            action = gemini_control.start_server
        elif path == "/api/gemini-server/stop":
            action = gemini_control.stop_server
        elif path == "/api/world-book/start":
            action = world_book_control.start_server
        elif path == "/api/world-book/stop":
            action = world_book_control.stop_server
        elif path == "/api/world-book/launch":
            action = world_book_control.open_launcher
        elif path == "/api/piano-player/start":
            action = piano_player_control.start_server
        elif path == "/api/piano-player/stop":
            action = piano_player_control.stop_server
        elif path == "/api/piano-player/launch":
            action = piano_player_control.open_launcher
        elif path == "/api/piano-player/setup":
            action = piano_player_control.open_setup
        elif path == "/api/watchfusion/start":
            action = watchfusion_control.start_server
        elif path == "/api/watchfusion/stop":
            action = watchfusion_control.stop_server
        elif path == "/api/watchfusion/launch":
            action = watchfusion_control.open_launcher

        if action is not None:
            payload = action()
            self._send(payload, HTTPStatus.OK if payload.get("ok") else HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path == "/api/watchfusion/setup":
            body = gemini_credentials.read_json_body(self) or {}
            payload = watchfusion_control.setup_component(str(body.get("component") or "core"))
            self._send(payload, HTTPStatus.OK if payload.get("ok") else HTTPStatus.INTERNAL_SERVER_ERROR)
            return
        if path == "/api/control-plane/consoles":
            body = gemini_credentials.read_json_body(self) or {}
            try:
                eveos_console_prefs.set_console(body.get("service"), bool(body.get("headless")))
                payload = _console_preferences()
                payload["message"] = "Applies the next time that service starts."
            except ValueError as exc:
                payload = {"ok": False, "message": str(exc)}
            self._send(payload, HTTPStatus.OK if payload.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        if path == "/api/gemini-credentials":
            body = gemini_credentials.read_json_body(self)
            payload = gemini_credentials.save_api_key(body.get("apiKey", ""))
            self._send(payload, HTTPStatus.OK if payload.get("ok") else HTTPStatus.BAD_REQUEST)
            return
        self._send({"ok": False, "error": "Unknown endpoint"}, HTTPStatus.NOT_FOUND)

    def log_message(self, fmt, *args):
        print("[EveOSControl] " + (fmt % args))

    def _send(self, payload: dict, status: int = HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        try:
            self.send_response(status)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            self.wfile.flush()
        except (ConnectionError, OSError):
            pass


class EveOSControlServer(http.server.ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


def main() -> int:
    parser = argparse.ArgumentParser(description="EveOS file-mode local control plane")
    parser.add_argument("port", nargs="?", type=int, default=DEFAULT_PORT)
    parser.add_argument("--probe", action="store_true", help="Wait for a verified control plane and exit")
    parser.add_argument("--timeout", type=float, default=30.0, help="Probe timeout in seconds")
    args = parser.parse_args()
    if args.probe:
        return wait_for_control(args.port, args.timeout)
    global _SERVER
    server = EveOSControlServer(("127.0.0.1", args.port), EveOSControlHandler)
    _SERVER = server
    print("[OK] EveOS local control plane")
    print(f"  Consoles: {'headless' if eveos_web_control.headless_mode() else 'visible'}"
          " (set EVEOS_HEADLESS=1 to hide spawned servers)")
    print(f"  Control: http://127.0.0.1:{args.port}/api/control-plane/status")
    print("  Manages EveOS localhost, Gemini, World Book, Piano, and WatchFusion independently.")
    print("  Press Ctrl+C to stop the control plane")
    eveos_web_control.restore_desired_state_async()
    world_book_control.restore_desired_state_async()
    piano_player_control.restore_desired_state_async()
    watchfusion_control.restore_desired_state_async()
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[OK] EveOS local control plane stopped")
    finally:
        server.server_close()
    return 0