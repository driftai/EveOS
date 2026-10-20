"""Loopback-safe lifecycle control for the bundled Bookmark Intel knowledge base."""

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


BOOKMARK_INTEL_PORT = eveos_ports.service_port("BOOKMARK_INTEL_PORT")
_PROCESS = None
_LOCK = threading.RLock()


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _tool_root() -> Path:
    return _project_root() / "tools" / "Bookmark-Intel"


def _entry_point() -> Path:
    return _tool_root() / "server.py"


def _preference_path() -> Path:
    return _project_root() / "data" / "runtime" / "bookmark-intel-service.json"


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
        "port": BOOKMARK_INTEL_PORT,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, indent=2), encoding="utf-8")
    temporary.replace(path)


def _port_open() -> bool:
    """Report whether the exact loopback port is bound without connecting to it."""
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", BOOKMARK_INTEL_PORT))
        return False
    except OSError:
        return True


def _health_payload() -> dict | None:
    connection = None
    try:
        connection = http.client.HTTPConnection("127.0.0.1", BOOKMARK_INTEL_PORT, timeout=0.8)
        connection.request("GET", "/api/health", headers={"Connection": "close"})
        response = connection.getresponse()
        payload = json.loads(response.read(65536).decode("utf-8"))
        if response.status == 200 and payload.get("ok") is True and payload.get("service") == "bookmark-intel":
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


def _listener_pids() -> list[int]:
    if os.name == "nt":
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        marker = f":{BOOKMARK_INTEL_PORT}"
        return sorted({int(line.split()[-1]) for line in result.stdout.splitlines()
                       if marker in line and "LISTENING" in line.upper() and line.split()[-1].isdigit()})
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{BOOKMARK_INTEL_PORT}", "-sTCP:LISTEN", "-t"],
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


def _status(message: str = "", *, verified_health: dict | None = None) -> dict:
    # Reuse a successful health observation during startup. An immediate
    # second probe can fail transiently after the service already answered 200.
    health = verified_health if verified_health is not None else _health_payload()
    process_alive = bool(_PROCESS and _PROCESS.poll() is None)
    running = health is not None
    port_busy = _port_open() and not running
    installed = _entry_point().is_file()
    state = "running" if running else ("starting" if process_alive else ("blocked" if port_busy else "stopped"))
    return {
        "ok": installed and not port_busy,
        "controllerAvailable": True,
        "installed": installed,
        "state": state,
        "running": running,
        "desiredRunning": _read_desired_state(),
        "port": BOOKMARK_INTEL_PORT,
        "url": f"http://127.0.0.1:{BOOKMARK_INTEL_PORT}/",
        "appVersion": health.get("appVersion", "") if health else "",
        "pids": _listener_pids() if running else [],
        "message": message or (
            "Bookmark Intel is online." if running
            else "Bookmark Intel port is occupied by another service." if port_busy
            else "Bookmark Intel is stopped."
        ),
    }


def get_status() -> dict:
    with _LOCK:
        return _status()


def _launch_command() -> list[str]:
    if os.name == "nt":
        return ["cmd.exe", "/d", "/c", str(_tool_root() / "EVEOS.bat")]
    venv_python = _tool_root() / ".venv" / "bin" / "python"
    python = str(venv_python if venv_python.is_file() else Path(sys.executable))
    return [python, str(_entry_point()), "--serve", "--host", "127.0.0.1", "--port", str(BOOKMARK_INTEL_PORT)]


def start_server(*, persist: bool = True) -> dict:
    global _PROCESS
    with _LOCK:
        if persist:
            _write_desired_state(True)
        current = _status()
        if current["running"]:
            return {**current, "message": "Bookmark Intel is already online."}
        if current["state"] == "blocked":
            return {**current, "ok": False}
        if not _entry_point().is_file():
            return {**current, "ok": False, "state": "error", "message": "Bookmark Intel is not installed."}
        environment = os.environ.copy()
        environment.update({
            "BOOKMARK_INTEL_PORT": str(BOOKMARK_INTEL_PORT),
            "BOOKMARK_INTEL_DATA_DIR": str(_project_root() / "data" / "bookmark-intel"),
            "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
        })
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        headless = eveos_console_prefs.headless_for("bookmarkIntel")
        flags |= getattr(subprocess, "CREATE_NO_WINDOW" if headless else "CREATE_NEW_CONSOLE", 0)
        sink = subprocess.DEVNULL if headless else None
        _PROCESS = subprocess.Popen(
            _launch_command(), cwd=str(_tool_root()), stdin=subprocess.DEVNULL,
            stdout=sink, stderr=sink, env=environment, creationflags=flags,
        )
    deadline = time.monotonic() + 12
    health = None
    while time.monotonic() < deadline and _PROCESS.poll() is None:
        health = _health_payload()
        if health is not None:
            break
        time.sleep(0.15)
    with _LOCK:
        payload = _status(
            "Bookmark Intel started." if health else "Bookmark Intel is starting; first setup can take a few minutes.",
            verified_health=health,
        )
        if _PROCESS.poll() is not None and not payload["running"]:
            payload.update(ok=False, state="error", message="Bookmark Intel exited before becoming ready.")
        return payload


def stop_server(*, persist: bool = True) -> dict:
    global _PROCESS
    with _LOCK:
        if persist:
            _write_desired_state(False)
        owned = _health_payload() is not None
        # Health can transiently time out while the known port is listening.
        # Only terminate a listener after verifying our service identity.
        if not owned and _port_open():
            deadline = time.monotonic() + 2
            while time.monotonic() < deadline and not owned:
                time.sleep(0.15)
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
                pass
        _PROCESS = None
    # Windows may exit the cmd.exe wrapper before the Uvicorn listener
    # releases 9077. A stopped reply requires actual port release.
    deadline = time.monotonic() + 6
    while True:
        result = _status("Bookmark Intel stopped." if stopped else "Bookmark Intel was already stopped.")
        if not result["running"] and not _port_open():
            return result
        if time.monotonic() >= deadline:
            return {**result, "ok": False, "state": "blocked",
                    "message": "Bookmark Intel shutdown unconfirmed; inspect port ownership before retrying."}
        time.sleep(0.15)


def restore_desired_state_async() -> None:
    if os.environ.get("EVEOS_SCOPED_RESTART") == "1":
        return
    if _read_desired_state():
        threading.Thread(target=lambda: start_server(persist=False), name="eveos-bookmark-intel-restore", daemon=True).start()


def handle_get_request(handler, path: str) -> bool:
    if path != "/api/bookmark-intel/status":
        return False
    gemini_control.send_json(handler, get_status())
    return True


def handle_post_request(handler, path: str) -> bool:
    if path not in {"/api/bookmark-intel/start", "/api/bookmark-intel/stop"}:
        return False
    if not gemini_control.request_can_control(handler):
        gemini_control.send_json(handler, {"ok": False, "state": "forbidden", "running": False,
                                           "message": "Bookmark Intel control is limited to local EveOS pages."}, 403)
        return True
    action = start_server if path.endswith("/start") else stop_server
    payload = action()
    gemini_control.send_json(handler, payload, 200 if payload.get("ok") else 500)
    return True