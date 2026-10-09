"""Strict HTTP surface for the any-browser Spotify broker and relay."""
from __future__ import annotations

import json
from http import HTTPStatus
from urllib.parse import urlsplit

from server_modules import audioflix_spotify_broker as broker
from server_modules import audioflix_spotify_relay as relay


def _client_is_loopback(handler) -> bool:
    host = str(handler.client_address[0] if handler.client_address else "")
    if host.startswith("::ffff:"):
        host = host[7:]
    return host in {"127.0.0.1", "::1"}


def _server_origin(handler) -> str:
    port = int(getattr(handler.server, "server_address", ("", 0))[1] or 0)
    raw_host = str(handler.headers.get("Host", "")).strip()
    host = raw_host.rsplit(":", 1)[0].strip("[]").lower() if raw_host else "127.0.0.1"
    if host not in {"127.0.0.1", "localhost", "::1"}:
        host = "127.0.0.1"
    shown = f"[{host}]" if ":" in host else host
    return f"http://{shown}:{port}"


def _same_origin_post(handler) -> bool:
    if not _client_is_loopback(handler):
        return False
    origin = str(handler.headers.get("Origin", "")).strip().lower()
    return bool(origin and origin == _server_origin(handler).lower())


def _read_json(handler) -> dict:
    try:
        length = int(handler.headers.get("Content-Length", "0") or 0)
        if length <= 0 or length > 128 * 1024:
            return {}
        value = json.loads(handler.rfile.read(length).decode("utf-8", errors="replace"))
        return value if isinstance(value, dict) else {}
    except Exception:
        return {}


def _send_json(handler, payload: dict, status: int = HTTPStatus.OK) -> None:
    body = json.dumps(payload).encode("utf-8")
    handler.send_response(status)
    handler.send_header("Content-Type", "application/json; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def _send_html(handler, source: str, *, approval: bool = False) -> None:
    body = source.encode("utf-8")
    handler.send_response(HTTPStatus.OK)
    handler.send_header("Content-Type", "text/html; charset=utf-8")
    handler.send_header("Cache-Control", "no-store")
    handler.send_header("X-Content-Type-Options", "nosniff")
    handler.send_header("Referrer-Policy", "no-referrer")
    if approval:
        handler.send_header("X-Frame-Options", "DENY")
        handler.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'")
    else:
        handler.send_header("Content-Security-Policy", "default-src 'none'; script-src 'unsafe-inline'; connect-src 'self'; frame-ancestors * file:; base-uri 'none'; form-action 'none'")
    handler.send_header("Content-Length", str(len(body)))
    handler.end_headers()
    handler.wfile.write(body)


def handle_get_request(handler, path: str, query) -> bool:
    if path not in {"/api/audioflix/spotify-relay", "/api/audioflix/spotify-approval"}:
        return False
    if not _client_is_loopback(handler):
        _send_json(handler, {"ok": False, "reason": "Local access required."}, HTTPStatus.FORBIDDEN)
        return True
    if path == "/api/audioflix/spotify-relay":
        _send_html(handler, relay.relay_html(_server_origin(handler)))
        return True
    pair_id = str((query.get("pair") or [""])[0])
    _send_html(handler, relay.approval_html(broker.pairing_view(pair_id)), approval=True)
    return True


def handle_post_request(handler, path: str) -> bool:
    routes = {
        "/api/audioflix/spotify-client/connect",
        "/api/audioflix/spotify-client/pair-status",
        "/api/audioflix/spotify-client/approve",
        "/api/audioflix/spotify-client/command",
    }
    if path not in routes:
        return False
    if not _same_origin_post(handler):
        _send_json(handler, {"ok": False, "reason": "Trusted EveOS relay origin required."}, HTTPStatus.FORBIDDEN)
        return True
    payload = _read_json(handler)
    context = {"serverOrigin": _server_origin(handler)}
    if path.endswith("/connect"):
        result = broker.connect(payload, context)
    elif path.endswith("/pair-status"):
        result = broker.pair_status(payload)
    elif path.endswith("/approve"):
        result = broker.approve(payload)
    else:
        result = broker.command(payload, context)
    _send_json(handler, result, HTTPStatus.OK if result.get("ok") else HTTPStatus.BAD_REQUEST)
    return True
