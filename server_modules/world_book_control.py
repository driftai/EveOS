"""Persisted, loopback-safe lifecycle control for the bundled World Book tool."""

from __future__ import annotations

import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

from . import eveos_exposure, eveos_ports, gemini_control


WORLD_BOOK_PORT = eveos_ports.service_port("WORLD_BOOK_PORT")
_PROCESS = None
_LOCK = threading.RLock()


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _tool_root() -> Path:
    return _project_root() / "tools" / "World-Book"


def _entry_point() -> Path:
    return _tool_root() / "server.py"


def _launcher_path() -> Path:
    return _tool_root() / "launch.ps1"


def _preference_path() -> Path:
    return _project_root() / "data" / "runtime" / "world-book-service.json"


def _read_desired_state() -> bool:
    try:
        payload = json.loads(_preference_path().read_text(encoding="utf-8"))
        return payload.get("desiredRunning") is True
    except (OSError, ValueError, TypeError):
        return False


def _write_desired_state(enabled: bool) -> None:
    path = _preference_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(
            {
                "desiredRunning": bool(enabled),
                "port": WORLD_BOOK_PORT,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    temporary.replace(path)


def _port_open() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", WORLD_BOOK_PORT), timeout=0.25):
            return True
    except OSError:
        return False


def _health_payload() -> dict | None:
    for endpoint in ("/api/health", "/api/config"):
        connection = None
        try:
            connection = http.client.HTTPConnection("127.0.0.1", WORLD_BOOK_PORT, timeout=0.7)
            connection.request("GET", endpoint, headers={"Connection": "close"})
            response = connection.getresponse()
            body = response.read(65536)
            if response.status != 200:
                continue
            payload = json.loads(body.decode("utf-8"))
            if payload.get("ok") is not True or not payload.get("appVersion"):
                continue
            if endpoint == "/api/health" and payload.get("service") != "world-book":
                continue
            return payload
        except (OSError, ValueError, UnicodeError):
            continue
        finally:
            if connection is not None:
                try:
                    connection.close()
                except OSError:
                    pass
    return None


def _powershell() -> str | None:
    return shutil.which("powershell.exe") or shutil.which("powershell")


def _launch_command(entry: Path) -> list[str]:
    launcher = _launcher_path()
    canonical_entry = _tool_root() / "server.py"
    powershell = _powershell()
    if os.name == "nt" and powershell and launcher.is_file() and entry.resolve() == canonical_entry.resolve():
        return [
            powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(launcher),
            "-Port", str(WORLD_BOOK_PORT), "-ExposureMode", "local", "-NoBrowser",
        ]
    return [
        sys.executable, str(entry), "--host", "127.0.0.1",
        "--port", str(WORLD_BOOK_PORT), "--no-browser",
    ]


def _listener_pids() -> list[int]:
    if os.name == "nt":
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        marker = f":{WORLD_BOOK_PORT}"
        pids = set()
        for line in (result.stdout or "").splitlines():
            if marker not in line or "LISTENING" not in line.upper():
                continue
            fields = line.split()
            if fields and fields[-1].isdigit():
                pids.add(int(fields[-1]))
        return sorted(pids)

    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{WORLD_BOOK_PORT}", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True, check=False,
    )
    return sorted({int(value) for value in result.stdout.split() if value.isdigit()})


def _terminate_pid(pid: int) -> bool:
    if pid <= 0 or pid == os.getpid():
        return False
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True,
                text=True, check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return result.returncode == 0
        os.kill(pid, signal.SIGTERM)
        return True
    except OSError:
        return False


def _status(message: str = "") -> dict:
    health = _health_payload()
    process_alive = bool(_PROCESS and _PROCESS.poll() is None)
    running = health is not None
    port_busy = _port_open() and not running
    installed = _entry_point().is_file()
    state = "running" if running else ("starting" if process_alive else ("blocked" if port_busy else "stopped"))
    local_url = f"http://127.0.0.1:{WORLD_BOOK_PORT}/"
    payload = {
        "ok": not port_busy and installed,
        "controllerAvailable": True,
        "installed": installed,
        "state": state,
        "running": running,
        "desiredRunning": _read_desired_state(),
        "port": WORLD_BOOK_PORT,
        "appVersion": health.get("appVersion", "") if health else "",
        "pids": _listener_pids() if running else [],
        "message": message or (
            "World Book is online." if running
            else "World Book port is occupied by another service." if port_busy
            else "World Book is stopped."
        ),
    }
    return eveos_exposure.decorate_status(payload, "world-book", local_url)


def open_launcher() -> dict:
    with _LOCK:
        current = _status()
        launcher = _launcher_path()
        powershell = _powershell()
        if current["running"]:
            return {**current, "message": "World Book is already online. Stop it before changing exposure mode."}
        if os.name != "nt" or not powershell:
            return {**current, "ok": False, "message": "The interactive World Book exposure launcher currently requires Windows PowerShell."}
        if not launcher.is_file():
            return {**current, "ok": False, "message": f"World Book launcher missing: {launcher}"}
        try:
            subprocess.Popen(
                [powershell, "-NoExit", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(launcher),
                 "-Port", str(WORLD_BOOK_PORT)],
                cwd=str(_tool_root()), creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
            )
        except OSError as exc:
            return {**current, "ok": False, "message": f"Could not open World Book selective boot: {exc}"}
        return {**current, "ok": True, "state": "selecting", "launchPrompt": True,
                "message": "World Book selective boot opened. Choose Localhost, LAN, or Cloudflare Router in the terminal."}


def get_status() -> dict:
    with _LOCK:
        return _status()


def start_server(*, persist: bool = True) -> dict:
    """Programmatic lifecycle is local-only; interactive exposure uses open_launcher()."""
    global _PROCESS
    eveos_exposure.clear_state("world-book")
    with _LOCK:
        if persist:
            _write_desired_state(True)

        current = _status()
        if current["running"]:
            current["message"] = "World Book is already online."
            return current
        if current["state"] == "blocked":
            current["ok"] = False
            return current

        entry = _entry_point()
        if not entry.is_file():
            return {**current, "ok": False, "state": "error", "message": f"World Book entry point was not found: {entry}"}

        flags = 0
        if os.name == "nt":
            flags = getattr(subprocess, "CREATE_NO_WINDOW", 0) | getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        environment = os.environ.copy()
        environment["PYTHONUNBUFFERED"] = "1"
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        _PROCESS = subprocess.Popen(
            _launch_command(entry), cwd=str(entry.parent), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=environment, creationflags=flags,
        )

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if _health_payload() is not None:
            break
        if _PROCESS and _PROCESS.poll() is not None:
            break
        time.sleep(0.1)

    with _LOCK:
        payload = _status("World Book started locally." if _health_payload() else "World Book is starting locally.")
        if _PROCESS and _PROCESS.poll() is not None and not payload["running"]:
            payload.update(ok=False, state="error", message="World Book exited before becoming ready.")
        return payload


def stop_server(*, persist: bool = True) -> dict:
    global _PROCESS
    with _LOCK:
        if persist:
            _write_desired_state(False)
        was_world_book = _health_payload() is not None
        stopped = False

        if was_world_book:
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

    eveos_exposure.clear_state("world-book")
    deadline = time.monotonic() + 2.0
    while time.monotonic() < deadline and _health_payload() is not None:
        time.sleep(0.1)

    with _LOCK:
        payload = _status("World Book stopped." if stopped else "World Book was already stopped.")
        if payload["running"]:
            payload.update(ok=False, state="error", message="World Book did not stop cleanly.")
        return payload


def restore_desired_state() -> None:
    if not _read_desired_state():
        return
    payload = start_server(persist=False)
    print(f"[World Book] {payload.get('message', 'Restore complete.')}")


def restore_desired_state_async() -> None:
    threading.Thread(target=restore_desired_state, name="eveos-world-book-restore", daemon=True).start()


def handle_get_request(handler, path: str) -> bool:
    if path != "/api/world-book/status":
        return False
    gemini_control.send_json(handler, get_status())
    return True


def handle_post_request(handler, path: str) -> bool:
    if path not in {"/api/world-book/start", "/api/world-book/stop", "/api/world-book/launch"}:
        return False
    if not gemini_control.request_can_control(handler):
        gemini_control.send_json(
            handler,
            {"ok": False, "controllerAvailable": True, "state": "forbidden", "running": False,
             "message": "World Book control is limited to local EveOS pages."},
            403,
        )
        return True
    if path.endswith("/launch"):
        payload = open_launcher()
    else:
        action = start_server if path.endswith("/start") else stop_server
        payload = action()
    gemini_control.send_json(handler, payload, 200 if payload.get("ok") else 500)
    return True
