"""Lifecycle and setup control for the EveOS-integrated WatchFusion service."""

from __future__ import annotations

import http.client
import json
import os
import shutil
import signal
import socket
import subprocess
import threading
import time
from pathlib import Path

from . import eveos_console_prefs, eveos_exposure, eveos_ports


WATCHFUSION_PORT = eveos_ports.service_port("WATCHFUSION_PORT")
_PROCESS = None
_LOCK = threading.RLock()


def _root() -> Path:
    return Path(__file__).resolve().parent.parent


def _tool_root() -> Path:
    return _root() / "tools" / "WatchFusion"


def _entry() -> Path:
    return _tool_root() / "server.js"


def _launcher() -> Path:
    return _tool_root() / "WatchFusion.bat"


def _preference() -> Path:
    return _root() / "data" / "runtime" / "watchfusion-service.json"


def _write_desired(enabled: bool) -> None:
    path = _preference()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({
        "desiredRunning": bool(enabled),
        "port": WATCHFUSION_PORT,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, indent=2), encoding="utf-8")
    temporary.replace(path)


def _node() -> str | None:
    return shutil.which("node")


def _npm() -> str | None:
    if os.name == "nt":
        return shutil.which("npm.cmd") or shutil.which("npm")
    return shutil.which("npm")


def _deps_ready() -> bool:
    root = _tool_root()
    return (root / "node_modules" / "ws").exists() and (root / "node_modules" / "hls.js").exists()


