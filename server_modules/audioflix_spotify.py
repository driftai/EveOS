"""Spotify playlist metadata extraction for Audioflix.

This module deliberately extracts metadata only. Spotify audio is never downloaded; Audioflix
localization may attach user-owned files from a folder after import.
"""

from __future__ import annotations

import html
import json
import os
import re
import shutil
import subprocess
import threading
import time
from pathlib import Path

_CACHE_TTL_S = 300
_cache: dict[str, dict] = {}
_cache_lock = threading.Lock()
_scrape_lock = threading.Lock()
_session_lock = threading.Lock()
_session_process: subprocess.Popen | None = None
_PLAYLIST_RE = re.compile(
    r"https?://open\.spotify\.com/(?:embed/)?playlist/([A-Za-z0-9]+)(?:[?&#][^\"'<>\s]*)?",
    re.IGNORECASE,
)


def normalize_playlist_input(value: str) -> dict:
    raw = html.unescape(str(value or "").strip())
    match = _PLAYLIST_RE.search(raw)
    if not match:
        return {"ok": False, "reason": "Enter a public Spotify playlist URL, embed URL, or iframe snippet."}
    playlist_id = match.group(1)
    return {
        "ok": True,
        "playlistId": playlist_id,
        "url": f"https://open.spotify.com/playlist/{playlist_id}",
        "embedUrl": f"https://open.spotify.com/embed/playlist/{playlist_id}",
    }


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _profile_dir() -> Path:
    configured = os.environ.get("EVEOS_SPOTIFY_PROFILE", "").strip()
    if configured:
        return Path(configured).expanduser().resolve()
    local = Path(os.environ.get("LOCALAPPDATA") or (Path.home() / "AppData" / "Local"))
    target = local / "EveOS" / "spotify-browser-profile"
    if not target.exists():
        legacy = Path.home() / "Downloads" / "drift-spotify-embed-scraper-v2" / ".spotify-browser-profile"
        if legacy.is_dir():
            target.parent.mkdir(parents=True, exist_ok=True)
            try:
                shutil.copytree(legacy, target)
            except OSError:
                pass
    target.mkdir(parents=True, exist_ok=True)
    return target


def _cache_get(key: str):
    with _cache_lock:
        entry = _cache.get(key)
        if entry and entry["expires"] > time.monotonic():
            return {**entry["value"], "cached": True}
        if entry:
            _cache.pop(key, None)
    return None


def _cache_set(key: str, value: dict) -> None:
    with _cache_lock:
        _cache[key] = {"expires": time.monotonic() + _CACHE_TTL_S, "value": value}
        if len(_cache) > 30:
            oldest = min(_cache, key=lambda item: _cache[item]["expires"])
            _cache.pop(oldest, None)


def _helper_command(mode: str, normalized: dict, status_path: Path | None = None) -> list[str]:
    # Spotify's Embed UI truncates large playlists around 100 tracks. The extractor already uses
    # a saved browser profile and scrolls the playlist, so point it at the full Web Player page
    # where Spotify can load the remaining rows as the scraper advances through the list.
    command = [
        "node",
        str(_project_root() / "server_modules" / "audioflix_spotify_scrape.js"),
        mode,
        normalized["url"],
        str(_profile_dir()),
    ]
    if status_path:
        command.append(str(status_path))
    return command


def _pid_is_running(pid: int) -> bool:
    if pid <= 0:
        return False
    if os.name == "nt":
        try:
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/FO", "CSV", "/NH"],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=3,
                check=False,
            )
            return f'"{pid}"' in result.stdout
        except (OSError, subprocess.TimeoutExpired):
            return False
    try:
        os.kill(pid, 0)
        return True
    except (OSError, ValueError):
        return False


def list_playlist(value: str, force: bool = False) -> dict:
    normalized = normalize_playlist_input(value)
    if not normalized.get("ok"):
        return normalized
    if not force:
        cached = _cache_get(normalized["playlistId"])
        if cached:
            return cached

    try:
        with _scrape_lock:
            result = subprocess.run(
                _helper_command("scrape", normalized),
                cwd=str(_project_root()),
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=600,
                check=False,
            )
    except subprocess.TimeoutExpired:
        return {"ok": False, "reason": "Spotify extraction timed out. Open the saved Spotify session and try again."}
    except OSError as exc:
        return {"ok": False, "reason": f"Could not start the Spotify extractor: {exc}"}

    try:
        payload = json.loads((result.stdout or "").strip())
    except json.JSONDecodeError:
        detail = (result.stderr or result.stdout or "No extractor output.").strip()[-500:]
        return {"ok": False, "reason": f"Spotify extractor returned invalid data: {detail}"}
    if payload.get("ok"):
        payload.update(normalized)
        payload["provider"] = "spotify"
        payload["cached"] = False
        _cache_set(normalized["playlistId"], payload)
    return payload


def open_session(value: str) -> dict:
    global _session_process
    normalized = normalize_playlist_input(value)
    if not normalized.get("ok"):
        return normalized
    runtime_dir = _profile_dir().parent
    status_path = runtime_dir / "spotify-session-launch.json"
    log_path = runtime_dir / "spotify-session.log"
    command = _helper_command("login", normalized, status_path)
    flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    with _session_lock:
        if _session_process and _session_process.poll() is None:
            return {
                "ok": True,
                "message": "The EveOS Spotify session window is already open. Use that window to sign in and view the playlist.",
                "sessionReady": True,
                **normalized,
            }
        try:
            previous = json.loads(status_path.read_text(encoding="utf-8")) if status_path.exists() else {}
        except (OSError, json.JSONDecodeError):
            previous = {}
        if previous.get("ok") and _pid_is_running(int(previous.get("pid") or 0)):
            return {
                "ok": True,
                "message": "The EveOS Spotify session window is already open. Use that window to sign in and view the playlist.",
                "sessionReady": True,
                **normalized,
            }
        try:
            status_path.unlink(missing_ok=True)
            with log_path.open("w", encoding="utf-8", errors="replace") as log:
                _session_process = subprocess.Popen(
                    command,
                    cwd=str(_project_root()),
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    creationflags=flags,
                    close_fds=True,
                )
        except OSError as exc:
            return {"ok": False, "reason": f"Could not open the Spotify session: {exc}"}

        deadline = time.monotonic() + 8
        status = None
        while time.monotonic() < deadline:
            if status_path.exists():
                try:
                    status = json.loads(status_path.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    status = None
                if status:
                    break
            if _session_process.poll() is not None:
                break
            time.sleep(0.1)

        if not status or not status.get("ok"):
            detail = str((status or {}).get("reason") or "").strip()
            if not detail:
                try:
                    detail = log_path.read_text(encoding="utf-8", errors="replace").strip()[-1000:]
                except OSError:
                    detail = ""
            if not detail and _session_process.poll() is None:
                detail = "The browser did not confirm that its window was ready."
            _session_process = None
            return {
                "ok": False,
                "reason": f"Could not open the EveOS Spotify session window. {detail}".strip(),
            }
    return {
        "ok": True,
        "message": "EveOS Spotify opened in a separate saved Edge profile. Sign in there once, verify the private playlist loads, then close that window and import again.",
        "sessionReady": True,
        **normalized,
    }


def session_action(payload: dict) -> dict:
    return open_session(str(payload.get("url") or payload.get("embed") or ""))
