"""Loopback-only lifecycle control for the EveOS Gemini backend."""

from __future__ import annotations

import json
import os
import signal
import socket
import http.client
import subprocess
import sys
import time
from pathlib import Path

from . import eveos_ports, gemini_credentials


WEBSOCKET_PORT = eveos_ports.service_port("GEMINI_WS_PORT")
STATUS_PORT = eveos_ports.service_port("GEMINI_STATUS_PORT")
SERVICE_NAME = "eveos-gemini-live"
_PROCESS = None


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _main_script() -> Path:
    return _project_root() / "server" / "gemini-backend" / "interactions" / "main.py"


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.2):
            return True
    except OSError:
        return False


def _status_http_snapshot() -> dict | None:
    connection = None
    try:
        connection = http.client.HTTPConnection("127.0.0.1", STATUS_PORT, timeout=0.6)
        connection.request("GET", "/status", headers={"Connection": "close"})
        response = connection.getresponse()
        body = response.read(65536)
        if response.status != 200:
            return None
        payload = json.loads(body.decode("utf-8"))
        if payload.get("service") != SERVICE_NAME:
            return None
        if int(payload.get("websocketPort", 0)) != WEBSOCKET_PORT:
            return None
        return payload
    except (OSError, TypeError, ValueError, json.JSONDecodeError):
        return None
    except Exception:
        return None
    finally:
        if connection is not None:
            try:
                connection.close()
            except Exception:
                pass


# A full `netstat -ano` sweep costs hundreds of milliseconds on Windows, and the status
# payload used to run it once PER PORT. Browser-side controller probes time out at well under
# a second, so status calls that crossed that budget made localhost EveOS report the Gemini
# controller as unreachable ("checking" forever). One shared snapshot with a short TTL keeps
# polls cheap; lifecycle transitions request a fresh sweep.
_NETSTAT_TTL_SECONDS = 2.0
_NETSTAT_CACHE = {"at": 0.0, "text": ""}


def _netstat_text(fresh: bool = False) -> str:
    now = time.monotonic()
    if (
        not fresh
        and _NETSTAT_CACHE["text"]
        and (now - _NETSTAT_CACHE["at"]) < _NETSTAT_TTL_SECONDS
    ):
        return _NETSTAT_CACHE["text"]
    result = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"],
        capture_output=True,
        text=True,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    _NETSTAT_CACHE["at"] = now
    _NETSTAT_CACHE["text"] = result.stdout or ""
    return _NETSTAT_CACHE["text"]


def _listener_pids(port: int, fresh: bool = False) -> list[int]:
    if os.name == "nt":
        pids = []
        marker = f":{port}"
        for line in _netstat_text(fresh).splitlines():
            if marker not in line or "LISTENING" not in line.upper():
                continue
            parts = line.split()
            if parts and parts[-1].isdigit():
                pids.append(int(parts[-1]))
        return sorted(set(pids))

    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{port}", "-sTCP:LISTEN", "-t"],
        capture_output=True,
        text=True,
        check=False,
    )
    return sorted({int(value) for value in result.stdout.split() if value.isdigit()})


def _terminate_pid(pid: int) -> bool:
    if pid <= 0 or pid == os.getpid():
        return False
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)],
                capture_output=True,
                text=True,
                check=False,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return result.returncode == 0
        os.kill(pid, signal.SIGTERM)
        return True
    except OSError:
        return False


def _status_payload(message: str = "", fresh: bool = False) -> dict:
    websocket_pids = _listener_pids(WEBSOCKET_PORT, fresh)
    status_pids = _listener_pids(STATUS_PORT)
    websocket_port_open = bool(websocket_pids) and _port_open(WEBSOCKET_PORT)
    status_port_open = bool(status_pids) and _port_open(STATUS_PORT)
    status_snapshot = _status_http_snapshot() if status_port_open else None
    status_ready = status_snapshot is not None
    process_alive = bool(_PROCESS and _PROCESS.poll() is None)
    known_pid = int(getattr(_PROCESS, "pid", 0) or 0) if process_alive else 0

    # A listener is manageable only when the branded status endpoint proves
    # ownership, or when this controller created the process itself. Never
    # infer ownership from a commonly used port number.
    owned_pids = set(status_pids if status_ready else [])
    if known_pid and known_pid in set(websocket_pids + status_pids):
        owned_pids.add(known_pid)
    websocket_ready = (
        status_ready
        and websocket_port_open
        and bool(set(websocket_pids) & owned_pids)
    )
    running = websocket_ready and status_ready
    foreign_pids = set(websocket_pids + status_pids) - owned_pids
    port_conflict = bool(foreign_pids)
    if running:
        state = "running"
    elif port_conflict:
        state = "conflict"
    elif process_alive or owned_pids:
        state = "starting"
    else:
        state = "stopped"
    default_message = (
        "Gemini ports are occupied by another local service."
        if port_conflict
        else f"Gemini server is {state}."
    )
    return {
        "ok": True,
        "controllerAvailable": True,
        "state": state,
        "running": running,
        "websocketReady": websocket_ready,
        "statusReady": status_ready,
        "statusPortOpen": status_port_open,
        "websocketPortOpen": websocket_port_open,
        "portConflict": port_conflict,
        "websocketPort": WEBSOCKET_PORT,
        "statusPort": STATUS_PORT,
        "pids": sorted(owned_pids),
        "message": message or default_message,
    }


