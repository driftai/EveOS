"""Stable HTTP facade for the local Audioflix audio bridge."""

from __future__ import annotations

import json
import logging
from urllib.parse import urlsplit
from http import HTTPStatus

logger = logging.getLogger("EveOSAudioflixBridge")

from server_modules import audioflix_provider_file_auth as _file_auth
_file_auth.initialize()

from server_modules.audioflix_bridge_devices import list_devices
from server_modules.audioflix_bridge_playback import (
    clear_voices,
    get_voice_debug,
    play_media,
    play_pcm,
    play_tone,
    play_voice,
    pause_voices,
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


def _can_start_provider_capture(handler) -> bool:
    """Authorize same-origin localhost OR a file:// EveOS with a private on-disk key.

    The key is generated on server startup, loaded from file:// by the installed
    EveOS page, and BLOCKED from localhost HTTP/HEAD responses. Origin:null alone
    cannot authorize anything: other opaque origins can send that value too.
    """
    if not _can_control(handler):
        return False
    try:
        if str(handler.headers.get("Content-Type", "")).split(";", 1)[0].strip().lower() != "application/json":
            return False
        if handler.headers.get("X-EveOS-Provider-Capture") != "v1":
            return False
        origin_header = str(handler.headers.get("Origin", "")).strip()
        fetch_site = str(handler.headers.get("Sec-Fetch-Site", "")).strip().lower()
        # Chromium can omit Origin/Sec-Fetch-Site entirely for a file:// fetch.
        # The installation-local capability remains the authority in either
        # browser form; a missing Origin without that proof is still denied.
        if origin_header in {"", "null"} or origin_header.startswith("file://"):
            return bool(fetch_site in {"cross-site", "none", ""} and
                _file_auth.verify(handler.headers.get("X-EveOS-Provider-File-Auth") or ""))
        origin = urlsplit(origin_header)
        host = urlsplit("http://" + str(handler.headers.get("Host", "")).strip())
        bound_port = int(handler.server.server_address[1])
        if origin.scheme != "http" or origin.hostname not in {"127.0.0.1", "localhost"}:
            return False
        if host.hostname != origin.hostname or host.port != bound_port or origin.port != bound_port:
            return False
        if origin.username or origin.password or origin.path or origin.query or origin.fragment:
            return False
        if host.username or host.password or host.path or host.query or host.fragment:
            return False
        return not fetch_site or fetch_site == "same-origin"
    except (ValueError, TypeError, AttributeError):
        return False


def _can_cli_control(handler) -> bool:
    """Allow explicit localhost CLI qualification without granting browser tabs a session bypass."""
    if not _can_control(handler):
        return False
    return not str(handler.headers.get("Origin", "")).strip()


def handle_get_request(handler, path: str, query) -> bool:
    logger.info(f"[Bridge] handle_get_request: path={path}")
    from server_modules import audioflix_spotify_http
    if audioflix_spotify_http.handle_get_request(handler, path, query):
        return True
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
    elif path == "/api/audioflix/spotify-browser/status":
        if not _can_control(handler):
            _send_json(handler, {"ok": False, "message": "Forbidden."}, HTTPStatus.FORBIDDEN)
            return True
        from server_modules import audioflix_spotify_presentation
        _send_json(handler, audioflix_spotify_presentation.status())
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
        from server_modules import audioflix_spotify_browser
        values = query.get("url") or []
        raw_url = values[0] if values else ""
        normalized = audioflix_spotify.normalize_playlist_input(raw_url)
        if not normalized.get("ok"):
            _send_json(handler, normalized, HTTPStatus.BAD_REQUEST)
            return True

        managed = audioflix_spotify_browser.status()
        if managed.get("helperReachable"):
            payload = audioflix_spotify_browser.list_playlist({"url": normalized.get("url") or raw_url})
            if isinstance(payload, dict) and payload.get("ok"):
                payload.update({
                    "url": normalized.get("url") or raw_url,
                    "embedUrl": normalized.get("embedUrl") or "",
                    "provider": "spotify",
                    "cached": False,
                    "managedBrowserImport": True,
                })
        else:
            payload = audioflix_spotify.list_playlist(
                raw_url,
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


def hotkeys_bypass(payload: dict) -> dict:
    from server_modules import audioflix_hotkeys
    return audioflix_hotkeys.set_bypassed(payload)


def localize_track(payload: dict) -> dict:
    from server_modules import audioflix_localize
    return audioflix_localize.localize_one(payload)


def localize_spotify_fallback(payload: dict) -> dict:
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
    from server_modules import audioflix_spotify_browser

    action = str(payload.get("action") or "").strip().lower()
    if action == "resolve-playback-source":
        return audioflix_spotify.session_action(payload)
    managed = audioflix_spotify_browser.status()
    if managed.get("helperReachable"):
        return spotify_browser_auth({
            "openLogin": True,
            "url": str(payload.get("url") or payload.get("embed") or "https://open.spotify.com/"),
        })
    return audioflix_spotify.session_action(payload)


def spotify_browser_start(payload: dict) -> dict:
    from server_modules import audioflix_spotify_presentation
    page_url = str(payload.get("pageUrl") or "http://127.0.0.1:8765/audioflix-spotify-engine.html")
    return audioflix_spotify_presentation.ensure_engine(page_url)


def spotify_browser_presentation(payload: dict) -> dict:
    from server_modules import audioflix_spotify_presentation
    return audioflix_spotify_presentation.set_presentation(payload)


def spotify_browser_stop(payload: dict) -> dict:
    from server_modules import audioflix_spotify_presentation
    return audioflix_spotify_presentation.stop_engine(payload)


def spotify_browser_session_status(payload: dict) -> dict:
    from server_modules import audioflix_spotify_browser
    return audioflix_spotify_browser.session_status(payload)


def spotify_browser_volume(payload: dict) -> dict:
    from server_modules import audioflix_spotify_browser
    return audioflix_spotify_browser.set_volume(payload)


def spotify_browser_qualify_volume(payload: dict) -> dict:
    from server_modules import audioflix_spotify_browser
    return audioflix_spotify_browser.qualify_volume(payload)


def spotify_browser_auth(payload: dict) -> dict:
    from server_modules import audioflix_spotify_browser
    from server_modules import audioflix_spotify_presentation
    if bool(payload.get("openLogin", True)):
        audioflix_spotify_presentation.restore_for_auth(str(payload.get("pageUrl") or ""))
    return audioflix_spotify_browser.auth(payload)


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
    from server_modules import audioflix_instagram_playback
    return audioflix_instagram_playback.resolve_video(payload)


def save_soundlab_recording(payload: dict) -> dict:
    from server_modules.audioflix_soundlab_recording import save_recording
    return save_recording(payload)


def handle_post_request(handler, path: str) -> bool:
    from server_modules import audioflix_spotify_http
    if audioflix_spotify_http.handle_post_request(handler, path):
        return True
    if path.startswith("/api/audioflix/provider-capture/"):
        if path == "/api/audioflix/provider-capture/start" and not _can_start_provider_capture(handler):
            _send_json(handler, {
                "ok": False,
                "message": "Provider capture requires the localhost EveOS page or the verified file:// install credential."
            }, HTTPStatus.FORBIDDEN)
            return True
        if not _can_control(handler):
            _send_json(handler, {"ok": False, "message": "Local access required."}, HTTPStatus.FORBIDDEN)
            return True
        # Unlike ordinary application metadata requests, realtime PCM must never
        # accept an arbitrarily large request body from a localhost caller.
        try:
            body_bytes = int(handler.headers.get("Content-Length", "0") or 0)
        except (TypeError, ValueError):
            body_bytes = -1
        if not 0 < body_bytes <= 128 * 1024:
            _send_json(handler, {"ok": False, "message": "Invalid provider capture request size."}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return True
        try:
            from server_modules.audioflix_provider_capture import handle
            _send_json(handler, handle(path, _read_json(handler)))
        except Exception as exc:
            _send_json(handler, {"ok": False, "message": str(exc)}, HTTPStatus.BAD_REQUEST)
        return True
    if path == "/api/audioflix/spotify-browser/qualify-volume":
        if not _can_cli_control(handler):
            _send_json(handler, {"ok": False, "message": "CLI localhost access required."}, HTTPStatus.FORBIDDEN)
            return True
        try:
            _send_json(handler, spotify_browser_qualify_volume(_read_json(handler)))
        except Exception as exc:
            _send_json(handler, {"ok": False, "message": str(exc)}, HTTPStatus.BAD_REQUEST)
        return True

    action = {
        "/api/audioflix/play-pcm": play_pcm,
        "/api/audioflix/play-tone": play_tone,
        "/api/audioflix/play-media": play_media,
        "/api/audioflix/play-voice": play_voice,
        "/api/audioflix/set-voice-volume": set_voice_volume,
        "/api/audioflix/clear-voices": clear_voices,
        "/api/audioflix/pause-voices": pause_voices,
        "/api/audioflix/stop-stream": stop_stream,
        "/api/audioflix/warm": warm,
        "/api/audioflix/hotkeys/set": hotkeys_set,
        "/api/audioflix/hotkeys/clear": hotkeys_clear,
        "/api/audioflix/hotkeys/bypass": hotkeys_bypass,
        "/api/audioflix/localize": localize_track,
        "/api/audioflix/localize-spotify-fallback": localize_spotify_fallback,
        "/api/audioflix/localize-scan": localize_scan,
        "/api/audioflix/localize-link": localize_link,
        "/api/audioflix/wpl-read": wpl_read,
        "/api/audioflix/spotify-session": spotify_session,
        "/api/audioflix/spotify-browser/start": spotify_browser_start,
        "/api/audioflix/spotify-browser/presentation": spotify_browser_presentation,
        "/api/audioflix/spotify-browser/stop": spotify_browser_stop,
        "/api/audioflix/spotify-browser/session-status": spotify_browser_session_status,
        "/api/audioflix/spotify-browser/volume": spotify_browser_volume,
        "/api/audioflix/spotify-browser/auth": spotify_browser_auth,
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
