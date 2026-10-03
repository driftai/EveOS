"""Lifecycle control for the EveOS-integrated Nexus Browser runtime."""

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

from . import eveos_console_prefs, eveos_ports


NEXUS_BROWSER_PORT = eveos_ports.service_port("NEXUS_BROWSER_PORT")
_PROCESS = None
_LOCK = threading.RLock()


def _root() -> Path:
    return Path(__file__).resolve().parent.parent


def _tool_root() -> Path:
    return _root() / "tools" / "Nexus-Browser"


def _runtime_root() -> Path:
    return _root() / "data" / "runtime" / "nexus-browser"


def _entry() -> Path:
    return _tool_root() / "scripts" / "bridge-supervisor.js"


def _pid_path() -> Path:
    return _runtime_root() / "supervisor.pid"


def _node() -> str | None:
    return shutil.which("node")


def _npm() -> str | None:
    return shutil.which("npm.cmd") or shutil.which("npm") if os.name == "nt" else shutil.which("npm")


def _deps_ready() -> bool:
    return (_tool_root() / "node_modules" / "ws" / "package.json").is_file()


def _extension_ready() -> bool:
    extension = _tool_root() / "extension"
    return (extension / "manifest.json").is_file() and (extension / "service-worker-entry.js").is_file()


def _http_json(path: str, timeout=0.8) -> dict | None:
    connection = None
    try:
        connection = http.client.HTTPConnection("127.0.0.1", NEXUS_BROWSER_PORT, timeout=timeout)
        connection.request("GET", path, headers={"Connection": "close"})
        response = connection.getresponse()
        payload = json.loads(response.read(256_000).decode("utf-8"))
        return payload if response.status == 200 and isinstance(payload, dict) else None
    except (OSError, ValueError, UnicodeError, http.client.HTTPException):
        return None
    finally:
        if connection:
            try:
                connection.close()
            except OSError:
                pass


def _health() -> dict | None:
    payload = _http_json("/health")
    return payload if payload and payload.get("ok") is True and payload.get("service") == "eveos-nexus-browser" else None


def _port_open() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", NEXUS_BROWSER_PORT), timeout=0.25):
            return True
    except OSError:
        return False


def _read_pid() -> int | None:
    try:
        pid = int(_pid_path().read_text(encoding="ascii").strip())
        return pid if pid > 1 else None
    except (OSError, ValueError):
        return None


def _write_pid(pid: int) -> None:
    path = _pid_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(str(pid), encoding="ascii")
    temporary.replace(path)


def _process_command_line(pid: int) -> str:
    if pid <= 1:
        return ""
    try:
        if os.name == "nt":
            command = (
                f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' "
                "-ErrorAction SilentlyContinue; if($p){$p.CommandLine}"
            )
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, check=False, timeout=4,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            return result.stdout.strip()
        return (Path("/proc") / str(pid) / "cmdline").read_bytes().replace(b"\0", b" ").decode()
    except (OSError, subprocess.SubprocessError, UnicodeError):
        return ""

def _process_parent_pid(pid: int) -> int | None:
    if pid <= 1:
        return None
    try:
        if os.name == "nt":
            command = (
                f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId = {pid}' "
                "-ErrorAction SilentlyContinue; if($p){$p.ParentProcessId}"
            )
            result = subprocess.run(
                ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", command],
                capture_output=True, text=True, check=False, timeout=4,
                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            value = result.stdout.strip()
            return int(value) if value.isdigit() else None
        status = (Path("/proc") / str(pid) / "status").read_text(encoding="utf-8", errors="ignore")
        for line in status.splitlines():
            if line.startswith("PPid:"):
                value = line.split(":", 1)[1].strip()
                return int(value) if value.isdigit() else None
    except (OSError, ValueError, subprocess.SubprocessError, UnicodeError):
        pass
    return None



def _managed_pid() -> int | None:
    pid = _read_pid()
    command = _process_command_line(pid or 0).lower()
    if not pid or not command or "bridge-supervisor.js" not in command:
        return None
    root = str(_tool_root().resolve()).lower()
    if root in command:
        return pid

    # START.bat launches the supervisor from the Nexus cwd with a relative script
    # path (node scripts\bridge-supervisor.js). Prove ownership through the live
    # listener child instead of rejecting that legitimate supervisor.
    for listener_pid in _listener_pids():
        child_command = _process_command_line(listener_pid).lower()
        if (_process_parent_pid(listener_pid) == pid and root in child_command
                and "server.js" in child_command):
            return pid
    return None


def _listener_pids() -> list[int]:
    if os.name == "nt":
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        marker = f":{NEXUS_BROWSER_PORT}"
        return sorted({
            int(parts[-1]) for line in (result.stdout or "").splitlines()
            if marker in line and "LISTENING" in line.upper()
            if (parts := line.split()) and parts[-1].isdigit()
        })
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{NEXUS_BROWSER_PORT}", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True, check=False,
    )
    return sorted({int(value) for value in result.stdout.split() if value.isdigit()})


