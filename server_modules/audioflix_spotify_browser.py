"""Managed Playwright Spotify browser for Audioflix playback-side capabilities.

The helper owns the same persistent Spotify identity used by playlist import. Browser control is
loopback-only, token protected, and never exposes cookies, profile contents, or session secrets.
"""
from __future__ import annotations

import hmac
import json
import os
import secrets
import shutil
import socket
import subprocess
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from server_modules.audioflix_spotify_browser_startup import (
    STARTUP_CONTRACT as _STARTUP_CONTRACT,
    START_TIMEOUT_S as _START_TIMEOUT_S,
    startup_log_reason as _startup_log_reason,
)
from server_modules.audioflix_spotify_browser_utils import (
    clamp_volume,
    normalize_track_id,
    validate_loopback_page_url,
)

_DEFAULT_EVEOS_URL = "http://127.0.0.1:8765/EveOS.html"
_ENV_CACHE_TTL_S = 10.0
_STATUS_TIMEOUT_S = 2.5
_STOP_TIMEOUT_S = 6.0
_PLAYLIST_TIMEOUT_S = 175.0


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _helper_path() -> Path:
    return _project_root() / "server_modules" / "audioflix_spotify_browser.js"


def _profile_dir() -> Path:
    from server_modules import audioflix_spotify
    return audioflix_spotify._profile_dir()


def _runtime_dir() -> Path:
    target = _profile_dir().parent
    target.mkdir(parents=True, exist_ok=True)
    return target


def _allocate_loopback_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _node_playwright_probe() -> dict:
    node = shutil.which("node")
    result = {
        "nodeAvailable": bool(node),
        "nodePath": node or "",
        "playwrightAvailable": False,
        "playwrightVersion": "",
        "helperExists": _helper_path().is_file(),
    }
    if not node:
        result["reason"] = "Node.js was not found on PATH."
        return result
    try:
        completed = subprocess.run(
            [node, "-e", "const p=require('playwright/package.json');process.stdout.write(String(p.version||''))"],
            cwd=str(_project_root()),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
            check=False,
        )
    except (OSError, subprocess.TimeoutExpired) as exc:
        result["reason"] = f"Could not inspect Playwright: {exc}"
        return result
    if completed.returncode == 0:
        result["playwrightAvailable"] = True
        result["playwrightVersion"] = (completed.stdout or "").strip()
    else:
        detail = (completed.stderr or completed.stdout or "Playwright is not installed.").strip().splitlines()
        result["reason"] = detail[-1][:300] if detail else "Playwright is not installed."
    return result


