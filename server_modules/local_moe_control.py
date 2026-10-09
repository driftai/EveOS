"""EveOS-owned lifecycle bridge for the bundled generic Local MoE Harness."""

from __future__ import annotations

import http.client
import json
import os
import signal
import socket
import subprocess
import threading
import time
import webbrowser
from pathlib import Path

from . import eveos_console_prefs, eveos_ports, local_moe_runtime_bootstrap


HARNESS_PORT = eveos_ports.service_port("LOCAL_MOE_HARNESS_PORT")
RUNTIME_PORT = eveos_ports.service_port("FREETOKEN_PORT")
_PROCESS = None
_LOCK = threading.RLock()
_UNSET = object()
_STATUS_GRACE = local_moe_runtime_bootstrap.StatusGraceCache(8.0)


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _tool_root() -> Path:
    return _project_root() / "tools" / "Local-MoE-Harness"


def _pid_path() -> Path:
    return _tool_root() / "state" / "harness.pid"


def _runtime_pid_path() -> Path:
    return _tool_root() / "state" / "freetoken.pid"


def _setup_ready() -> bool:
    executable = _tool_root() / ".venv" / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    return executable.is_file()


def _read_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, ValueError, TypeError):
        return {}
    return payload if isinstance(payload, dict) else {}


def _configured_model() -> dict:
    catalog = _read_json(_tool_root() / "config" / "models.json")
    selection = _read_json(_tool_root() / "state" / "selected-model.json")
    selected_id = str(selection.get("model_id") or catalog.get("default_model_id") or "")
    for record in catalog.get("models") or []:
        if isinstance(record, dict) and record.get("id") == selected_id:
            return {
                "id": selected_id,
                "label": str(record.get("display_name") or selected_id),
                "validation": str(record.get("validation") or ""),
            }
    return {"id": selected_id, "label": selected_id, "validation": ""}


def _port_open(port: int) -> bool:
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
            probe.bind(("127.0.0.1", port))
        return False
    except OSError:
        return True


def _http_json(port: int, path: str, *, method: str = "GET", timeout: float = 1.2) -> dict | None:
    connection = None
    try:
        connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout)
        connection.request(method, path, body=b"" if method != "GET" else None,
                           headers={"Connection": "close", "Content-Length": "0"})
        response = connection.getresponse()
        payload = json.loads(response.read(2_000_000).decode("utf-8"))
        return payload if response.status < 400 and isinstance(payload, dict) else None
    except (OSError, ValueError, UnicodeError):
        return None
    finally:
        if connection is not None:
            try:
                connection.close()
            except OSError:
                pass


def _harness_health() -> dict | None:
    payload = _http_json(HARNESS_PORT, "/openapi.json", timeout=0.45)
    info = payload.get("info") if payload else None
    return payload if isinstance(info, dict) and info.get("title") == "Local MoE Harness" else None


def _read_pid(path: Path) -> int | None:
    try:
        pid = int(path.read_text(encoding="ascii").strip())
    except (OSError, ValueError):
        return None
    return pid if pid > 1 else None


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


def _owned_pid(path: Path, markers: tuple[str, ...]) -> int | None:
    pid = _read_pid(path)
    command = _process_command_line(pid or 0).lower()
    root = str(_tool_root().resolve()).lower()
    if not command or root not in command:
        return None
    return pid if any(marker.lower() in command for marker in markers) else None


def _managed_harness_pid() -> int | None:
    return _owned_pid(_pid_path(), ("run-harness-windows.ps1", "run-harness.sh", "uvicorn", "app.main"))


def _managed_runtime_pid() -> int | None:
    return _owned_pid(
        _runtime_pid_path(),
        (
            "run-freetoken-windows.ps1",
            "run-freetoken.sh",
            "windows-freetoken-entry.py",
            "freetoken",
            "run-prism-llama-windows.ps1",
            "llama-server.exe",
        ),
    )


def _live_details() -> dict:
    return local_moe_runtime_bootstrap.live_details(_http_json, HARNESS_PORT)