def get_status() -> dict:
    return _status_payload()


def start_server() -> dict:
    global _PROCESS

    current = _status_payload(fresh=True)
    if current["running"]:
        current["message"] = "Gemini server is already running."
        return current
    if current.get("portConflict"):
        current.update(
            ok=False,
            state="conflict",
            message=(
                "Gemini could not start because ports "
                f"{WEBSOCKET_PORT}/{STATUS_PORT} belong to another local service."
            ),
        )
        return current

    # Partial listeners are a bad state: the UI sees a port but cannot complete
    # health checks. Restart the Gemini backend instead of leaving it "starting"
    # forever.
    if current.get("pids") and not current["running"]:
        for pid in current["pids"]:
            _terminate_pid(pid)
        _PROCESS = None
        time.sleep(0.35)

    script = _main_script()
    if not script.exists():
        return {
            "ok": False,
            "controllerAvailable": True,
            "state": "error",
            "running": False,
            "message": f"Gemini entry point was not found: {script}",
        }

    if not (_PROCESS and _PROCESS.poll() is None):
        flags = 0
        if os.name == "nt":
            flags = (
                getattr(subprocess, "CREATE_NO_WINDOW", 0)
                | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            )
        env = os.environ.copy()
        env["PYTHONUNBUFFERED"] = "1"
        # Hidden Windows processes otherwise inherit a legacy code page and can
        # crash while printing UTF-8 status text before either server binds.
        env["PYTHONUTF8"] = "1"
        env["PYTHONIOENCODING"] = "utf-8"
        saved_api_key = gemini_credentials.load_api_key()
        if saved_api_key:
            env["GOOGLE_API_KEY"] = saved_api_key
        _PROCESS = subprocess.Popen(
            [sys.executable, str(script), "--port", str(WEBSOCKET_PORT)],
            cwd=str(script.parent),
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            env=env,
            creationflags=flags,
        )

    deadline = time.monotonic() + 1.5
    while time.monotonic() < deadline:
        if _port_open(WEBSOCKET_PORT) and _port_open(STATUS_PORT):
            break
        if _PROCESS.poll() is not None:
            break
        time.sleep(0.1)

    payload = _status_payload("Gemini server started." if _port_open(WEBSOCKET_PORT) else "Gemini server is starting.", fresh=True)
    if _PROCESS.poll() is not None and not payload["running"]:
        payload.update(ok=False, state="error", message="Gemini server exited before becoming ready.")
    return payload


def stop_server() -> dict:
    global _PROCESS

    stopped = False
    current = _status_payload(fresh=True)
    for pid in current.get("pids", []):
        stopped = _terminate_pid(pid) or stopped

    if _PROCESS and _PROCESS.poll() is None:
        try:
            _PROCESS.terminate()
            _PROCESS.wait(timeout=2)
            stopped = True
        except (OSError, subprocess.TimeoutExpired):
            try:
                _PROCESS.kill()
                stopped = True
            except OSError:
                pass
    _PROCESS = None

    deadline = time.monotonic() + 2
    while time.monotonic() < deadline and _status_payload(fresh=True).get("pids"):
        time.sleep(0.1)

    payload = _status_payload(fresh=True)
    if payload.get("portConflict"):
        payload.update(
            ok=False,
            message=(
                "No foreign process was stopped. Gemini ports remain occupied "
                "by another local service."
            ),
        )
    else:
        payload["message"] = "Gemini server stopped." if stopped else "Gemini server was already stopped."
    return payload


def request_can_control(handler) -> bool:
    client_host = str(handler.client_address[0] if handler.client_address else "")
    if client_host.startswith("::ffff:"):
        client_host = client_host[7:]
    if client_host not in {"127.0.0.1", "::1"}:
        return False
    origin = str(handler.headers.get("Origin", "")).strip().lower()
    if not origin or origin == "null" or origin.startswith("file://"):
        return True
    return origin.startswith("http://127.0.0.1:") or origin.startswith("http://localhost:")


def send_json(handler, payload: dict, status: int = 200) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)