class SpotifyBrowserManager:
    def __init__(self):
        self._lock = threading.RLock()
        self._process: subprocess.Popen | None = None
        self._port = 0
        self._token = ""
        self._session_id = ""
        self._page_url = _DEFAULT_EVEOS_URL
        self._started_at = 0.0
        self._last_error = ""
        self._log_handle = None
        self._env_cache: tuple[float, dict] | None = None

    def environment_status(self, force: bool = False) -> dict:
        with self._lock:
            now = time.monotonic()
            if not force and self._env_cache and now - self._env_cache[0] < _ENV_CACHE_TTL_S:
                return dict(self._env_cache[1])
            info = _node_playwright_probe()
            try:
                profile = _profile_dir()
                info.update({
                    "profilePath": str(profile),
                    "profileExists": profile.exists(),
                    "profileHasState": profile.exists() and any(profile.iterdir()),
                })
            except OSError as exc:
                info.update({"profilePath": "", "profileExists": False, "profileHasState": False})
                info["profileError"] = str(exc)[:300]
            self._env_cache = (now, dict(info))
            return info

    def _process_running(self) -> bool:
        return bool(self._process and self._process.poll() is None)

    def _session_matches(self, candidate) -> bool:
        candidate = str(candidate or "")
        expected = str(self._session_id or "")
        return bool(candidate and expected and hmac.compare_digest(candidate, expected))

    def _request(self, method: str, route: str, body: dict | None = None,
                 timeout: float = _STATUS_TIMEOUT_S) -> dict:
        if not self._port or not self._token:
            raise RuntimeError("Spotify managed browser helper is not running.")
        data = None if body is None else json.dumps(body).encode("utf-8")
        request = urllib.request.Request(
            f"http://127.0.0.1:{self._port}{route}",
            data=data,
            method=method,
            headers={
                "X-EveOS-Spotify-Token": self._token,
                "Content-Type": "application/json; charset=utf-8",
                "Accept": "application/json",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8", errors="replace"))
                return payload if isinstance(payload, dict) else {"ok": False, "reason": "Invalid helper response."}
        except urllib.error.HTTPError as exc:
            try:
                payload = json.loads(exc.read().decode("utf-8", errors="replace"))
            except Exception:
                payload = {}
            if isinstance(payload, dict) and payload:
                return payload
            raise RuntimeError(f"Spotify helper HTTP {exc.code}") from exc

    def _helper_status(self) -> dict | None:
        if not self._process_running():
            return None
        try:
            payload = self._request("GET", "/status")
            if payload.get("ok"):
                self._last_error = ""
                return payload
            self._last_error = str(payload.get("reason") or "Spotify helper returned an unhealthy status.")[:300]
        except Exception as exc:
            self._last_error = str(exc)[:300]
        return None

    def status(self, payload: dict | None = None) -> dict:
        del payload
        with self._lock:
            env = self.environment_status()
            helper = self._helper_status()
            running = self._process_running()
            result = {
                "ok": True,
                **env,
                "browserRunning": running,
                "helperReachable": bool(helper),
                "profileBusy": running,
                "managed": bool(helper),
                "state": helper.get("state") if helper else ("starting" if running else "stopped"),
                "phase": (helper or {}).get("phase") or ("launching" if running else ""),
                "sessionPresent": bool(self._session_id if running else ""),
                "pageUrl": helper.get("pageUrl") if helper else self._page_url,
                "pageAttached": bool(helper and helper.get("pageAttached")),
                "spotifyFrameCount": int((helper or {}).get("spotifyFrameCount") or 0),
                "mediaCount": int((helper or {}).get("mediaCount") or 0),
                "playingCount": int((helper or {}).get("playingCount") or 0),
                "desiredVolume": (helper or {}).get("desiredVolume"),
                "authState": (helper or {}).get("authState") or "unknown",
                "browserChannel": (helper or {}).get("browserChannel") or "",
                "lastAppliedAt": (helper or {}).get("lastAppliedAt") or 0,
                "lastError": (helper or {}).get("lastError") or self._last_error,
                "importing": bool((helper or {}).get("importing")),
                "startupBudgetMs": int(_START_TIMEOUT_S * 1000),
            }
            if helper and helper.get("diagnostics"):
                result["diagnostics"] = helper.get("diagnostics")
            return result

    def session_status(self, payload: dict | None = None) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        with self._lock:
            session_match = self._session_matches(payload.get("sessionId")) and bool(self._helper_status())
            result = self.status()
            result["sessionMatch"] = session_match
            return result

    def start(self, payload: dict | None = None) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        with self._lock:
            page_url = str(payload.get("pageUrl") or self._page_url or _DEFAULT_EVEOS_URL).strip()
            if not validate_loopback_page_url(page_url):
                return {"ok": False, "reason": "Managed Spotify browser requires a loopback EveOS URL."}
            helper = self._helper_status()
            if helper:
                self._page_url = page_url
                if helper.get("pageUrl") != page_url:
                    opened = self._request("POST", "/open", {"pageUrl": page_url}, timeout=12)
                    if not opened.get("ok"):
                        return opened
                return self.status()
            if self._process_running():
                self._stop_locked(force=True)
            else:
                self._cleanup_process_locked()
            env = self.environment_status(force=True)
            if not env.get("nodeAvailable"):
                return {"ok": False, **env, "reason": env.get("reason") or "Node.js is required."}
            if not env.get("playwrightAvailable"):
                return {"ok": False, **env, "reason": env.get("reason") or "Playwright is required."}
            if not env.get("helperExists"):
                return {"ok": False, **env, "reason": "Spotify managed-browser helper is missing."}

            self._port = _allocate_loopback_port()
            self._token = secrets.token_urlsafe(32)
            self._session_id = secrets.token_hex(16)
            self._page_url = page_url
            self._started_at = time.time()
            self._last_error = ""
            profile = _profile_dir()
            profile.mkdir(parents=True, exist_ok=True)
            log_path = _runtime_dir() / "spotify-managed-browser.log"
            command = [
                env.get("nodePath") or "node", str(_helper_path()),
                "--port", str(self._port), "--profile", str(profile),
                "--page", page_url, "--session", self._session_id,
            ]
            child_env = os.environ.copy()
            child_env["EVEOS_SPOTIFY_BROWSER_TOKEN"] = self._token
            flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
            try:
                self._log_handle = log_path.open("a", encoding="utf-8", errors="replace")
                self._process = subprocess.Popen(
                    command, cwd=str(_project_root()), env=child_env,
                    stdin=subprocess.DEVNULL, stdout=self._log_handle,
                    stderr=subprocess.STDOUT, creationflags=flags, close_fds=True,
                )
            except OSError as exc:
                self._last_error = str(exc)[:300]
                self._cleanup_process_locked()
                return {"ok": False, **env, "reason": f"Could not launch managed Spotify browser: {exc}"}

            started = time.monotonic()
            deadline = started + _START_TIMEOUT_S
            while time.monotonic() < deadline:
                if not self._process_running():
                    break
                helper = self._helper_status()
                if helper and helper.get("state") != "starting":
                    return self.status()
                time.sleep(0.15)
            elapsed = time.monotonic() - started
            fallback = (
                f"Managed Spotify browser did not become ready within "
                f"{_START_TIMEOUT_S:.0f}s (elapsed {elapsed:.1f}s)."
            )
            reason = _startup_log_reason(log_path, fallback)
            self._stop_locked(force=True)
            return {"ok": False, **env, "reason": reason, "startupElapsedMs": int(elapsed * 1000)}

    def _cleanup_process_locked(self) -> None:
        if self._process and self._process.poll() is not None:
            self._process = None
        if not self._process:
            self._port = 0
            self._token = ""
            self._session_id = ""
        if self._log_handle and self._process is None:
            try:
                self._log_handle.close()
            except Exception:
                pass
            self._log_handle = None

    def _stop_locked(self, force: bool = False) -> dict:
        process = self._process
        if not process:
            self._cleanup_process_locked()
            return {"ok": True, "state": "stopped", "alreadyStopped": True}
        if process.poll() is None and not force:
            try:
                self._request("POST", "/shutdown", {}, timeout=2)
            except Exception:
                pass
            deadline = time.monotonic() + _STOP_TIMEOUT_S
            while process.poll() is None and time.monotonic() < deadline:
                time.sleep(0.1)
        if process.poll() is None:
            try:
                process.terminate()
                process.wait(timeout=2)
            except Exception:
                try:
                    process.kill()
                except Exception:
                    pass
        self._process = None
        self._cleanup_process_locked()
        return {"ok": True, "state": "stopped"}

    def stop(self, payload: dict | None = None) -> dict:
        del payload
        with self._lock:
            return self._stop_locked(force=False)

    def _set_volume_locked(self, payload: dict, session_id: str) -> dict:
        body = {
            "sessionId": session_id,
            "volume": clamp_volume(payload.get("volume"), 1),
            "trackId": normalize_track_id(payload.get("trackId") or ""),
        }
        try:
            return self._request("POST", "/volume", body, timeout=3)
        except Exception as exc:
            self._last_error = str(exc)[:300]
            return {"ok": False, "sessionMatch": False, "reason": self._last_error}

    def set_volume(self, payload: dict | None = None) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        with self._lock:
            if not self._helper_status():
                return {"ok": False, "sessionMatch": False,
                        "reason": "Managed Spotify browser is not running or not reachable."}
            session_id = str(payload.get("sessionId") or "")
            if not self._session_matches(session_id):
                return {"ok": False, "sessionMatch": False,
                        "reason": "This EveOS tab is not the managed browser session."}
            return self._set_volume_locked(payload, session_id)

    def qualify_volume(self, payload: dict | None = None) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        with self._lock:
            if not self._helper_status() or not self._session_id:
                return {"ok": False, "sessionMatch": False,
                        "reason": "Managed Spotify browser is not running or not reachable."}
            result = self._set_volume_locked(payload, self._session_id)
            if result.get("ok"):
                result["sessionMatch"] = True
            return result

    def auth(self, payload: dict | None = None) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        with self._lock:
            if not self._helper_status():
                return {"ok": False, "authState": "unknown",
                        "reason": "Managed Spotify browser is not running."}
            body = {
                "openLogin": bool(payload.get("openLogin")),
                "url": str(payload.get("url") or "https://open.spotify.com/")[:2000],
            }
            try:
                return self._request("POST", "/auth", body, timeout=12)
            except Exception as exc:
                self._last_error = str(exc)[:300]
                return {"ok": False, "authState": "unknown", "reason": self._last_error}

    def list_playlist(self, payload: dict | None = None) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        url = str(payload.get("url") or "").strip()
        with self._lock:
            if not self._helper_status():
                return {"ok": False, "reason": "Managed Spotify browser is not running."}
        try:
            result = self._request("POST", "/playlist", {"url": url}, timeout=_PLAYLIST_TIMEOUT_S)
            if result.get("ok"):
                self._last_error = ""
            return result
        except Exception as exc:
            self._last_error = str(exc)[:300]
            return {"ok": False, "reason": self._last_error}


_manager = SpotifyBrowserManager()


def status(payload: dict | None = None) -> dict:
    return _manager.status(payload)


def session_status(payload: dict | None = None) -> dict:
    return _manager.session_status(payload)


def start(payload: dict | None = None) -> dict:
    return _manager.start(payload)


def stop(payload: dict | None = None) -> dict:
    return _manager.stop(payload)


def set_volume(payload: dict | None = None) -> dict:
    return _manager.set_volume(payload)


def qualify_volume(payload: dict | None = None) -> dict:
    return _manager.qualify_volume(payload)


def auth(payload: dict | None = None) -> dict:
    return _manager.auth(payload)


def list_playlist(payload: dict | None = None) -> dict:
    return _manager.list_playlist(payload)
