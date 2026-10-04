"""Stable HTTP facade for the local Audioflix audio bridge."""

from __future__ import annotations

import json
import logging
from http import HTTPStatus

logger = logging.getLogger("EveOSAudioflixBridge")

from server_modules.audioflix_bridge_devices import list_devices
from server_modules.audioflix_bridge_playback import (
    clear_voices,
    get_voice_debug,
    play_media,
    play_pcm,
    play_tone,
    play_voice,
    set_voice_volume,
    stop_stream,
    warm,
)


def _send_json(handler, payload: dict, status: int = HTTPStatus.OK) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    origin = str(handler.headers.get("Origin", "")).strip().lower()
    if origin.startswith("chrome-extension://"):
        handler.send_header("Access-Control-Allow-Origin", origin)
        handler.send_header("Vary", "Origin")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _read_json(handler) -> dict:
    try:
        length = int(handler.headers.get("Content-Length", "0") or 0)
        if length > 0:
            parsed = json.loads(handler.rfile.read(length).decode("utf-8", errors="replace"))
            return parsed if isinstance(parsed, dict) else {}
    except Exception:
        pass
    return {}


def _can_control(handler) -> bool:
    host = str(handler.client_address[0] if handler.client_address else "")
    if host.startswith("::ffff:"):
        host = host[7:]
    logger.info(f"[Bridge] _can_control: host='{host}' (allowed: {host in {'127.0.0.1', '::1'}})")
    if host not in {"127.0.0.1", "::1"}:
        return False
    origin = str(handler.headers.get("Origin", "")).strip().lower()
    if origin.startswith("chrome-extension://"):
        return True
    return not origin or origin == "null" or origin.startswith("file://") or origin.startswith("http://127.0.0.1:") or origin.startswith("http://localhost:")


def handle_get_request(handler, path: str, query) -> bool:
    logger.info(f"[Bridge] handle_get_request: path={path}")
    if path == "/api/audioflix/status":
        _send_json(handler, {**list_devices(), "devices": []})
    elif path == "/api/audioflix/devices":
        _send_json(handler, list_devices(force=bool(query.get("refresh") or query.get("force"))))
    elif path == "/api/audioflix/voice-debug":
        if not _can_control(handler):
            _send_json(handler, {"ok": False, "message": "Forbidden."}, HTTPStatus.FORBIDDEN)
            return True
        _send_json(handler, {"ok": True, "players": get_voice_debug()})
    elif path == "/api/audioflix/hotkeys/status":
        if not _can_control(handler):
            _send_json(handler, {"ok": False, "message": "Forbidden."}, HTTPStatus.FORBIDDEN)
            return True
        from server_modules import audioflix_hotkeys
        _send_json(handler, audioflix_hotkeys.status())
    elif path == "/api/audioflix/resolve-url":
        if not _can_control(handler):
            _send_json(handler, {"ok": False, "message": "Forbidden."}, HTTPStatus.FORBIDDEN)
            return True
        from server_modules import audioflix_ytdl
        audioflix_ytdl.handle_resolve_request(handler, query)
        return True
    elif path == "/api/audioflix/playlist":
        if not _can_control(handler):
            _send_json(handler, {"ok": False, "message": "Forbidden."}, HTTPStatus.FORBIDDEN)
            return True
        from server_modules import audioflix_playlist
        audioflix_playlist.handle_playlist_request(handler, query)
        return True
    elif path == "/api/audioflix/spotify-playlist":
        if not _can_control(handler):
            _send_json(handler, {"ok": False, "message": "Forbidden."}, HTTPStatus.FORBIDDEN)
            return True
        from server_modules import audioflix_spotify
        values = query.get("url") or []
        payload = audioflix_spotify.list_playlist(
            values[0] if values else "",
            force=bool(query.get("refresh") or query.get("force")),
        )
        _send_json(handler, payload)
        return True
    elif path.startswith("/api/audioflix/port/"):
        if not _can_control(handler):
            _send_json(handler, {"ok": False, "message": "Forbidden."}, HTTPStatus.FORBIDDEN)
            return True
        from server_modules import audioflix_bridge_ports
        return audioflix_bridge_ports.handle_port_get_request(handler, path, query, _send_json)
    else:
        return False
    return True


def hotkeys_set(payload: dict) -> dict:
    from server_modules import audioflix_hotkeys
    return audioflix_hotkeys.set_bindings(payload)


