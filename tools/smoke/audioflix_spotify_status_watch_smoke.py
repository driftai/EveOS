#!/usr/bin/env python3
"""Deterministic bounded Spotify status-watch contract; no browser or provider required."""
from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def run():
    from server_modules import audioflix_spotify_status_watch as watch

    http_source = (ROOT / "server_modules" / "audioflix_spotify_http.py").read_text(encoding="utf-8")
    check('"/api/audioflix/spotify-client/status-watch"' in http_source,
          "HTTP status-watch route is not registered")
    check("status_watch.watch(broker._broker, payload)" in http_source,
          "HTTP status-watch route does not use the non-transport watcher")

    marker = {"eventCursor": 4, "ownerEpoch": 2, "engineEpoch": 3, "trackGeneration": 9}
    client = {"clientId": "client-1", "token": "token-1"}

    class FakeBroker:
        def __init__(self):
            self._lock = threading.RLock()
            self._transport_lock = threading.RLock()
            self._clients = {"client-1": client}

        def _expire_locked(self):
            return None

        def _authorized_client_locked(self, token):
            return client if token == "token-1" else None

        def _state(self, client_id):
            return {
                "ok": True, "clientId": client_id,
                "ownerEpoch": marker["ownerEpoch"], "engineEpoch": marker["engineEpoch"],
                "trackGeneration": marker["trackGeneration"],
                "engine": {"eventCursor": marker["eventCursor"]},
            }

    broker = FakeBroker()
    current = lambda candidate, connection_id, **_: candidate is client and connection_id == "connection-1"
    rejected = lambda: {"ok": False, "reason": "connection changed"}

    def payload(**overrides):
        args = {
            "afterCursor": marker["eventCursor"], "afterOwnerEpoch": marker["ownerEpoch"],
            "afterEngineEpoch": marker["engineEpoch"],
            "afterTrackGeneration": marker["trackGeneration"], "waitMs": 400,
            **overrides,
        }
        return {"clientToken": "token-1", "command": {
            "connectionId": "connection-1", "payload": args,
        }}

    with patch.object(watch.connections, "current", side_effect=current), \
            patch.object(watch.connections, "rejected", side_effect=rejected):
        immediate = watch.watch(broker, {"clientToken": "token-1", "command": {
            "connectionId": "connection-1", "payload": {"waitMs": 400},
        }})
        check(immediate["ok"] and immediate["watchSupported"] and not immediate["watchTimedOut"],
              "status watch without a baseline was not immediate")

        started = time.monotonic()
        timed = watch.watch(broker, payload(waitMs=70))
        elapsed = time.monotonic() - started
        check(timed["watchTimedOut"] and elapsed >= 0.05,
              "unchanged status did not perform a bounded wait")

        result = {}
        thread = threading.Thread(target=lambda: result.update(watch.watch(broker, payload(waitMs=1000))))
        thread.start()
        time.sleep(0.05)
        marker["eventCursor"] += 1
        thread.join(0.8)
        check(not thread.is_alive() and not result.get("watchTimedOut"),
              "event cursor change did not wake the watch")
        check(result["watchCursor"]["eventCursor"] == marker["eventCursor"],
              "wake result lost the changed event cursor")

        # A pending status watch must never own the broker transport lock; playback controls stay free.
        marker["eventCursor"] = 20
        result.clear()
        thread = threading.Thread(target=lambda: result.update(watch.watch(broker, payload(
            afterCursor=20, waitMs=500))))
        thread.start()
        time.sleep(0.05)
        acquired = broker._transport_lock.acquire(timeout=0.1)
        if acquired:
            broker._transport_lock.release()
        marker["ownerEpoch"] += 1
        thread.join(0.5)
        check(acquired, "status watch blocked the playback transport lock")
        check(not thread.is_alive(), "owner epoch change did not wake the watch")

        denied = watch.watch(broker, {"clientToken": "bad", "command": {
            "connectionId": "connection-1", "payload": {},
        }})
        check(not denied["ok"], "status watch accepted an unauthorized client")


if __name__ == "__main__":
    run()
    print("AUDIOFLIX_SPOTIFY_STATUS_WATCH_OK (bounded wait, wake, lock isolation, authorization)")
