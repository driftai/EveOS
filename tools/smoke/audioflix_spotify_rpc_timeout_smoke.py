"""Managed Spotify transport timeout contract; no browser launch or Spotify network access."""

from __future__ import annotations

import os
import socket
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server_modules import audioflix_spotify_browser_rpc as rpc


manager = rpc.browser._manager
original_helper_status = manager._helper_status
original_request = manager._request
original_last_error = manager._last_error
seen = {}

try:
    manager._helper_status = lambda: {"ok": True}

    def timeout_request(method, route, body=None, timeout=0):
        seen.update({"method": method, "route": route, "body": body, "timeout": timeout})
        raise socket.timeout("timed out")

    manager._request = timeout_request
    result = rpc.transport({"action": "play", "spotifyId": "4cOdK2wGLETKBW3PvgPWqT"})

    assert rpc.TRANSPORT_TIMEOUT_S > 12.6, "the observed 12.6s slow render must fit inside the RPC budget"
    assert rpc.TRANSPORT_TIMEOUT_S < 20, "server timeout must resolve before the browser client's 20s command budget"
    assert seen["method"] == "POST" and seen["route"] == "/transport"
    assert seen["timeout"] == rpc.TRANSPORT_TIMEOUT_S
    assert result["ok"] is False and result["timeout"] is True
    assert "did not answer" in result["reason"]
finally:
    manager._helper_status = original_helper_status
    manager._request = original_request
    manager._last_error = original_last_error

print("AUDIOFLIX_SPOTIFY_RPC_TIMEOUT_SMOKE_OK")
