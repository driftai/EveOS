"""Isolated Audioflix HTTP routes for the optional, supported-browser Spotify embed.

The stable audioflix_bridge facade remains under its repository line-count guard.
"""
from http import HTTPStatus


def handle_get_request(handler, path, query, send_json, can_control):
    if path not in {"/api/audioflix/spotify-edge/status", "/api/audioflix/spotify-edge/controls"}:
        return False
    if not can_control(handler):
        send_json(handler, {"ok": False, "message": "Local access required."}, HTTPStatus.FORBIDDEN)
        return True
    from server_modules import audioflix_spotify_edge
    if path.endswith("/status"):
        send_json(handler, audioflix_spotify_edge.status())
    else:
        send_json(handler, audioflix_spotify_edge.controls(handler.headers.get("X-EveOS-Edge-Session", "")))
    return True


def handle_post_request(handler, path, send_json, read_json, can_control,
                        can_start_provider_capture):
    if path not in {"/api/audioflix/spotify-edge/event", "/api/audioflix/spotify-edge/command"}:
        return False
    is_event = path.endswith("/event")
    allowed = can_start_provider_capture(handler) if is_event else can_control(handler)
    if not allowed:
        send_json(handler, {"ok": False, "message": "Local authorized EveOS page required."},
                  HTTPStatus.FORBIDDEN)
        return True
    try:
        length = int(handler.headers.get("Content-Length", "0") or 0)
        if not 0 < length <= 32768:
            send_json(handler, {"ok": False, "message": "Invalid payload size."}, HTTPStatus.BAD_REQUEST)
            return True
        from server_modules import audioflix_spotify_edge
        body = read_json(handler)
        if length > 4096 and (is_event or not isinstance(body, dict) or body.get('action') != 'queue-arm'):
            send_json(handler, {'ok': False, 'message': 'Large payload permitted only for bounded native queue plans.'}, HTTPStatus.BAD_REQUEST)
            return True
        result = (audioflix_spotify_edge.event(body) if is_event else
                  audioflix_spotify_edge.command(body, int(handler.server.server_address[1])))
        send_json(handler, result)
    except Exception as exc:
        send_json(handler, {"ok": False, "message": str(exc)}, HTTPStatus.BAD_REQUEST)
    return True
