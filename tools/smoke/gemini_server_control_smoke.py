"""Focused lifecycle-contract smoke for EveOS Gemini server control."""

import asyncio
import os
from pathlib import Path
import socket
from unittest import mock
import sys


ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from server_modules import gemini_control  # noqa: E402


class FakeProcess:
    def __init__(self):
        self.returncode = None
        self.terminated = False

    def poll(self):
        return self.returncode

    def terminate(self):
        self.terminated = True
        self.returncode = 0

    def wait(self, timeout=None):
        return self.returncode

    def kill(self):
        self.returncode = -9


class FakeHandler:
    def __init__(self, host, origin, extra_headers=None):
        self.client_address = (host, 12345)
        self.headers = {"Origin": origin}
        if extra_headers:
            self.headers.update(extra_headers)


def assert_port_contract():
    config_path = ROOT / "server" / "gemini-backend" / "interactions" / "main_server_files" / "server_initialization"
    sys.path.insert(0, str(config_path))
    import server_config

    # These must stay in step with GEMINI_WS_PORT and GEMINI_STATUS_PORT in
    # tools/batch/eveos-ports.bat, which is the declared source of truth.
    assert server_config.DEFAULT_PORT == 9085
    assert server_config.STATUS_PORT == 9086


def assert_backend_lifecycle_contract():
    interactions_root = ROOT / "server" / "gemini-backend" / "interactions"
    sys.path.insert(0, str(interactions_root))

    from main_server_files.api_configuration.gemini_config import (
        _disable_automatic_websocket_proxy,
        _gemini_http_options,
    )
    from main_server_files.port_management.port_handler import is_port_in_use
    from main_server_files.server_initialization.server_initializer import parse_server_port, validate_server_port
    from main_server_files.status_monitoring.status_handler import _websocket_ready, start_status_server
    from main_server_files.websocket_server.websocket_server_handler import (
        ALLOWED_BROWSER_ORIGINS,
        MAX_CLIENT_MESSAGE_BYTES,
    )

    assert parse_server_port(["--port", "9191"]) == 9191
    for invalid_port in (1023, 65535):
        try:
            validate_server_port(invalid_port)
        except ValueError:
            pass
        else:
            raise AssertionError(f"Invalid paired Gemini port was accepted: {invalid_port}")

    # Port ownership detection must never connect to the Gemini WebSocket listener.
    # A bind probe reports the conflict without creating an empty handshake attempt.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        occupied_port = listener.getsockname()[1]
        listener.listen(1)
        assert is_port_in_use(occupied_port) is True
    assert is_port_in_use(occupied_port) is False

    port_handler_source = (
        interactions_root / "main_server_files" / "port_management" / "port_handler.py"
    ).read_text(encoding="utf-8")
    assert "connect_ex(" not in port_handler_source
    assert "create_connection(" not in port_handler_source

    # The branded 9086 status endpoint must be equally non-invasive. Polling
    # /status is frequent, so connecting to 9085 here would flood the headed
    # terminal with fake failed-opening-handshake tracebacks.
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        occupied_status_probe_port = listener.getsockname()[1]
        listener.listen(1)
        assert _websocket_ready(occupied_status_probe_port) is True
    assert _websocket_ready(occupied_status_probe_port) is False

    # Text Brain/transcription use normal HTTP model calls, so IPv4 routing must
    # cover both HTTPX clients as well as the separately patched Live WebSocket.
    with mock.patch.dict(
        os.environ,
        {"EVEOS_GEMINI_FORCE_IPV4": "1", "EVEOS_GEMINI_DIRECT_EGRESS": "1"},
    ):
        http_options = _gemini_http_options("v1beta")
    assert http_options["api_version"] == "v1beta"
    assert http_options["client_args"]["trust_env"] is False
    assert http_options["async_client_args"]["trust_env"] is False
    sync_transport = http_options["client_args"]["transport"]
    async_transport = http_options["async_client_args"]["transport"]
    try:
        assert type(sync_transport).__name__ == "HTTPTransport"
        assert type(async_transport).__name__ == "AsyncHTTPTransport"
    finally:
        sync_transport.close()
        asyncio.run(async_transport.aclose())

    def proxy_aware_connector(uri, *, proxy=True):
        return uri, proxy

    websocket_kwargs = {}
    with mock.patch.dict(os.environ, {"EVEOS_GEMINI_DIRECT_EGRESS": "1"}):
        _disable_automatic_websocket_proxy(proxy_aware_connector, websocket_kwargs)
    assert websocket_kwargs["proxy"] is None

    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "httpx==0.28.1" in requirements

    status_server = start_status_server(0, websocket_port=9191)
    try:
        assert status_server.websocket_port == 9191
        assert status_server.server_address[0] == "127.0.0.1"
    finally:
        status_server.server_close()

    main_entry = (interactions_root / "main_server_files" / "server_initialization" / "main_entry.py").read_text(encoding="utf-8")
    websocket_handler = (interactions_root / "main_server_files" / "websocket_server" / "websocket_server_handler.py").read_text(encoding="utf-8")
    assert "periodic_cleanup(" not in main_entry
    assert websocket_handler.count("periodic_cleanup(") == 1
    assert "start_status_server(" not in websocket_handler
    assert MAX_CLIENT_MESSAGE_BYTES == 16 * 1024 * 1024
    assert None in ALLOWED_BROWSER_ORIGINS
    assert "null" in ALLOWED_BROWSER_ORIGINS
    origin_patterns = [item for item in ALLOWED_BROWSER_ORIGINS if hasattr(item, "fullmatch")]
    assert any(pattern.fullmatch("http://127.0.0.1:8765") for pattern in origin_patterns)
    assert any(pattern.fullmatch("https://localhost:3000") for pattern in origin_patterns)
    assert not any(pattern.fullmatch("https://example.com") for pattern in origin_patterns)
    status_handler_source = (
        interactions_root / "main_server_files" / "status_monitoring" / "status_handler.py"
    ).read_text(encoding="utf-8")
    assert '"service": SERVICE_NAME' in status_handler_source
    assert "create_connection(" not in status_handler_source


