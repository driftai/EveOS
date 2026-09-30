"""Programmatic Local/LAN/Remote switching for the WatchFusion runtime."""

from __future__ import annotations

import json
import os
import subprocess
import time
from pathlib import Path

from . import watchfusion_control

_REQUEST_TTL_SECONDS = 180.0
_MODE_PROCESS = None


def _root() -> Path:
    return Path(__file__).resolve().parent.parent


def _tool_root() -> Path:
    return _root() / "tools" / "WatchFusion"


def _request_path() -> Path:
    return _root() / "data" / "runtime" / "watchfusion-mode.json"


def _write_request(mode: str) -> None:
    path = _request_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({"mode": mode, "at": time.time()}), encoding="utf-8")
    temporary.replace(path)


def _read_request() -> dict:
    try:
        value = json.loads(_request_path().read_text(encoding="utf-8"))
        return value if isinstance(value, dict) else {}
    except (OSError, ValueError, TypeError):
        return {}


def _clear_request() -> None:
    try:
        _request_path().unlink()
    except OSError:
        pass


def _normalize(value) -> str:
    mode = str(value or "").strip().lower()
    if mode == "remote":
        mode = "cloudflare"
    return mode if mode in {"local", "lan", "cloudflare"} else ""


def _runtime_dir() -> Path:
    return _tool_root() / ".runtime"


def _pid_command_line(pid: int) -> str:
    if os.name != "nt" or pid <= 0:
        return ""
    command = (
        f"(Get-CimInstance Win32_Process -Filter \"ProcessId = {pid}\" "
        "-ErrorAction SilentlyContinue).CommandLine"
    )
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-Command", command],
            capture_output=True, text=True, check=False, timeout=3,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return (result.stdout or "").strip()
    except (OSError, subprocess.TimeoutExpired):
        return ""


def _kill_owned_pid_file(path: Path) -> None:
    if os.name != "nt":
        return
    try:
        pid = int(path.read_text(encoding="utf-8").strip())
    except (OSError, ValueError):
        return
    command = _pid_command_line(pid).lower()
    root = str(_tool_root()).lower()
    if not command or (root not in command and "cloudflared" not in command):
        return
    subprocess.run(
        ["taskkill", "/F", "/T", "/PID", str(pid)],
        capture_output=True, text=True, check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )


def _stop_remote_helpers() -> None:
    global _MODE_PROCESS
    if _MODE_PROCESS and _MODE_PROCESS.poll() is None:
        try:
            _MODE_PROCESS.terminate()
        except OSError:
            pass
    _MODE_PROCESS = None
    runtime = _runtime_dir()
    for name in ("cloudflared.pid", "server.pid"):
        _kill_owned_pid_file(runtime / name)
    for name in ("cloudflared.pid", "server.pid", "remote-url.txt", "RUN-CLOUDFLARE.bat"):
        try:
            (runtime / name).unlink()
        except OSError:
            pass


def _launch_remote() -> dict:
    global _MODE_PROCESS
    if os.name != "nt":
        return {**watchfusion_control.get_status(), "ok": False, "state": "error",
                "message": "WatchFusion Remote mode currently requires Windows."}
    launcher = _tool_root() / "scripts" / "START-WATCHFUSION-REMOTE.bat"
    if not launcher.is_file():
        return {**watchfusion_control.get_status(), "ok": False, "state": "error",
                "message": f"WatchFusion remote launcher is missing: {launcher}"}
    try:
        _MODE_PROCESS = subprocess.Popen(
            ["cmd.exe", "/c", str(launcher)], cwd=str(_tool_root()),
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )
    except OSError as exc:
        return {**watchfusion_control.get_status(), "ok": False, "state": "error",
                "message": f"Could not start WatchFusion Remote mode: {exc}"}
    payload = watchfusion_control.get_status()
    payload.update(ok=True, state="running" if payload.get("running") else "starting",
                   message="WatchFusion Remote mode is starting; Cloudflare will publish the share URL when ready.")
    return payload


def decorate_status(payload: dict) -> dict:
    request = _read_request()
    requested = _normalize(request.get("mode"))
    if not requested:
        return payload
    age = max(0.0, time.time() - float(request.get("at") or 0.0))
    actual = _normalize(payload.get("exposureMode")) or "local"
    if payload.get("running") and actual == requested:
        _clear_request()
        return payload
    if age > _REQUEST_TTL_SECONDS:
        _clear_request()
        return payload
    if requested == "cloudflare" and _MODE_PROCESS and _MODE_PROCESS.poll() is not None:
        _clear_request()
        payload["message"] = (
            "WatchFusion origin is online locally, but the Remote tunnel launcher exited."
            if payload.get("running") else "WatchFusion Remote mode exited before becoming ready."
        )
        return payload
    label = {"local": "Local", "lan": "LAN", "cloudflare": "Remote"}[requested]
    payload["requestedExposureMode"] = requested
    payload["exposurePending"] = True
    payload["message"] = (
        f"WatchFusion origin is online; switching exposure to {label}…"
        if payload.get("running") else f"WatchFusion is restarting in {label} mode…"
    )
    return payload


def apply_request(body: dict) -> dict:
    mode = _normalize((body or {}).get("mode"))
    if not mode:
        return {**watchfusion_control.get_status(), "ok": False, "state": "error",
                "message": "WatchFusion mode must be local, lan, or cloudflare."}

    _write_request(mode)
    _stop_remote_helpers()
    current = watchfusion_control.get_status()
    if current.get("running"):
        watchfusion_control.stop_server()

    if mode == "local":
        payload = watchfusion_control.start_server()
    elif mode == "lan":
        payload = watchfusion_control.start_server(host="0.0.0.0")
    else:
        payload = _launch_remote()
    return decorate_status(payload)
