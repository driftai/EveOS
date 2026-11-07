"""Private in-memory Spotify session handoff between the two server-owned playback hosts."""
from __future__ import annotations


def acquire(manager=None) -> dict:
    # Import lazily so the managed browser remains the sole lifecycle owner and this module adds
    # no parallel process, token, endpoint, or persistent credential store.
    if manager is None:
        from server_modules import audioflix_spotify_browser
        manager = audioflix_spotify_browser._manager
    with manager._lock:
        if not manager._helper_status():
            # The Direct host owns a separate persistent Electron partition. If the managed
            # helper is *stopped*, the host can authenticate with its own existing cookies.
            # Only Electron may inspect that partition; the server sends no cookie values.
            running = getattr(manager, "_process_running", None)
            if callable(running) and not running():
                return {"ok": True, "version": 1, "mode": "reuse-persisted", "cookies": []}
            return {"ok": False, "reason": "Managed Spotify helper is running but not ready."}
        try:
            result = manager._request("POST", "/auth-handoff", {}, timeout=4)
        except Exception as exc:
            return {"ok": False, "reason": f"Managed Spotify session handoff failed: {exc}"}
    if not result.get("ok") or result.get("authState") != "signed-in":
        return {"ok": False, "reason": result.get("reason") or "Managed Spotify session is not signed in."}
    cookies = result.get("cookies")
    if not isinstance(cookies, list) or not cookies:
        return {"ok": False, "reason": "Managed Spotify session returned no authenticated handoff."}
    return {"ok": True, "version": 1, "cookies": cookies}