def _owned_listener_pid(supervisor_pid: int | None) -> int | None:
    if not supervisor_pid:
        return None
    root = str(_tool_root().resolve()).lower()
    for listener_pid in _listener_pids():
        command = _process_command_line(listener_pid).lower()
        if (_process_parent_pid(listener_pid) == supervisor_pid
                and root in command and "server.js" in command):
            return listener_pid
    return None


def _status(message="") -> dict:
    health = _health()
    pid = _managed_pid()
    owned_listener = _owned_listener_pid(pid)
    process_alive = bool((_PROCESS and _PROCESS.poll() is None) or pid)
    running = health is not None or owned_listener is not None
    diagnostics = (_http_json("/diagnostics", timeout=1.2) or {}) if running else {}
    blocked = _port_open() and not running
    installed = (_tool_root() / "server.js").is_file() and _entry().is_file()
    node_ready, npm_ready = _node() is not None, _npm() is not None
    deps_ready = _deps_ready() if installed else False
    state = "running" if running else "starting" if process_alive else "blocked" if blocked else "stopped"
    return {
        "ok": installed and node_ready and not blocked,
        "controllerAvailable": True,
        "service": "nexus-browser-control",
        "state": state,
        "running": running,
        "owned": pid is not None,
        "onDemand": True,
        "installed": installed,
        "nodeReady": node_ready,
        "npmReady": npm_ready,
        "dependenciesReady": deps_ready,
        "setupRequired": installed and not deps_ready,
        "setupAvailable": installed and npm_ready and not deps_ready,
        "extensionReady": _extension_ready(),
        "extensionPath": str((_tool_root() / "extension").resolve()),
        "port": NEXUS_BROWSER_PORT,
        "url": f"http://127.0.0.1:{NEXUS_BROWSER_PORT}/",
        "pids": [owned_listener] if owned_listener else (_listener_pids() if running else []),
        "supervisorPid": pid,
        "extensionConnected": diagnostics.get("extensionConnected") is True,
        "dexUiConnected": diagnostics.get("dexUiConnected") is True,
        "onlineTargets": int(diagnostics.get("onlineTargets") or 0),
        "localTargets": int(diagnostics.get("localTargets") or 0),
        "appTargets": int(diagnostics.get("appTargets") or 0),
        "appBinding": diagnostics.get("appBinding") or {"connected": False},
        "dexRooms": int(diagnostics.get("dexRooms") or 0),
        "extensionSessions": diagnostics.get("extensionSessions") or {
            "connected": 0, "primaryReady": False, "primaryTabs": None, "standby": [],
        },
        "message": message or (
            "Nexus Browser is online." if health else
            "Nexus Browser is online; health probe is recovering." if owned_listener else
            f"Port {NEXUS_BROWSER_PORT} belongs to a different service." if blocked else
            "Nexus Browser source is missing from tools/Nexus-Browser." if not installed else
            "Node.js is required for Nexus Browser." if not node_ready else
            "Install Nexus Browser's locked dependency before starting it." if not deps_ready else
            "Nexus Browser is installed and ready to start on demand."
        ),
    }


def get_status() -> dict:
    with _LOCK:
        return _status()


