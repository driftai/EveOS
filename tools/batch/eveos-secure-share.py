#!/usr/bin/env python3
"""Authenticated loopback reverse proxy used by selective Cloudflare boot modes.

The real EveOS service remains on 127.0.0.1. cloudflared points at this router,
which requires a per-launch bearer URL once, converts it to an HttpOnly cookie,
and strips the bearer from requests before forwarding them to the local origin.
"""

from __future__ import annotations

import argparse
import hmac
import http.client
import http.server
import json
import socketserver
from http import HTTPStatus
from http.cookies import SimpleCookie
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit


HOP_HEADERS = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade",
}


def clean_service(value: str) -> str:
    safe = "".join(ch for ch in str(value or "").lower() if ch.isalnum() or ch in {"-", "_"})
    return safe or "eveos"


def strip_access(raw_path: str) -> str:
    parsed = urlsplit(raw_path)
    query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != "access"]
    return urlunsplit(("", "", parsed.path or "/", urlencode(query), parsed.fragment))


class Router(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    server_version = "EveOSSecureShare/1.1"

    def __init__(self, *args, **kwargs):
        self._response_started = False
        super().__init__(*args, **kwargs)

    def send_response(self, code, message=None):
        self._response_started = True
        return super().send_response(code, message)

    def log_message(self, fmt, *args):
        print(f"[ShareRouter] {fmt % args}")

    @property
    def settings(self):
        return self.server.settings

    def _cookie_name(self) -> str:
        return f"eveos_share_{self.settings['service'].replace('-', '_')}"

    def _authorized(self) -> tuple[bool, bool]:
        expected = self.settings["token"]
        parsed = urlsplit(self.path)
        supplied = dict(parse_qsl(parsed.query, keep_blank_values=True)).get("access", "")
        if supplied and hmac.compare_digest(supplied, expected):
            return True, True
        cookie = SimpleCookie()
        try:
            cookie.load(self.headers.get("Cookie", ""))
        except Exception:
            return False, False
        morsel = cookie.get(self._cookie_name())
        return (bool(morsel) and hmac.compare_digest(morsel.value, expected)), False

    def _deny(self):
        body = (
            "<!doctype html><meta charset='utf-8'><title>EveOS selective share</title>"
            "<style>body{background:#071015;color:#e9f7ff;font:16px system-ui;padding:3rem;max-width:52rem}"
            "code{color:#7fddff}</style><h1>Access link required</h1>"
            "<p>This temporary EveOS share is protected by the one-time URL printed in the host terminal.</p>"
        ).encode("utf-8")
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _redirect_after_token(self):
        target = strip_access(self.path)
        self.send_response(HTTPStatus.SEE_OTHER)
        self.send_header("Location", target or "/")
        # Selective tools can be embedded inside a separately shared EveOS
        # origin. SameSite=Strict makes that authenticated iframe lose its
        # cookie after the token redirect. SameSite=None keeps the intended
        # remote embed working; Partitioned scopes it to that top-level site on
        # browsers with CHIPS support. The random per-launch token still gates
        # access and the origin itself remains loopback-only.
        self.send_header(
            "Set-Cookie",
            f"{self._cookie_name()}={self.settings['token']}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned",
        )
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", "0")
        self.end_headers()

    def _guard(self) -> bool:
        if urlsplit(self.path).path == "/__eveos_share_health":
            return True
        allowed, fresh_token = self._authorized()
        if not allowed:
            self._deny()
            return False
        if fresh_token and self.command in {"GET", "HEAD"}:
            self._redirect_after_token()
            return False
        return True

    def _health(self):
        body = json.dumps({
            "ok": True,
            "service": "eveos-secure-share",
            "target": self.settings["origin"],
        }).encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _forward(self):
        if urlsplit(self.path).path == "/__eveos_share_health":
            return self._health()
        if not self._guard():
            return

        origin = self.settings["origin_parts"]
        connection = http.client.HTTPConnection(origin.hostname, origin.port, timeout=180)
        upstream_path = strip_access(self.path)
        try:
            connection.putrequest(self.command, upstream_path, skip_host=True, skip_accept_encoding=True)
            for key, value in self.headers.items():
                lower = key.lower()
                if lower in HOP_HEADERS or lower in {"host", "content-length", "cookie"}:
                    continue
                connection.putheader(key, value)
            connection.putheader("Host", f"{origin.hostname}:{origin.port}")
            connection.putheader("X-EveOS-Share", "1")
            connection.putheader("Connection", "close")

            cookie = SimpleCookie()
            try:
                cookie.load(self.headers.get("Cookie", ""))
            except Exception:
                cookie = SimpleCookie()
            if self._cookie_name() in cookie:
                del cookie[self._cookie_name()]
            if cookie:
                connection.putheader("Cookie", "; ".join(f"{key}={m.value}" for key, m in cookie.items()))

            transfer_encoding = str(self.headers.get("Transfer-Encoding") or "").lower()
            if transfer_encoding and transfer_encoding != "identity":
                self.send_error(HTTPStatus.LENGTH_REQUIRED, "Selective share requires Content-Length for request bodies")
                return
            content_length = int(self.headers.get("Content-Length", "0") or "0")
            connection.putheader("Content-Length", str(content_length))
            connection.endheaders()
            remaining = content_length
            while remaining > 0:
                chunk = self.rfile.read(min(64 * 1024, remaining))
                if not chunk:
                    raise ConnectionError("Client request body ended early")
                connection.send(chunk)
                remaining -= len(chunk)

            response = connection.getresponse()
            self.send_response(response.status, response.reason)
            for key, value in response.getheaders():
                lower = key.lower()
                if lower in HOP_HEADERS or lower == "content-length":
                    continue
                self.send_header(key, value)
            length = response.getheader("Content-Length")
            if length is not None:
                self.send_header("Content-Length", length)
            else:
                self.send_header("Connection", "close")
                self.close_connection = True
            self.send_header("X-EveOS-Selective-Share", self.settings["service"])
            self.end_headers()
            if self.command != "HEAD":
                while True:
                    chunk = response.read(64 * 1024)
                    if not chunk:
                        break
                    self.wfile.write(chunk)
        except (OSError, http.client.HTTPException, ConnectionError, ValueError) as exc:
            if not self._response_started:
                body = json.dumps({"ok": False, "error": f"Local origin unavailable: {exc}"}).encode("utf-8")
                self.send_response(HTTPStatus.BAD_GATEWAY)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            self.close_connection = True
        finally:
            connection.close()

    def do_GET(self): self._forward()
    def do_HEAD(self): self._forward()
    def do_POST(self): self._forward()
    def do_PUT(self): self._forward()
    def do_PATCH(self): self._forward()
    def do_DELETE(self): self._forward()
    def do_OPTIONS(self): self._forward()


class ShareServer(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


def main() -> int:
    parser = argparse.ArgumentParser(description="EveOS authenticated local share router")
    parser.add_argument("--origin", required=True)
    parser.add_argument("--listen-port", required=True, type=int)
    parser.add_argument("--token", required=True)
    parser.add_argument("--service", required=True)
    args = parser.parse_args()
    origin = urlsplit(args.origin)
    if origin.scheme != "http" or origin.hostname not in {"127.0.0.1", "localhost"} or not origin.port:
        raise SystemExit("Origin must be an explicit loopback http://127.0.0.1:<port> URL")
    if len(args.token) < 24:
        raise SystemExit("Share token is too short")

    server = ShareServer(("127.0.0.1", args.listen_port), Router)
    server.settings = {
        "origin": args.origin.rstrip("/"),
        "origin_parts": origin,
        "token": args.token,
        "service": clean_service(args.service),
    }
    print(f"[OK] Secure share router: http://127.0.0.1:{args.listen_port} -> {server.settings['origin']}")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
