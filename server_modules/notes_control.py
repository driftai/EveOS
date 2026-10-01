"""Persisted lifecycle control for the independent loopback EveOS Notes service."""

from __future__ import annotations

import http.client
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import eveos_console_prefs, eveos_ports, gemini_control


NOTES_PORT = eveos_ports.service_port("NOTES_PORT")
_PROCESS = None
_LOCK = threading.RLock()


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _entry_point() -> Path:
    return _project_root() / "server" / "notes-server.py"


def _preference_path() -> Path:
    return _project_root() / "data" / "runtime" / "notes-service.json"


def _read_desired_state() -> bool:
    try:
        return json.loads(_preference_path().read_text(encoding="utf-8")).get("desiredRunning") is True
    except (OSError, ValueError, TypeError):
        return False


def _write_desired_state(enabled: bool) -> None:
    path = _preference_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({
        "desiredRunning": bool(enabled),
        "port": NOTES_PORT,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, indent=2), encoding="utf-8")
    temporary.replace(path)


def _health_payload() -> dict | None:
    connection = None
    try:
        connection = http.client.HTTPConnection("127.0.0.1", NOTES_PORT, timeout=0.7)
        connection.request("GET", "/api/health", headers={"Connection": "close"})
        response = connection.getresponse()
        payload = json.loads(response.read(65536).decode("utf-8"))
        if response.status == 200 and payload.get("ok") is True and payload.get("service") == "eveos-notes":
            return payload
    except (OSError, ValueError, UnicodeError):
        pass
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass
    return None


def _port_open() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", NOTES_PORT), timeout=0.25):
            return True
    except OSError:
        return False


def _listener_pids() -> list[int]:
    if os.name == "nt":
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        marker = f":{NOTES_PORT}"
        return sorted({int(line.split()[-1]) for line in result.stdout.splitlines()
                       if marker in line and "LISTENING" in line.upper() and line.split()[-1].isdigit()})
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{NOTES_PORT}", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True, check=False,
    )
    return sorted({int(value) for value in result.stdout.split() if value.isdigit()})


def _terminate_pid(pid: int) -> bool:
    if pid <= 0 or pid == os.getpid():
        return False
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, text=True,
                check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return result.returncode == 0
        os.kill(pid, signal.SIGTERM)
        return True
    except OSError:
        return False


def get_status(message: str = "") -> dict:
    with _LOCK:
        health = _health_payload()
        process_alive = bool(_PROCESS and _PROCESS.poll() is None)
        running = health is not None
        blocked = _port_open() and not running
        installed = _entry_point().is_file()
        state = "running" if running else "starting" if process_alive else "blocked" if blocked else "stopped"
        return {
            "ok": installed and not blocked,
            "service": "eveos-notes",
            "controllerAvailable": True,
            "installed": installed,
            "running": running,
            "desiredRunning": _read_desired_state(),
            "state": state,
            "port": NOTES_PORT,
            "url": f"http://127.0.0.1:{NOTES_PORT}",
            "pids": _listener_pids() if running else [],
            "message": message or ("EveOS Notes is ready." if running else
                "Notes port is occupied by another service." if blocked else "EveOS Notes is stopped."),
        }


def start_server(*, persist: bool = True) -> dict:
    global _PROCESS
    with _LOCK:
        if persist:
            _write_desired_state(True)
        current = get_status()
        if current["running"]:
            return {**current, "message": "EveOS Notes is already running."}
        if current["state"] == "blocked":
            return {**current, "ok": False}
        entry = _entry_point()
        if not entry.is_file():
            return {**current, "ok": False, "state": "error", "message": f"Notes entry point missing: {entry}"}
        headless = eveos_console_prefs.headless_for("notes")
        flags = 0
        if os.name == "nt":
            flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            flags |= getattr(subprocess, "CREATE_NO_WINDOW" if headless else "CREATE_NEW_CONSOLE", 0)
        environment = os.environ.copy()
        environment.update(PYTHONUNBUFFERED="1", PYTHONUTF8="1", PYTHONIOENCODING="utf-8")
        _PROCESS = subprocess.Popen(
            [sys.executable, str(entry), "--host", "127.0.0.1", "--port", str(NOTES_PORT)],
            cwd=str(entry.parent), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL if headless else None,
            stderr=subprocess.DEVNULL if headless else None,
            env=environment, creationflags=flags,
        )
    deadline = time.monotonic() + 4.0
    while time.monotonic() < deadline and _health_payload() is None:
        if _PROCESS and _PROCESS.poll() is not None:
            break
        time.sleep(0.1)
    payload = get_status("EveOS Notes started." if _health_payload() else "EveOS Notes is starting.")
    if _PROCESS and _PROCESS.poll() is not None and not payload["running"]:
        payload.update(ok=False, state="error", message="EveOS Notes exited before becoming ready.")
    return payload


def stop_server(*, persist: bool = True) -> dict:
    global _PROCESS
    with _LOCK:
        if persist:
            _write_desired_state(False)
        owned = _health_payload() is not None
        stopped = False
        if owned:
            for pid in _listener_pids():
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
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and _health_payload() is not None:
        time.sleep(0.1)
    payload = get_status("EveOS Notes stopped." if stopped else "EveOS Notes was already stopped.")
    if payload["running"]:
        payload.update(ok=False, state="error", message="EveOS Notes did not stop cleanly.")
    return payload


def restore_desired_state() -> None:
    if _read_desired_state():
        payload = start_server(persist=False)
        print(f"[Notes] {payload.get('message', 'Restore complete.')}")


def restore_desired_state_async() -> None:
    threading.Thread(target=restore_desired_state, name="eveos-notes-restore", daemon=True).start()


def handle_get_request(handler, path: str) -> bool:
    if path != "/api/notes-service/status":
        return False
    gemini_control.send_json(handler, get_status())
    return True


def handle_post_request(handler, path: str) -> bool:
    if path not in {"/api/notes-service/start", "/api/notes-service/stop"}:
        return False
    if not gemini_control.request_can_control(handler):
        gemini_control.send_json(handler, {
            "ok": False, "state": "forbidden", "running": False,
            "message": "Notes lifecycle control is limited to local EveOS pages.",
        }, 403)
        return True
    payload = start_server() if path.endswith("/start") else stop_server()
    gemini_control.send_json(handler, payload, 200 if payload.get("ok") else 500)
    return True
