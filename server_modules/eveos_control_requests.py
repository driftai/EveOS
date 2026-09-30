"""Control-plane request parsing and narrowly scoped extension authority."""
from __future__ import annotations

import base64
import hashlib
import json
from functools import lru_cache
from pathlib import Path
from urllib.parse import parse_qs, urlparse


def valid_port(value):
    try:
        port = int(value)
        return port if 1 <= port <= 65535 else None
    except (TypeError, ValueError):
        return None


def request_web_port(handler, discover_file_web_port):
    query = parse_qs(urlparse(handler.path).query)
    if query.get("port"):
        requested = valid_port(query["port"][0])
        if requested is not None:
            return requested
    origin = str(handler.headers.get("Origin", "")).strip()
    if not origin or origin == "null" or origin.lower().startswith("file:"):
        return discover_file_web_port()
    try:
        parsed = urlparse(origin)
        if parsed.scheme not in {"http", "https"} or (parsed.hostname or "").lower() not in {"127.0.0.1", "localhost", "::1"}:
            return None
        return valid_port(parsed.port)
    except ValueError:
        return None


@lru_cache(maxsize=1)
def bridge_origin() -> str:
    manifest = Path(__file__).resolve().parent.parent / "extension" / "manifest.base.json"
    key = json.loads(manifest.read_text(encoding="utf-8"))["key"]
    digest = hashlib.sha256(base64.b64decode(key, validate=True)).digest()[:16]
    extension_id = "".join(chr(ord("a") + int(nibble, 16)) for nibble in digest.hex())
    return f"chrome-extension://{extension_id}"


def can_start_nexus(handler, path: str) -> bool:
    if path != "/api/nexus-browser/start":
        return False
    client = str(handler.client_address[0]).removeprefix("::ffff:")
    if client not in {"127.0.0.1", "::1"}:
        return False
    headers = handler.headers
    if any(headers.get(name) for name in ("X-EveOS-Share", "Forwarded", "X-Forwarded-For", "X-Forwarded-Host", "X-Forwarded-Proto")):
        return False
    port = handler.server.server_address[1]
    if str(headers.get("Host", "")).lower() not in {f"127.0.0.1:{port}", f"localhost:{port}", f"[::1]:{port}"}:
        return False
    try:
        return str(headers.get("Origin", "")).lower() == bridge_origin()
    except (OSError, ValueError, KeyError):
        return False
