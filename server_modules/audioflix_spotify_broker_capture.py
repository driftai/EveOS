"""Owner-fenced managed Spotify PCM capture commands."""
from __future__ import annotations

from server_modules import audioflix_spotify_browser_rpc as engine


def execute(broker, client_id: str, action: str, args: dict) -> dict | None:
    if action not in {"engine-capture-start", "engine-capture-stop"}:
        return None
    verb = "routing managed Spotify audio" if action.endswith("start") else "stopping managed Spotify audio routing"
    blocked = broker._owner_block(client_id, verb)
    if blocked:
        return blocked
    if action == "engine-capture-start":
        device_id = str(args.get("deviceId") or "").strip()[:80]
        if not device_id.startswith("sd:"):
            return {"ok": False, "reason": "An exact native output endpoint is required."}
        result = engine.start_provider_capture(device_id, str(args.get("label") or "").strip()[:180])
    else:
        result = engine.stop_provider_capture()
    return {**broker._state(client_id), "captureResult": result, "ok": bool(result.get("ok"))}
