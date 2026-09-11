"""Persisted lifecycle control for EveOS localhost surfaces."""

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

from . import eveos_ports


EVEOS_WEB_PORT = eveos_ports.service_port("EVEOS_WEB_PORT")
_PROCESS = None
_PROCESS_PORT = None
_LOCK = threading.RLock()
_TRUE = {"1", "true", "yes", "on"}


def headless_mode(service: str = "web") -> bool:
    """Whether a spawned server should hide its console. Headed unless asked otherwise."""
    from . import eveos_console_prefs
    return eveos_console_prefs.headless_for(service)


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _entry_point() -> Path:
    return _project_root() / "server" / "python-server.py"


def _preference_path() -> Path:
    return _project_root() / "data" / "runtime" / "eveos-web-service.json"


def _normalize_port(port=None) -> int:
    try:
        value = int(port if port is not None else EVEOS_WEB_PORT)
    except (TypeError, ValueError):
        return EVEOS_WEB_PORT
    return value if 1 <= value <= 65535 else EVEOS_WEB_PORT


def _read_preference() -> tuple[bool, int]:
    try:
        payload = json.loads(_preference_path().read_text(encoding="utf-8"))
        return payload.get("desiredRunning") is True, _normalize_port(payload.get("port"))
    except (OSError, ValueError, TypeError):
        return False, EVEOS_WEB_PORT


def _read_desired_state() -> bool:
    return _read_preference()[0]


def _read_desired_port() -> int:
    return _read_preference()[1]


