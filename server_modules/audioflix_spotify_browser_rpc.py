"""Private server-to-helper RPC for the managed Spotify engine.

This module deliberately sits behind the EveOS broker. Browser clients never receive the helper
port, token, or private session id.
"""
from __future__ import annotations

import socket

from server_modules import audioflix_spotify_browser as browser
from server_modules import audioflix_spotify_presentation as presentation
from server_modules.audioflix_spotify_browser_utils import clamp_volume, normalize_track_id


# Keep the private helper request inside the ordinary browser client's 20s command window while
# giving slow Spotify embed renders more room than the old 12s ceiling. If this still expires, the
# structured timeout bit lets the client adopt playback that the helper may finish asynchronously.
TRANSPORT_TIMEOUT_S = 18


def _with_epoch(result: dict) -> dict:
    if isinstance(result, dict):
        result["engineStartedAt"] = int(browser._manager._started_at * 1000) if browser._manager._started_at else 0
    return result


def ensure_engine(page_url: str) -> dict:
    return _with_epoch(presentation.ensure_engine(str(page_url or "").strip()))


def status() -> dict:
    return _with_epoch(presentation.status())


def set_presentation(mode: str, page_url: str = "") -> dict:
    return _with_epoch(presentation.set_presentation({
        "mode": str(mode or ""),
        "pageUrl": str(page_url or "").strip(),
    }))


def stop_engine() -> dict:
    return _with_epoch(presentation.stop_engine({}))


def transport(payload: dict | None = None) -> dict:
    payload = payload if isinstance(payload, dict) else {}
    manager = browser._manager
    with manager._lock:
        if not manager._helper_status():
            return {"ok": False, "reason": "Managed Spotify engine is not running."}
        try:
            return manager._request("POST", "/transport", payload, timeout=TRANSPORT_TIMEOUT_S)
        except (socket.timeout, TimeoutError):
            manager._last_error = f"Managed Spotify helper did not answer within {TRANSPORT_TIMEOUT_S}s."
            return {"ok": False, "timeout": True, "reason": manager._last_error}
        except Exception as exc:
            manager._last_error = str(exc)[:300]
            return {"ok": False, "reason": manager._last_error}


# The interrupt must not take manager._lock: the in-flight transport holds it for up to 18s.
# It reads the private endpoint/token as they stand and fails closed if the helper changed.
INTERRUPT_TIMEOUT_S = 2.5
_INTERRUPT_REASONS = {"superseded", "paused", "stopped"}


def interrupt(reason: str) -> dict:
    reason = str(reason or "").strip().lower()
    if reason not in _INTERRUPT_REASONS:
        return {"ok": False, "reason": "Unsupported interrupt reason."}
    manager = browser._manager
    if not manager._port or not manager._token or not manager._process_running():
        return {"ok": False, "skipped": True, "reason": "Managed Spotify engine is not running."}
    try:
        return manager._request("POST", "/transport-interrupt", {"reason": reason}, timeout=INTERRUPT_TIMEOUT_S)
    except Exception as exc:
        return {"ok": False, "reason": str(exc)[:200]}


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
    if open_login:
        presentation.restore_for_auth()
    return browser.auth({"openLogin": bool(open_login), "url": str(url or "")})