def _status(message: str = "", *, health=_UNSET, harness_pid=_UNSET) -> dict:
    installed = (_tool_root() / "app" / "main.py").is_file()
    if health is _UNSET:
        health = _harness_health()
    if harness_pid is _UNSET:
        harness_pid = _managed_harness_pid()
    running = health is not None
    process_alive = bool((_PROCESS and _PROCESS.poll() is None) or harness_pid)
    # A single missed health response must not relabel our verified process as a
    # foreign service while the model is loading or the bridge is resyncing.
    harness_conflict = _port_open(HARNESS_PORT) and not running and harness_pid is None
    runtime_conflict = _port_open(RUNTIME_PORT) and not running and _managed_runtime_pid() is None
    blocked = harness_conflict or runtime_conflict
    state = "running" if running else ("blocked" if blocked else ("starting" if process_alive else "stopped"))
    details = _live_details() if running else {
        "runtimeReady": False,
        "runtimeReachable": _port_open(RUNTIME_PORT) and not runtime_conflict,
        "runtimeHealth": "offline",
        "runtimeManagedRunning": False,
        "runtimeStartupStage": "stopped",
        "runtimeLastError": "",
        "activeModel": _configured_model(),
        "activeProfile": "",
        "system": {},
        "gpuCoexistence": {},
    }
    if message:
        status_message = message
    elif harness_conflict:
        status_message = f"Port {HARNESS_PORT} is occupied by a different service."
    elif runtime_conflict:
        status_message = f"Runtime port {RUNTIME_PORT} is occupied by an unowned process."
    elif running and harness_pid:
        status_message = "Local MoE Harness is online and managed by EveOS."
    elif running:
        status_message = "Local MoE Harness is online but was not started by this EveOS checkout."
    elif process_alive:
        status_message = "Local MoE Harness is starting or temporarily resynchronizing."
    elif not _setup_ready():
        status_message = "Local MoE Harness is installed but needs its local runtime setup."
    else:
        status_message = "Local MoE Harness is stopped. Start is always explicit."
    return {
        "ok": installed and not blocked,
        "controllerAvailable": True,
        "installed": installed,
        "setupReady": _setup_ready(),
        "state": state,
        "running": running,
        "owned": harness_pid is not None,
        "explicitStartRequired": True,
        "port": HARNESS_PORT,
        "runtimePort": RUNTIME_PORT,
        "url": f"http://127.0.0.1:{HARNESS_PORT}/",
        "message": status_message,
        **details,
    }


def get_status() -> dict:
    with _LOCK:
        health = _harness_health()
        # Healthy service identity is sufficient for read-only liveness. Windows CIM
        # ownership verification can take several seconds and must not sit on the
        # Search Monitor status path. Destructive lifecycle actions still call the
        # verified _managed_harness_pid() path before terminating anything.
        if health is not None:
            managed_pid = (
                _PROCESS.pid
                if _PROCESS is not None and _PROCESS.poll() is None
                else None
            )
            return _STATUS_GRACE.remember(_status(health=health, harness_pid=managed_pid))
        stale = _STATUS_GRACE.recover(_port_open(HARNESS_PORT))
        if stale is not None:
            return stale
        return _status(health=None)


def _launch_command() -> list[str]:
    if os.name == "nt":
        return [
            "powershell.exe", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
            "-File", str(_tool_root() / "scripts" / "run-harness-windows.ps1"),
        ]
    return [str(_tool_root() / "scripts" / "run-harness.sh")]


def _start_runtime_for_explicit_request(status: dict) -> dict:
    return local_moe_runtime_bootstrap.start_runtime_for_explicit_request(
        status,
        http_json=_http_json,
        harness_port=HARNESS_PORT,
        refresh_status=_status,
    )


def start_server(*, start_runtime: bool = True) -> dict:
    global _PROCESS
    with _LOCK:
        current = _status()
        if current["running"]:
            return _start_runtime_for_explicit_request(current) if start_runtime else current
        if current["state"] == "blocked":
            return {**current, "ok": False}
        if not current["setupReady"]:
            return {**current, "ok": False, "state": "needs-setup",
                    "message": "Run Local MoE Setup before starting the Harness."}
        environment = os.environ.copy()
        environment.update({
            "LOCAL_MOE_HARNESS_PORT": str(HARNESS_PORT),
            "FREETOKEN_PORT": str(RUNTIME_PORT),
            # Keep Harness startup passive at the FastAPI lifespan layer. The
            # explicit EveOS Start action requests the selected model below,
            # after the Harness identity is verified on its canonical port.
            "LOCAL_MOE_RUNTIME_AUTOSTART": "0",
            "PYTHONUNBUFFERED": "1", "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8",
        })
        headless = eveos_console_prefs.headless_for("localMoe")
        environment["LOCAL_MOE_HEADLESS"] = "1" if headless else "0"
        flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
        flags |= getattr(subprocess, "CREATE_NO_WINDOW" if headless else "CREATE_NEW_CONSOLE", 0)
        sink = subprocess.DEVNULL if headless else None
        _PROCESS = subprocess.Popen(
            _launch_command(), cwd=str(_tool_root()), stdin=subprocess.DEVNULL,
            stdout=sink, stderr=sink, env=environment, creationflags=flags,
        )
        _write_pid(_PROCESS.pid)

    deadline = time.monotonic() + 5.0
    health = _harness_health()
    while time.monotonic() < deadline and health is None and _PROCESS.poll() is None:
        time.sleep(0.15)
        health = _harness_health()

    with _LOCK:
        if _PROCESS.poll() is not None and health is None:
            _pid_path().unlink(missing_ok=True)
            return {**_status(), "ok": False, "state": "error",
                    "message": "Local MoE Harness exited before becoming ready."}
        if health is None:
            return _status(
                "Local MoE Harness is starting; selected model startup will be available once it is ready."
            )
        current = _status(health=health, harness_pid=_PROCESS.pid)
        _STATUS_GRACE.remember(current)

    return _start_runtime_for_explicit_request(current) if start_runtime else current