def setup_runtime() -> dict:
    with _LOCK:
        current = _status()
        if current["running"]:
            return {**current, "message": "Nexus Browser is already online."}
        npm = _npm()
        if not current["installed"] or not npm:
            return {**current, "ok": False, "state": "error"}
    try:
        result = subprocess.run(
            [npm, "ci", "--omit=dev", "--no-audit", "--no-fund"], cwd=str(_tool_root()),
            capture_output=True, text=True, check=False, timeout=10 * 60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {**_status(), "ok": False, "state": "error", "message": f"Nexus Browser setup failed: {exc}"}
    if result.returncode != 0:
        detail = "\n".join((result.stderr or result.stdout or "").splitlines()[-12:])
        return {**_status(), "ok": False, "state": "error", "message": f"Nexus Browser setup failed.\n{detail}".strip()}
    return _status("Nexus Browser dependency installed. Press Start when ready.")


def start_server() -> dict:
    global _PROCESS
    with _LOCK:
        current = _status()
        if current["running"]:
            return {**current, "message": "Nexus Browser is already online."}
        if current["state"] == "blocked" or not current["installed"] or not current["dependenciesReady"]:
            return {**current, "ok": False}
        environment = os.environ.copy()
        environment.update({
            "HOST": "127.0.0.1",
            "PORT": str(NEXUS_BROWSER_PORT),
            "NEXUS_BROWSER_PORT": str(NEXUS_BROWSER_PORT),
            "NEXUS_BROWSER_DATA_DIR": str(_runtime_root()),
            "BROWSER_AI_BRIDGE_DATA_DIR": str(_runtime_root()),
            "EVEOS_INTEGRATED": "1",
        })
        headless = eveos_console_prefs.headless_for("nexusBrowser")
        flags = 0
        if os.name == "nt":
            flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            flags |= getattr(subprocess, "CREATE_NO_WINDOW" if headless else "CREATE_NEW_CONSOLE", 0)
        _PROCESS = subprocess.Popen(
            [_node(), str(_entry())], cwd=str(_tool_root()), stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL if headless else None,
            stderr=subprocess.DEVNULL if headless else None,
            env=environment, creationflags=flags,
        )
        _write_pid(_PROCESS.pid)
    deadline = time.monotonic() + 12.0
    while time.monotonic() < deadline and _health() is None:
        if _PROCESS and _PROCESS.poll() is not None:
            break
        time.sleep(0.15)
    with _LOCK:
        payload = _status("Nexus Browser started." if _health() else "Nexus Browser is starting.")
        if _PROCESS and _PROCESS.poll() is not None and not payload["running"]:
            payload.update(ok=False, state="error", message="Nexus Browser exited before becoming ready.")
        return payload


def _terminate(pid: int) -> bool:
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, text=True,
                check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
        else:
            os.kill(pid, signal.SIGTERM)
    except OSError:
        return False
    deadline = time.monotonic() + 4.0
    while time.monotonic() < deadline:
        if not _process_command_line(pid) and _health() is None:
            return True
        time.sleep(0.1)
    return False


def stop_server() -> dict:
    global _PROCESS
    with _LOCK:
        running, pid = _health() is not None, _managed_pid()
        if running and pid is None:
            return {**_status(), "ok": False, "state": "external",
                    "message": "Refusing to stop a Nexus Browser runtime not owned by this EveOS checkout."}
        stopped = _terminate(pid) if pid else False
        _PROCESS = None
        _pid_path().unlink(missing_ok=True)
    payload = _status("Nexus Browser stopped." if stopped else "Nexus Browser was already stopped.")
    if payload["running"]:
        payload.update(ok=False, state="error", message="Nexus Browser did not stop cleanly.")
    return payload


def open_extension_folder() -> dict:
    folder = (_tool_root() / "extension").resolve()
    if not folder.is_dir():
        return {**_status(), "ok": False, "state": "error", "message": "Nexus Browser extension source is missing."}
    try:
        if os.name == "nt":
            os.startfile(str(folder))  # type: ignore[attr-defined]
        elif sys.platform == "darwin":
            subprocess.Popen(["open", str(folder)])
        else:
            subprocess.Popen(["xdg-open", str(folder)])
    except (OSError, subprocess.SubprocessError) as exc:
        return {**_status(), "ok": False, "state": "error", "message": f"Could not open extension folder: {exc}"}
    return {**_status(), "message": "Nexus Browser extension folder opened for Load unpacked."}


def restore_desired_state_async() -> None:
    """Nexus Browser is explicitly on-demand and is never restored at EveOS boot."""
    return