def _write_desired_state(enabled: bool, port=None) -> None:
    target_port = _normalize_port(port)
    path = _preference_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(
        json.dumps(
            {
                "desiredRunning": bool(enabled),
                "port": target_port,
                "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            },
            indent=2,
        ),
        encoding="utf-8",
    )
    temporary.replace(path)


def _port_open(port=None) -> bool:
    target_port = _normalize_port(port)
    try:
        with socket.create_connection(("127.0.0.1", target_port), timeout=0.25):
            return True
    except OSError:
        return False


def _health_payload(port=None) -> dict | None:
    target_port = _normalize_port(port)
    connection = None
    try:
        connection = http.client.HTTPConnection("127.0.0.1", target_port, timeout=0.8)
        connection.request("GET", "/api/status", headers={"Connection": "close"})
        response = connection.getresponse()
        body = response.read(65536)
        if response.status != 200:
            return None
        payload = json.loads(body.decode("utf-8"))
        if payload.get("ok") is not True or payload.get("service") != "eveos-local-server":
            return None
        reported_port = int(payload.get("port") or target_port)
        if reported_port != target_port:
            return None
        return payload
    except (OSError, ValueError, TypeError, UnicodeError, http.client.HTTPException):
        return None
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass


def _listener_pids(port=None) -> list[int]:
    target_port = _normalize_port(port)
    if os.name == "nt":
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"],
            capture_output=True,
            text=True,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        marker = f":{target_port}"
        pids = set()
        for line in (result.stdout or "").splitlines():
            if marker not in line or "LISTENING" not in line.upper():
                continue
            fields = line.split()
            if fields and fields[-1].isdigit():
                pids.add(int(fields[-1]))
        return sorted(pids)

    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{target_port}", "-sTCP:LISTEN", "-t"],
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


def _status(message: str = "", port=None) -> dict:
    target_port = _normalize_port(port)
    health = _health_payload(target_port)
    process_alive = bool(
        _PROCESS
        and _PROCESS.poll() is None
        and _PROCESS_PORT == target_port
    )
    running = health is not None
    port_busy = _port_open(target_port) and not running
    installed = _entry_point().is_file()
    desired_enabled, desired_port = _read_preference()
    desired_running = desired_enabled and desired_port == target_port
    state = "running" if running else (
        "starting" if process_alive else ("blocked" if port_busy else "stopped")
    )
    return {
        "ok": not port_busy and installed,
        "controllerAvailable": True,
        "installed": installed,
        "state": state,
        "running": running,
        "desiredRunning": desired_running,
        "port": target_port,
        "url": f"http://127.0.0.1:{target_port}/EveOS.html",
        "pids": _listener_pids(target_port) if running else [],
        "message": message
        or (
            f"EveOS localhost is online on port {target_port}."
            if running
            else f"The EveOS web port {target_port} is occupied by another service."
            if port_busy
            else f"EveOS localhost is stopped on port {target_port}."
        ),
    }


def get_status(port=None) -> dict:
    with _LOCK:
        return _status(port=port)


def start_server(*, persist: bool = True, port=None) -> dict:
    global _PROCESS, _PROCESS_PORT
    target_port = _normalize_port(port)
    with _LOCK:
        if persist:
            _write_desired_state(True, target_port)

        current = _status(port=target_port)
        if current["running"]:
            current["message"] = f"EveOS localhost is already online on port {target_port}."
            return current
        if current["state"] == "blocked":
            current["ok"] = False
            return current

        entry = _entry_point()
        if not entry.is_file():
            return {
                **current,
                "ok": False,
                "state": "error",
                "message": f"EveOS server entry point was not found: {entry}",
            }

        log_root = _project_root() / "data" / "runtime" / "logs"
        log_root.mkdir(parents=True, exist_ok=True)
        environment = os.environ.copy()
        environment["PYTHONUNBUFFERED"] = "1"
        environment["PYTHONUTF8"] = "1"
        environment["PYTHONIOENCODING"] = "utf-8"
        environment["EVEOS_WEB_PORT"] = str(target_port)
        headless = headless_mode()
        flags = 0
        if os.name == "nt":
            flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            flags |= (
                getattr(subprocess, "CREATE_NO_WINDOW", 0)
                if headless
                else getattr(subprocess, "CREATE_NEW_CONSOLE", 0)
            )
        command = [sys.executable, str(entry), str(target_port), "--no-browser"]
        if headless:
            with (
                (log_root / "eveos-web.out.log").open("ab") as stdout_log,
                (log_root / "eveos-web.err.log").open("ab") as stderr_log,
            ):
                _PROCESS = subprocess.Popen(
                    command,
                    cwd=str(_project_root()),
                    stdin=subprocess.DEVNULL,
                    stdout=stdout_log,
                    stderr=stderr_log,
                    env=environment,
                    creationflags=flags,
                )
        else:
            _PROCESS = subprocess.Popen(
                command,
                cwd=str(_project_root()),
                stdin=subprocess.DEVNULL,
                env=environment,
                creationflags=flags,
            )
        _PROCESS_PORT = target_port

    deadline = time.monotonic() + 5.0
    while time.monotonic() < deadline:
        if _health_payload(target_port) is not None:
            break
        if _PROCESS and _PROCESS_PORT == target_port and _PROCESS.poll() is not None:
            break
        time.sleep(0.12)

    with _LOCK:
        healthy = _health_payload(target_port) is not None
        payload = _status(
            f"EveOS localhost started on port {target_port}."
            if healthy
            else f"EveOS localhost is starting on port {target_port}.",
            port=target_port,
        )
        if (
            _PROCESS
            and _PROCESS_PORT == target_port
            and _PROCESS.poll() is not None
            and not payload["running"]
        ):
            payload.update(
                ok=False,
                state="error",
                message=f"EveOS localhost exited before becoming ready on port {target_port}.",
            )
        return payload


def stop_server(*, persist: bool = True, port=None) -> dict:
    global _PROCESS, _PROCESS_PORT
    target_port = _normalize_port(port)
    with _LOCK:
        if persist:
            _write_desired_state(False, target_port)
        verified_server = _health_payload(target_port) is not None
        stopped = False

        # Never terminate an unknown listener merely because it owns the requested port.
        if verified_server:
            for pid in _listener_pids(target_port):
                stopped = _terminate_pid(pid) or stopped

        if _PROCESS_PORT == target_port and _PROCESS and _PROCESS.poll() is None:
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
        if _PROCESS_PORT == target_port:
            _PROCESS = None
            _PROCESS_PORT = None

    deadline = time.monotonic() + 2.5
    while time.monotonic() < deadline and _health_payload(target_port) is not None:
        time.sleep(0.1)

    with _LOCK:
        payload = _status(
            f"EveOS localhost stopped on port {target_port}."
            if stopped
            else f"EveOS localhost was already stopped on port {target_port}.",
            port=target_port,
        )
        if payload["running"]:
            payload.update(
                ok=False,
                state="error",
                message=f"EveOS localhost did not stop cleanly on port {target_port}.",
            )
        return payload


def restore_desired_state() -> None:
    desired, port = _read_preference()
    if not desired:
        return
    payload = start_server(persist=False, port=port)
    print(f"[EveOS Web] {payload.get('message', 'Restore complete.')}")


def restore_desired_state_async() -> None:
    threading.Thread(
        target=restore_desired_state,
        name="eveos-web-restore",
        daemon=True,
    ).start()