def _terminate_owned(pid: int) -> bool:
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/F", "/T", "/PID", str(pid)], capture_output=True, text=True,
                check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
            )
            # taskkill can return nonzero when one child exits during tree teardown even
            # though the verified root and Harness listener are both gone. Judge the
            # final owned state instead of leaking a stale PID or a false UI failure.
            deadline = time.monotonic() + 3.0
            while time.monotonic() < deadline:
                if not _process_command_line(pid) and _harness_health() is None:
                    return True
                time.sleep(0.1)
            return False
        os.kill(pid, signal.SIGTERM)
        return True
    except OSError:
        return False


def _terminate_owned_runtime(pid: int) -> bool:
    """Stop a verified runtime tree even when the Harness API is unavailable."""
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

    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline:
        if not _process_command_line(pid) and not _port_open(RUNTIME_PORT):
            return True
        time.sleep(0.1)
    return False


def stop_server() -> dict:
    global _PROCESS
    _STATUS_GRACE.clear()
    with _LOCK:
        running = _harness_health() is not None
        pid = _managed_harness_pid()
        runtime_pid = _managed_runtime_pid()
        if pid is None:
            if running:
                return {**_status(health={}, harness_pid=None), "ok": False, "state": "external",
                        "message": "Refusing to stop a Harness not owned by this EveOS checkout."}
            if runtime_pid is not None:
                runtime_stopped = _terminate_owned_runtime(runtime_pid)
                if runtime_stopped:
                    _runtime_pid_path().unlink(missing_ok=True)
                    _pid_path().unlink(missing_ok=True)
                _PROCESS = None
                payload = _status(
                    "Local MoE orphaned runtime stopped."
                    if runtime_stopped else "Local MoE orphaned runtime did not stop cleanly.",
                    health=None,
                    harness_pid=None,
                )
                if not runtime_stopped:
                    payload.update(ok=False, state="error")
                return payload
            _pid_path().unlink(missing_ok=True)
            if not _port_open(RUNTIME_PORT):
                _runtime_pid_path().unlink(missing_ok=True)
            return _status("Local MoE Harness was already stopped.", health=None, harness_pid=None)
        if running:
            _http_json(HARNESS_PORT, "/api/runtime/stop", method="POST", timeout=20)
        harness_stopped = _terminate_owned(pid)
        runtime_stopped = not _port_open(RUNTIME_PORT)
        if not runtime_stopped:
            runtime_pid = _managed_runtime_pid()
            runtime_stopped = (
                _terminate_owned_runtime(runtime_pid) if runtime_pid is not None else False
            )
        stopped = harness_stopped and runtime_stopped
        if harness_stopped:
            _pid_path().unlink(missing_ok=True)
        if runtime_stopped:
            _runtime_pid_path().unlink(missing_ok=True)
        _PROCESS = None
    if stopped:
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and _harness_health() is not None:
            time.sleep(0.1)
    payload = _status("Local MoE Harness stopped." if stopped else "Local MoE Harness did not stop cleanly.")
    if not stopped:
        payload.update(ok=False, state="error")
    return payload


def open_launcher() -> dict:
    payload = get_status()
    if not payload["running"]:
        return {**payload, "ok": False, "message": "Start Local MoE Harness before opening its console."}
    webbrowser.open(payload["url"])
    return {**payload, "message": "Opened Local MoE Harness."}


def open_setup() -> dict:
    launcher = _tool_root() / ("Setup.bat" if os.name == "nt" else "scripts/bootstrap.sh")
    if not launcher.is_file():
        return {**get_status(), "ok": False, "state": "error", "message": "Local MoE setup launcher is missing."}
    if os.name == "nt":
        subprocess.Popen(
            ["cmd.exe", "/d", "/c", str(launcher)], cwd=str(_tool_root()),
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )
    else:
        subprocess.Popen([str(launcher)], cwd=str(_tool_root()), start_new_session=True)
    return {**get_status(), "message": "Local MoE setup opened in a terminal."}