def assert_legacy_http_safety_contract():
    environment_root = ROOT / "server" / "gemini-backend" / "environment_setup"
    sys.path.insert(0, str(environment_root))
    from http_server_request_handler import CORSRequestHandler

    handler = object.__new__(CORSRequestHandler)
    safe_path = handler.resolve_static_path("/gemini_chat_interface.html")
    assert safe_path.name == "gemini_chat_interface.html"
    try:
        handler.resolve_static_path("/../../requirements.txt")
    except PermissionError:
        pass
    else:
        raise AssertionError("Legacy Gemini HTTP surface allowed parent path traversal")

    http_server_source = (environment_root / "http_server.py").read_text(encoding="utf-8")
    assert "server_address = ('127.0.0.1', port)" in http_server_source
    controller_source = (ROOT / "server" / "gemini-backend" / "scripts" / "server_controller.py").read_text(encoding="utf-8")
    assert "tools' / 'batch' / 'server-menu.bat" in controller_source


def assert_start_contract():
    fake_process = FakeProcess()
    stopped = {
        "ok": True,
        "running": False,
        "statusReady": False,
        "websocketReady": False,
        "state": "stopped",
    }
    starting = {
        "ok": True,
        "running": False,
        "statusReady": False,
        "websocketReady": False,
        "state": "starting",
        "message": "Gemini server is starting.",
    }
    gemini_control._PROCESS = None
    with (
        mock.patch.object(gemini_control, "_status_payload", side_effect=[stopped, starting]),
        mock.patch.object(gemini_control, "_status_http_snapshot", return_value=None),
        mock.patch.object(gemini_control.time, "monotonic", side_effect=[0, 2]),
        mock.patch.object(gemini_control.subprocess, "Popen", return_value=fake_process) as popen,
    ):
        result = gemini_control.start_server()

    command = popen.call_args.args[0]
    environment = popen.call_args.kwargs["env"]
    assert command[-2:] == ["--port", str(gemini_control.WEBSOCKET_PORT)]
    assert command[0] == sys.executable
    assert environment["PYTHONUTF8"] == "1"
    assert environment["PYTHONIOENCODING"] == "utf-8"
    assert environment["EVEOS_GEMINI_FORCE_IPV4"] == "1"
    assert environment["EVEOS_GEMINI_DIRECT_EGRESS"] == "1"
    assert result["state"] == "starting"


def assert_stop_contract():
    gemini_control._PROCESS = None
    with (
        mock.patch.object(gemini_control, "_terminate_pid", return_value=True) as terminate,
        mock.patch.object(
            gemini_control,
            "_status_payload",
            side_effect=[
                {"ok": True, "running": True, "state": "running", "pids": [111]},
                {"ok": True, "running": False, "state": "stopped", "pids": []},
                {"ok": True, "running": False, "state": "stopped", "pids": []},
            ],
        ),
    ):
        result = gemini_control.stop_server()

    assert {call.args[0] for call in terminate.call_args_list} == {111}
    assert result["state"] == "stopped"


def assert_foreign_listener_safety():
    gemini_control._PROCESS = None
    with (
        mock.patch.object(
            gemini_control,
            "_listener_pids",
            side_effect=lambda port, fresh=False: [333],
        ),
        mock.patch.object(gemini_control, "_status_http_snapshot", return_value=None),
        mock.patch.object(gemini_control, "_terminate_pid", return_value=True) as terminate,
    ):
        status = gemini_control.get_status()
        stopped = gemini_control.stop_server()

    assert status["state"] == "conflict"
    assert status["portConflict"] is True
    assert status["running"] is False
    assert status["pids"] == []
    assert stopped["ok"] is False
    assert not terminate.called


def assert_origin_guard():
    assert gemini_control.request_can_control(FakeHandler("127.0.0.1", "null"))
    assert gemini_control.request_can_control(FakeHandler("::1", "http://localhost:8765"))
    assert not gemini_control.request_can_control(FakeHandler("192.168.1.4", "http://localhost:8765"))
    assert not gemini_control.request_can_control(FakeHandler("127.0.0.1", "https://example.com"))
    assert not gemini_control.request_can_control(FakeHandler("127.0.0.1", "http://localhost:8765", {"X-EveOS-Share": "1"}))


if __name__ == "__main__":
    assert_port_contract()
    assert_backend_lifecycle_contract()
    assert_legacy_http_safety_contract()
    assert_start_contract()
    assert_stop_contract()
    assert_foreign_listener_safety()
    assert_origin_guard()
    print("GEMINI_SERVER_CONTROL_SMOKE_OK")
