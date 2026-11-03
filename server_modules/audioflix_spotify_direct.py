"""Server-owned Electron Direct Embed lifecycle and command adapter.

The child authenticates to a private, one-client loopback command socket using an environment-only
token. Spotify web content never sees that token, the native bridge credential, or the command
socket; Electron main retains capture privileges and the authenticated provider-capture session.
"""
from __future__ import annotations

import atexit
import json
import os
import secrets
import socket
import subprocess
import threading
import time
import uuid
from pathlib import Path

_PREFIX = "EVEOS_SPOTIFY_DIRECT "
_START_TIMEOUT = 20.0
_COMMAND_TIMEOUT = 20.0
_PLAY_TIMEOUT = 90.0


def _root() -> Path:
    return Path(__file__).resolve().parent.parent


def _host_dir() -> Path:
    return _root() / "tools" / "experiments" / "electron-targeted-capture"


def _electron() -> Path:
    return _host_dir() / "node_modules" / "electron" / "dist" / "electron.exe"


def _runtime_dir() -> Path:
    target = _root() / "data" / "runtime" / "audioflix-spotify-direct"
    target.mkdir(parents=True, exist_ok=True)
    return target


class SpotifyDirectManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._launch_lock = threading.Lock()
        self._write_lock = threading.Lock()
        self._process: subprocess.Popen | None = None
        self._listener: socket.socket | None = None
        self._connection: socket.socket | None = None
        self._reader: threading.Thread | None = None
        self._ready = threading.Event()
        self._pending: dict[str, dict] = {}
        self._device_id = ""
        self._bridge_port = 0
        self._last_state: dict = {"status": "stopped", "paused": True}
        self._last_error = ""
        self._started_at = 0.0
        self._log_handle = None

    def environment(self) -> dict:
        binary = _electron()
        package = _host_dir() / "package.json"
        return {
            "electronAvailable": binary.is_file(),
            "electronPath": str(binary) if binary.is_file() else "",
            "hostExists": package.is_file(),
            "hostPath": str(_host_dir()),
        }

    def _running(self) -> bool:
        return bool(self._process and self._process.poll() is None)

    def _public_status(self) -> dict:
        with self._lock:
            running = self._running()
            return {
                "ok": True,
                **self.environment(),
                "running": running,
                "state": dict(self._last_state),
                "deviceId": self._device_id if running else "",
                "bridgePort": self._bridge_port if running else 0,
                "startedAt": self._started_at if running else 0,
                "lastError": self._last_error,
                "pid": self._process.pid if running else 0,
            }

    def status(self) -> dict:
        with self._lock:
            process = self._process
            if process and process.poll() is not None:
                self._last_error = self._last_error or f"Electron Direct Embed exited with code {process.returncode}."
                self._cleanup_locked()
        return self._public_status()

    def _write_log(self, line: str) -> None:
        handle = self._log_handle
        if not handle:
            return
        try:
            handle.write(line[:2000] + "\n")
            handle.flush()
        except Exception:
            pass

    def _stdout_loop(self, process: subprocess.Popen) -> None:
        for raw in iter(process.stdout.readline, ""):
            self._write_log(raw.rstrip("\r\n"))

    def _reader_loop(self, process: subprocess.Popen, listener: socket.socket, token: str) -> None:
        try:
            listener.settimeout(_START_TIMEOUT)
            connection, address = listener.accept()
            if address[0] != "127.0.0.1":
                connection.close()
                raise RuntimeError("Electron Direct Embed control peer was not loopback.")
            reader = connection.makefile("r", encoding="utf-8", errors="replace", newline="\n")
            first = json.loads(reader.readline())
            if not secrets.compare_digest(str(first.get("token") or ""), token):
                connection.close()
                raise RuntimeError("Electron Direct Embed control authentication failed.")
            with self._lock:
                if process is not self._process:
                    connection.close()
                    return
                self._connection = connection
            for raw in reader:
                line = raw.rstrip("\r\n")
                try:
                    value = json.loads(line)
                except Exception:
                    self._write_log("[protocol] invalid JSON")
                    continue
                if not isinstance(value, dict):
                    continue
                kind = str(value.get("type") or "")
                with self._lock:
                    if process is not self._process:
                        continue
                    if kind == "ready" and value.get("ok"):
                        self._last_state = dict(value.get("state") or self._last_state)
                        self._ready.set()
                    elif kind == "state":
                        self._last_state = dict(value.get("state") or self._last_state)
                    elif kind == "reply":
                        pending = self._pending.get(str(value.get("id") or ""))
                        if pending:
                            pending["response"] = value
                            pending["event"].set()
        finally:
            with self._lock:
                if process is self._process:
                    code = process.poll()
                    self._last_error = self._last_error or f"Electron Direct Embed exited unexpectedly ({code})."
                    for pending in self._pending.values():
                        pending["response"] = {"ok": False, "reason": self._last_error}
                        pending["event"].set()
                    self._ready.set()

    def _cleanup_locked(self) -> None:
        if self._process and self._process.poll() is None:
            return
        self._process = None
        for stream in (self._connection, self._listener):
            try:
                stream.close() if stream else None
            except Exception:
                pass
        self._connection = None
        self._listener = None
        self._reader = None
        self._device_id = ""
        self._bridge_port = 0
        self._ready.clear()
        self._pending.clear()
        if self._log_handle:
            try:
                self._log_handle.close()
            except Exception:
                pass
        self._log_handle = None

    def _launch(self, device_id: str, bridge_port: int) -> dict:
        env = self.environment()
        if not env["electronAvailable"] or not env["hostExists"]:
            return {"ok": False, **env, "reason": "Electron Direct Embed is not installed. Run Audioflix Setup / Repair."}
        if not device_id.startswith("sd:") or not device_id[3:].isdigit():
            return {"ok": False, "reason": "Electron Direct Embed requires an exact native sd:* output."}
        if not 1 <= int(bridge_port) <= 65535:
            return {"ok": False, "reason": "Invalid EveOS bridge port."}
        with self._lock:
            if self._running() and self._device_id == device_id and self._bridge_port == bridge_port:
                return self._public_status()
        self.shutdown()
        data_dir = _runtime_dir()
        log_path = data_dir / "electron-direct.log"
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        control_port = int(listener.getsockname()[1])
        control_token = secrets.token_urlsafe(32)
        command = [str(_electron()), str(_host_dir()), "--runtime", "--source=spotify", "--persist-spotify",
            "--hide-source", f"--device-id={device_id}", f"--bridge=http://127.0.0.1:{bridge_port}",
            f"--eveos-root={_root()}", f"--data-dir={data_dir}", f"--owner-pid={os.getpid()}",
            f"--control-port={control_port}"]
        flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
        handle = None
        try:
            handle = log_path.open("a", encoding="utf-8", errors="replace")
            child_env = os.environ.copy()
            child_env["EVEOS_SPOTIFY_DIRECT_CONTROL_TOKEN"] = control_token
            process = subprocess.Popen(command, cwd=str(_host_dir()), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace", bufsize=1,
                creationflags=flags, close_fds=True, env=child_env)
        except OSError as exc:
            listener.close()
            try:
                handle.close()
            except Exception:
                pass
            return {"ok": False, **env, "reason": f"Could not launch Electron Direct Embed: {exc}"}
        with self._lock:
            self._process = process
            self._listener = listener
            self._device_id = device_id
            self._bridge_port = int(bridge_port)
            self._started_at = time.time()
            self._last_error = ""
            self._last_state = {"status": "starting", "paused": True}
            self._ready.clear()
            self._log_handle = handle
            threading.Thread(target=self._stdout_loop, args=(process,), daemon=True,
                name="audioflix-spotify-direct-log").start()
            self._reader = threading.Thread(target=self._reader_loop, args=(process, listener, control_token), daemon=True,
                name="audioflix-spotify-direct-reader")
            self._reader.start()
        if not self._ready.wait(_START_TIMEOUT):
            self.shutdown(force=True)
            return {"ok": False, **env, "reason": "Electron Direct Embed did not become ready in time."}
        status = self.status()
        if not status["running"]:
            return {"ok": False, **status, "reason": status["lastError"] or "Electron Direct Embed exited during startup."}
        return status

    def ensure(self, device_id: str, bridge_port: int) -> dict:
        with self._launch_lock:
            return self._launch(device_id, bridge_port)

    def _send(self, action: str, payload: dict | None = None, timeout: float = _COMMAND_TIMEOUT) -> dict:
        with self._lock:
            if not self._running() or not self._process or not self._connection:
                return {"ok": False, "reason": "Electron Direct Embed is not running."}
            process = self._process
            connection = self._connection
            request_id = uuid.uuid4().hex
            pending = {"event": threading.Event(), "response": None}
            self._pending[request_id] = pending
        message = json.dumps({"id": request_id, "action": action, "payload": payload or {}}, separators=(",", ":"))
        try:
            with self._write_lock:
                connection.sendall((message + "\n").encode("utf-8"))
        except (OSError, BrokenPipeError, ValueError) as exc:
            with self._lock:
                self._pending.pop(request_id, None)
            return {"ok": False, "reason": f"Electron Direct Embed command pipe failed: {exc}"}
        if not pending["event"].wait(timeout):
            with self._lock:
                self._pending.pop(request_id, None)
            return {"ok": False, "reason": f"Electron Direct Embed {action} timed out."}
        with self._lock:
            self._pending.pop(request_id, None)
            response = pending["response"] or {"ok": False, "reason": "Missing Electron Direct Embed reply."}
            if isinstance(response.get("state"), dict):
                self._last_state = dict(response["state"])
            if not response.get("ok"):
                self._last_error = str(response.get("reason") or "Electron Direct Embed failed.")[:300]
            return response

    def command(self, payload: dict, bridge_port: int) -> dict:
        action = str((payload or {}).get("action") or "").strip().lower()
        body = dict((payload or {}).get("payload") or {})
        if action == "status":
            return self.status()
        if action == "prepare":
            return self.ensure(str(body.get("deviceId") or ""), bridge_port)
        if action == "play":
            device_id = str(body.get("deviceId") or "")
            started = self.ensure(device_id, bridge_port)
            if not started.get("ok") or not started.get("running"):
                return started
        if action == "shutdown-host":
            return self.shutdown()
        result = self._send(action, body, timeout=_PLAY_TIMEOUT if action == "play" else _COMMAND_TIMEOUT)
        return {**result, "host": self._public_status()}

    def shutdown(self, force: bool = False) -> dict:
        with self._lock:
            process = self._process
        if not process:
            return {"ok": True, "state": "stopped", "alreadyStopped": True}
        if process.poll() is None and not force:
            self._send("shutdown", {}, timeout=4.0)
            try:
                process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                pass
        if process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=3)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
        with self._lock:
            if process is self._process:
                self._cleanup_locked()
        return {"ok": True, "state": "stopped"}


_MANAGER = SpotifyDirectManager()


def status() -> dict:
    return _MANAGER.status()


def command(payload: dict, bridge_port: int) -> dict:
    return _MANAGER.command(payload if isinstance(payload, dict) else {}, bridge_port)


def shutdown() -> dict:
    return _MANAGER.shutdown()


atexit.register(shutdown)
