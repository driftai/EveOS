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
from urllib.parse import urlsplit

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
    try:
        query = urlsplit(match.group(0)).query
    except ValueError:
        query = ""
    suffix = f"?{query}" if query else ""
    return {
        "ok": True,
        "playlistId": playlist_id,
        # Keep Spotify share parameters intact. Private-share URLs use pt= as an access capability;
        # removing it leaves the playlist shell visible while the song rows remain unavailable.
        "url": f"https://open.spotify.com/playlist/{playlist_id}{suffix}",
        "embedUrl": f"https://open.spotify.com/embed/playlist/{playlist_id}{suffix}",
    }


def _cache_key(normalized: dict) -> str:
    # Distinguish a tokenized/private share from the same bare playlist id. Reusing a bare-url cache
    # entry for a pt= URL can preserve a failed shell-only scrape for the otherwise accessible share.
    return str(normalized.get("url") or normalized.get("playlistId") or "")


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
    # Public playlists start on the lighter embed surface. Private-share URLs (pt=) go straight to
    # the full saved-session player so their access capability is not degraded into a shell-only
    # embed before extraction. Query parameters remain intact on either route.
    query = urlsplit(str(normalized.get("url") or "")).query
    has_private_token = any(part.startswith("pt=") for part in query.split("&") if part)
    target_url = normalized["url"] if mode == "login" or has_private_token else normalized["embedUrl"]
    command = [
        "node",
        str(_project_root() / "server_modules" / "audioflix_spotify_scrape.js"),
        mode,
        target_url,
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
    cache_key = _cache_key(normalized)
    if not force:
        cached = _cache_get(cache_key)
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
        _cache_set(cache_key, payload)
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


def resolve_playback_source(payload: dict) -> dict:
    """Map a Spotify identity to a stable provider URL without downloading or localizing it."""
    track = payload.get("track") if isinstance(payload, dict) else {}
    track = track if isinstance(track, dict) else {}
    identity_url = str(track.get("url") or "").strip()
    if not identity_url:
        return {"ok": False, "reason": "Missing Spotify track URL."}

    from server_modules import audioflix_spotify_fallback as fallback

    track_key = str(track.get("spotifyTrackId") or track.get("id") or identity_url).strip()
    cache_key = f"playback:{track_key}"
    cached = _cache_get(cache_key)
    if cached:
        return cached

    metadata = fallback.stored_track_metadata(track)
    result = fallback.find_fallback_match(identity_url, metadata=metadata or None)
    matched_url = str(result.get("url") or "").strip()
    if not matched_url:
        reason = str(result.get("reason") or result.get("error") or "No verified playback source matched this Spotify track.").strip()
        return {
            "ok": False,
            "reason": reason,
            "resolver": fallback.STRATEGY,
            "identityUrl": identity_url,
        }

    match = result.get("match") if isinstance(result.get("match"), dict) else {}
    response = {
        "ok": True,
        "url": matched_url,
        "provider": str(match.get("source") or "").strip(),
        "title": str(match.get("title") or track.get("title") or "").strip(),
        "resolver": fallback.STRATEGY,
        "identityUrl": identity_url,
        "toleranceSeconds": result.get("toleranceSeconds"),
    }
    _cache_set(cache_key, response)
    return response


def session_action(payload: dict) -> dict:
    if str(payload.get("action") or "").strip().lower() == "resolve-playback-source":
        return resolve_playback_source(payload)
    return open_session(str(payload.get("url") or payload.get("embed") or ""))