def _node_major() -> int | None:
    node = _node()
    if not node:
        return None
    try:
        result = subprocess.run(
            [node, "--version"], capture_output=True, text=True, check=False, timeout=2,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
        text = (result.stdout or result.stderr or "").strip().lstrip("v")
        return int(text.split(".", 1)[0]) if result.returncode == 0 and text else None
    except (OSError, ValueError, subprocess.TimeoutExpired):
        return None


def _component_status(deps_ready: bool) -> dict:
    tool = _tool_root()
    nuvio = tool / "nuvio"
    voxel = tool / "voxelvision"
    helpers = voxel / "tools"
    node_major = _node_major()
    deno_ready = (helpers / "deno.exe").is_file()
    js_runtime_ready = bool((node_major or 0) >= 22 or deno_ready)
    yt_dlp_ready = (helpers / "yt-dlp.exe").is_file()
    ffmpeg_ready = (helpers / "ffmpeg.exe").is_file()
    ffprobe_ready = (helpers / "ffprobe.exe").is_file()
    nuvio_source = all((nuvio / name).is_file() for name in ("package.json", "index.html")) \
        and (nuvio / "js" / "app.js").is_file()
    nuvio_built = all((nuvio / "dist" / name).is_file() for name in (
        "index.html", "app.bundle.js", "core-js.bundle.js", "nuvio.env.js",
    ))
    voxel_source = all(path.is_file() for path in (
        voxel / "server.js", voxel / "public" / "index.html", voxel / "public" / "js" / "depth-models.js",
    ))
    youtube_ready = yt_dlp_ready and ffmpeg_ready and ffprobe_ready and js_runtime_ready
    return {
        "core": {
            "label": "WatchFusion runtime", "ready": deps_ready, "required": True,
            "message": "Locked Node dependencies are installed." if deps_ready else "Install the locked WatchFusion Node dependencies.",
        },
        "nuvio": {
            "label": "Nuvio", "ready": nuvio_built, "sourceReady": nuvio_source, "required": False,
            "message": "Nuvio browser build is installed; live rendering is verified after WatchFusion starts." if nuvio_built else (
                "Nuvio source is present but needs a browser build." if nuvio_source else "Nuvio needs installation."
            ),
        },
        "voxelvision": {
            "label": "VoxelVision", "ready": voxel_source, "required": True,
            "message": "Bundled VoxelVision source is installed; live rendering is verified after WatchFusion starts." if voxel_source else "Bundled VoxelVision source is incomplete.",
        },
        "voxelYoutube": {
            "label": "VoxelVision YouTube helpers", "ready": youtube_ready, "required": False,
            "ytDlpReady": yt_dlp_ready, "ffmpegReady": ffmpeg_ready, "ffprobeReady": ffprobe_ready,
            "jsRuntimeReady": js_runtime_ready, "nodeMajor": node_major, "denoReady": deno_ready,
            "message": "yt-dlp, FFmpeg, ffprobe, and a supported JS runtime are installed; runtime use is verified after start." if youtube_ready
            else "One or more YouTube helper dependencies still need setup.",
        },
        "browserModels": {
            "label": "VoxelVision AI models", "ready": None, "browserManaged": True,
            "message": "Depth and mask models load on demand in the browser and are tracked after WatchFusion starts.",
        },
    }


def _health() -> dict | None:
    connection = None
    try:
        connection = http.client.HTTPConnection("127.0.0.1", WATCHFUSION_PORT, timeout=0.8)
        connection.request("GET", "/api/health", headers={"Connection": "close"})
        response = connection.getresponse()
        payload = json.loads(response.read(65536).decode("utf-8"))
        if response.status != 200 or payload.get("ok") is not True or payload.get("app") != "WatchFusion":
            return None
        return payload
    except (OSError, ValueError, UnicodeError, http.client.HTTPException):
        return None
    finally:
        if connection:
            try:
                connection.close()
            except OSError:
                pass


def _remote_tunnel_url() -> str:
    try:
        return (_tool_root() / ".runtime" / "remote-url.txt").read_text(encoding="utf-8").strip()
    except OSError:
        return ""


def _port_open() -> bool:
    try:
        with socket.create_connection(("127.0.0.1", WATCHFUSION_PORT), timeout=0.25):
            return True
    except OSError:
        return False


def _pids() -> list[int]:
    if os.name == "nt":
        result = subprocess.run(
            ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True,
            check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        marker = f":{WATCHFUSION_PORT}"
        return sorted({
            int(parts[-1]) for line in (result.stdout or "").splitlines()
            if marker in line and "LISTENING" in line.upper()
            if (parts := line.split()) and parts[-1].isdigit()
        })
    result = subprocess.run(
        ["lsof", "-nP", f"-iTCP:{WATCHFUSION_PORT}", "-sTCP:LISTEN", "-t"],
        capture_output=True, text=True, check=False,
    )
    return sorted({int(value) for value in result.stdout.split() if value.isdigit()})


def _terminate(pid: int) -> bool:
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
    health = _health()
    process_alive = bool(_PROCESS and _PROCESS.poll() is None)
    running = health is not None
    blocked = _port_open() and not running
    installed = _entry().is_file()
    node_ready = _node() is not None
    npm_ready = _npm() is not None
    deps_ready = _deps_ready() if installed else False
    components = _component_status(deps_ready) if installed else {}
    state = "running" if running else "starting" if process_alive else "blocked" if blocked else "stopped"
    local_url = f"http://127.0.0.1:{WATCHFUSION_PORT}/"
    payload = {
        "ok": installed and node_ready and not blocked,
        "controllerAvailable": True,
        "service": "watchfusion-control",
        "installed": installed,
        "nodeReady": node_ready,
        "npmReady": npm_ready,
        "dependenciesReady": deps_ready,
        "setupRequired": installed and (not node_ready or not deps_ready),
        "setupAvailable": installed and npm_ready and not deps_ready,
        "components": components,
        "state": state,
        "running": running,
        "desiredRunning": False,
        "onDemand": True,
        "port": WATCHFUSION_PORT,
        "rooms": int(health.get("rooms") or 0) if health else 0,
        "pids": _pids() if running else [],
        "message": message or (
            "WatchFusion is online." if running else f"Port {WATCHFUSION_PORT} belongs to a different service."
            if blocked else "WatchFusion has not been hydrated into tools/WatchFusion yet."
            if not installed else "Node.js is required for WatchFusion."
            if not node_ready else "npm is required to install WatchFusion dependencies."
            if not npm_ready and not deps_ready else "WatchFusion dependencies are not installed yet."
            if not deps_ready else "WatchFusion is installed and ready to start on demand."
        ),
    }
    decorated = eveos_exposure.decorate_status(payload, "watchfusion", local_url)
    remote_url = _remote_tunnel_url() if running else ""
    if remote_url and not decorated.get("publicUrl"):
        decorated.update(exposureMode="cloudflare", publicUrl=remote_url, url=remote_url)
    return decorated


def get_status() -> dict:
    with _LOCK:
        return _status()


def open_launcher() -> dict:
    with _LOCK:
        current = _status()
        launcher = _launcher()
        if current["running"]:
            return {**current, "message": "WatchFusion is already online. Stop it before changing exposure mode."}
        if os.name != "nt":
            return {**current, "ok": False, "message": "The interactive WatchFusion exposure launcher currently requires Windows."}
        if not launcher.is_file():
            return {**current, "ok": False, "message": f"WatchFusion launcher missing: {launcher}"}
        try:
            subprocess.Popen(
                ["cmd.exe", "/k", str(launcher)], cwd=str(_tool_root()),
                creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
            )
        except OSError as exc:
            return {**current, "ok": False, "message": f"Could not open WatchFusion selective boot: {exc}"}
        return {**current, "ok": True, "state": "selecting", "launchPrompt": True,
                "message": "WatchFusion selective boot opened. Choose Localhost, LAN, or Cloudflare Remote in the terminal."}


def setup_component(component: str = "core") -> dict:
    """Install only WatchFusion's own locked Node dependencies without starting it."""
    with _LOCK:
        if component != "core":
            return {**_status(), "ok": False, "state": "error", "message": f"Unknown setup component: {component}"}
        current = _status()
        if current["running"]:
            return {**current, "message": "WatchFusion is already online; core dependencies are active."}
        if not current["installed"]:
            return {**current, "ok": False, "state": "error"}
        npm = _npm()
        if not npm:
            return {**current, "ok": False, "state": "error", "message": "npm is not available on PATH."}

    try:
        result = subprocess.run(
            [npm, "ci", "--no-audit", "--no-fund"], cwd=str(_tool_root()),
            capture_output=True, text=True, check=False, timeout=10 * 60,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    except subprocess.TimeoutExpired:
        return {**_status(), "ok": False, "state": "error", "message": "WatchFusion npm ci timed out after 10 minutes."}
    except OSError as exc:
        return {**_status(), "ok": False, "state": "error", "message": f"Could not start npm: {exc}"}

    if result.returncode != 0:
        detail = "\n".join((result.stderr or result.stdout or "").splitlines()[-12:])
        return {**_status(), "ok": False, "state": "error",
                "message": "WatchFusion dependency install failed." + (f"\n{detail}" if detail else "")}
    payload = _status("WatchFusion dependencies installed. Press Start when you want to launch the runtime.")
    payload["ok"] = payload.get("dependenciesReady") is True
    if not payload["ok"]:
        payload.update(state="error", message="npm ci completed, but required WatchFusion dependencies are still missing.")
    return payload


def start_server(*, persist: bool = False) -> dict:
    """Programmatic WatchFusion start is deliberately localhost-only."""
    global _PROCESS
    eveos_exposure.clear_state("watchfusion")
    with _LOCK:
        if persist:
            _write_desired(True)
        current = _status()
        if current["running"]:
            return {**current, "message": "WatchFusion is already online."}
        if current["state"] == "blocked":
            return {**current, "ok": False}
        if not current["installed"] or not current["nodeReady"] or not current["dependenciesReady"]:
            return {**current, "ok": False, "state": "error"}

        environment = os.environ.copy()
        environment.update(HOST="127.0.0.1", PORT=str(WATCHFUSION_PORT), EVEOS_INTEGRATED="1")
        headless = eveos_console_prefs.headless_for("watchFusion")
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

    deadline = time.monotonic() + 10.0
    while time.monotonic() < deadline and _health() is None:
        if _PROCESS and _PROCESS.poll() is not None:
            break
        time.sleep(0.15)
    with _LOCK:
        payload = _status("WatchFusion started locally." if _health() else "WatchFusion is starting locally.")
        if _PROCESS and _PROCESS.poll() is not None and not payload["running"]:
            payload.update(ok=False, state="error", message="WatchFusion exited before becoming ready.")
        return payload


def stop_server(*, persist: bool = False) -> dict:
    global _PROCESS
    with _LOCK:
        if persist:
            _write_desired(False)
        verified = _health() is not None
        stopped = False
        if verified:
            for pid in _pids():
                stopped = _terminate(pid) or stopped
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
    eveos_exposure.clear_state("watchfusion")
    deadline = time.monotonic() + 3.0
    while time.monotonic() < deadline and _health() is not None:
        time.sleep(0.1)
    with _LOCK:
        payload = _status("WatchFusion stopped." if stopped else "WatchFusion was already stopped.")
        if payload["running"]:
            payload.update(ok=False, state="error", message="WatchFusion did not stop cleanly.")
        return payload


def restore_desired_state_async() -> None:
    """WatchFusion is intentionally explicit/on-demand and is never restored at EveOS boot."""
    return
