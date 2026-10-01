#!/usr/bin/env python3
"""Loopback-only HTTP surface for the independent EveOS Notes workspace."""

from __future__ import annotations

import argparse
import http.server
import json
import os
import sys
from http import HTTPStatus
from urllib.parse import urlparse


SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SERVER_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from server_modules import eveos_ports, notes_workspace  # noqa: E402
from server_modules.eveos_http_cors import eveos_cors_origin  # noqa: E402


class NotesHandler(http.server.BaseHTTPRequestHandler):
    server_version = "EveOSNotes/1.0"

    def end_headers(self):
        origin = eveos_cors_origin(self.headers.get("Origin"))
        if origin is not None:
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Requested-With")
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in {"/api/health", "/api/notes/status"}:
            self._send({
                "ok": True,
                "service": "eveos-notes",
                "appVersion": "1.0",
                "state": "running",
                "running": True,
                "port": self.server.server_port,
                "message": "EveOS Notes is ready.",
            })
            return
        if notes_workspace.handle_get_request(self, path):
            return
        self._send({"ok": False, "message": "Unknown Notes endpoint."}, HTTPStatus.NOT_FOUND)

    def do_POST(self):
        path = urlparse(self.path).path
        if notes_workspace.handle_post_request(self, path):
            return
        self._send({"ok": False, "message": "Unknown Notes endpoint."}, HTTPStatus.NOT_FOUND)

    def log_message(self, fmt, *args):
        print("[EveOSNotes] " + (fmt % args))

    def _send(self, payload: dict, status: int = HTTPStatus.OK):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def main() -> int:
    parser = argparse.ArgumentParser(description="EveOS Notes service")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=eveos_ports.service_port("NOTES_PORT"))
    args = parser.parse_args()
    if args.host not in {"127.0.0.1", "localhost"}:
        raise SystemExit("EveOS Notes accepts loopback binding only.")
    server = http.server.ThreadingHTTPServer(("127.0.0.1", args.port), NotesHandler)
    server.daemon_threads = True
    print(f"[OK] EveOS Notes ready at http://127.0.0.1:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