def hotkeys_clear(payload: dict) -> dict:
    from server_modules import audioflix_hotkeys
    return audioflix_hotkeys.clear_all()


def localize_track(payload: dict) -> dict:
    from server_modules import audioflix_localize
    return audioflix_localize.localize_one(payload)


def localize_spotify_fallback(payload: dict) -> dict:
    # Deliberately separate from /localize so the alternate Spotify resolver can never silently
    # activate when the normal localizer fails. The browser only calls this endpoint after an
    # explicit fallback action.
    from server_modules import audioflix_spotify_fallback
    return audioflix_spotify_fallback.localize_one(payload)


def localize_scan(payload: dict) -> dict:
    from server_modules import audioflix_localize
    return audioflix_localize.scan_dir(payload)


def localize_link(payload: dict) -> dict:
    from server_modules import audioflix_localize
    return audioflix_localize.link_into(payload)


def wpl_read(payload: dict) -> dict:
    from server_modules import audioflix_localize
    return audioflix_localize.read_wpl(payload)


def spotify_session(payload: dict) -> dict:
    from server_modules import audioflix_spotify
    return audioflix_spotify.session_action(payload)


def instagram_session_import(payload: dict) -> dict:
    from server_modules import audioflix_instagram_session
    return audioflix_instagram_session.import_cookies(payload)


def instagram_session_connect_browser(payload: dict) -> dict:
    from server_modules import audioflix_instagram_session
    return audioflix_instagram_session.connect_browser()


def instagram_session_status(payload: dict) -> dict:
    from server_modules import audioflix_instagram_session
    return audioflix_instagram_session.status()


def instagram_session_clear(payload: dict) -> dict:
    from server_modules import audioflix_instagram_session
    return audioflix_instagram_session.clear()


def instagram_collection(payload: dict) -> dict:
    from server_modules import audioflix_instagram_import
    return audioflix_instagram_import.list_collection(payload)


def instagram_video(payload: dict) -> dict:
    # Playback/recovery is media-only. Rich Instagram metadata is intentionally deferred and is
    # never invoked from the normal playback endpoint.
    from server_modules import audioflix_instagram_playback
    return audioflix_instagram_playback.resolve_video(payload)


def save_soundlab_recording(payload: dict) -> dict:
    from server_modules.audioflix_soundlab_recording import save_recording
    return save_recording(payload)


def handle_post_request(handler, path: str) -> bool:
    action = {
        "/api/audioflix/play-pcm": play_pcm,
        "/api/audioflix/play-tone": play_tone,
        "/api/audioflix/play-media": play_media,
        "/api/audioflix/play-voice": play_voice,
        "/api/audioflix/set-voice-volume": set_voice_volume,
        "/api/audioflix/clear-voices": clear_voices,
        "/api/audioflix/stop-stream": stop_stream,
        "/api/audioflix/warm": warm,
        "/api/audioflix/hotkeys/set": hotkeys_set,
        "/api/audioflix/hotkeys/clear": hotkeys_clear,
        "/api/audioflix/localize": localize_track,
        "/api/audioflix/localize-spotify-fallback": localize_spotify_fallback,
        "/api/audioflix/localize-scan": localize_scan,
        "/api/audioflix/localize-link": localize_link,
        "/api/audioflix/wpl-read": wpl_read,
        "/api/audioflix/spotify-session": spotify_session,
        "/api/audioflix/instagram-session": instagram_session_import,
        "/api/audioflix/instagram-session/connect-browser": instagram_session_connect_browser,
        "/api/audioflix/instagram-session/status": instagram_session_status,
        "/api/audioflix/instagram-session/clear": instagram_session_clear,
        "/api/audioflix/instagram-collection": instagram_collection,
        "/api/audioflix/instagram-video": instagram_video,
        "/api/audioflix/save-soundlab-recording": save_soundlab_recording,
    }.get(path)
    if not action:
        return False
    if not _can_control(handler):
        _send_json(handler, {"ok": False, "message": "Local access required."}, HTTPStatus.FORBIDDEN)
        return True
    try:
        _send_json(handler, action(_read_json(handler)))
    except Exception as exc:
        _send_json(handler, {"ok": False, "message": str(exc)}, HTTPStatus.BAD_REQUEST)
    return True