"""Bounded status watch for the managed Spotify engine without browser timer ownership."""
from __future__ import annotations

import time

from server_modules import audioflix_spotify_connections as connections

_MAX_WAIT_MS = 15_000
_POLL_MS = 200


def _int(value) -> int:
    try:
        return max(0, int(value or 0))
    except (TypeError, ValueError):
        return 0


def _marker(state: dict) -> tuple[int, int, int, int]:
    engine = state.get("engine") if isinstance(state.get("engine"), dict) else {}
    return (
        _int(engine.get("eventCursor")),
        _int(state.get("ownerEpoch")),
        _int(state.get("engineEpoch")),
        _int(state.get("trackGeneration")),
    )


def _baseline(args: dict) -> tuple[int, int, int, int] | None:
    keys = ("afterCursor", "afterOwnerEpoch", "afterEngineEpoch", "afterTrackGeneration")
    if not any(key in args for key in keys):
        return None
    return tuple(_int(args.get(key)) for key in keys)


def watch(broker, payload: dict) -> dict:
    """Wait for one durable engine/ownership marker change, never holding the transport lock."""
    payload = payload if isinstance(payload, dict) else {}
    command = payload.get("command") if isinstance(payload.get("command"), dict) else {}
    args = command.get("payload") if isinstance(command.get("payload"), dict) else {}
    connection_id = str(command.get("connectionId") or "").strip()[:120]
    token = str(payload.get("clientToken") or "").strip()[:200]

    with broker._lock:  # package-internal: same authorization contract as broker.command()
        broker._expire_locked()
        client = broker._authorized_client_locked(token)
        if not client:
            return {"ok": False, "reason": "Spotify client authorization is missing or expired."}
        if not connections.current(client, connection_id):
            return connections.rejected()
        client_id = client["clientId"]

    baseline = _baseline(args)
    wait_ms = min(_MAX_WAIT_MS, _int(args.get("waitMs")))
    deadline = time.monotonic() + wait_ms / 1000.0

    while True:
        with broker._lock:
            current = broker._clients.get(client_id)
            if not connections.current(current, connection_id):
                return connections.rejected()
        state = broker._state(client_id)
        marker = _marker(state)
        state["watchSupported"] = True
        state["watchCursor"] = {
            "eventCursor": marker[0],
            "ownerEpoch": marker[1],
            "engineEpoch": marker[2],
            "trackGeneration": marker[3],
        }
        if baseline is None or marker != baseline or wait_ms <= 0:
            state["watchTimedOut"] = False
            return state
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            state["watchTimedOut"] = True
            return state
        time.sleep(min(_POLL_MS / 1000.0, remaining))
