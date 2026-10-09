"""Private server-to-helper RPC for the managed Spotify engine.

This module deliberately sits behind the EveOS broker. Browser clients never receive the helper
port, token, or private session id.
"""
from __future__ import annotations

from server_modules import audioflix_spotify_browser as browser
from server_modules.audioflix_spotify_browser_utils import clamp_volume, normalize_track_id


def ensure_engine(page_url: str) -> dict:
    result = browser.start({"pageUrl": str(page_url or "").strip()})
    if isinstance(result, dict):
        result["engineStartedAt"] = int(browser._manager._started_at * 1000) if browser._manager._started_at else 0
    return result


def status() -> dict:
    result = browser.status()
    result["engineStartedAt"] = int(browser._manager._started_at * 1000) if browser._manager._started_at else 0
    return result


def transport(payload: dict | None = None) -> dict:
    payload = payload if isinstance(payload, dict) else {}
    manager = browser._manager
    with manager._lock:
        if not manager._helper_status():
            return {"ok": False, "reason": "Managed Spotify engine is not running."}
        try:
            return manager._request("POST", "/transport", payload, timeout=12)
        except Exception as exc:
            manager._last_error = str(exc)[:300]
            return {"ok": False, "reason": manager._last_error}


def set_effective_volume(volume, track_id: str = "") -> dict:
    manager = browser._manager
    with manager._lock:
        if not manager._helper_status() or not manager._session_id:
            return {"ok": False, "reason": "Managed Spotify engine is not running."}
        payload = {
            "volume": clamp_volume(volume, 1),
            "trackId": normalize_track_id(track_id),
        }
        result = manager._set_volume_locked(payload, manager._session_id)
        if result.get("ok"):
            result["sessionMatch"] = True
        return result


def import_playlist(url: str) -> dict:
    return browser.list_playlist({"url": str(url or "").strip()})


def auth(open_login: bool = False, url: str = "") -> dict:
    return browser.auth({"openLogin": bool(open_login), "url": str(url or "")})
