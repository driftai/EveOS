"""Offline status-read regression using the actual broker/RPC/manager and a fake helper."""
from __future__ import annotations

import copy
import json
import math
import pathlib
import platform
import sys
import time
from collections import Counter
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server_modules import audioflix_spotify_broker as broker_mod  # noqa: E402
from server_modules import audioflix_spotify_browser as browser  # noqa: E402

STATE = {
    "status": "playing", "spotifyId": "4cOdK2wGLETKBW3PvgPWqT", "generation": 7,
    "currentTime": 25, "duration": 180, "paused": False,
    "completionId": "", "eventCursor": 11,
}


class FakeHelper:
    def __init__(self, delay=0):
        self.calls = []
        self.delay = delay
        self.state = copy.deepcopy(STATE)
        self.transport_present = True
        self.transport_override = None
        self.override_transport = False
        self.reachable = True

    def request(self, method, route, body=None, timeout=0):
        del timeout
        self.calls.append((method, route))
        if self.delay:
            time.sleep(self.delay)
        if not self.reachable:
            raise ConnectionError("synthetic helper unavailable")
        if (method, route) == ("GET", "/status"):
            result = {
                "ok": True, "state": "controlling", "sessionId": "private-session",
                "authState": "signed-in", "browserChannel": "synthetic",
                "pageAttached": True, "playingCount": 1,
            }
            if self.transport_present:
                result["transport"] = copy.deepcopy(
                    self.transport_override if self.override_transport else self.state)
            return result
        assert (method, route) == ("POST", "/transport"), (method, route)
        if body.get("action") == "seek":
            self.state["currentTime"] = body["seconds"]
        elif body.get("action") == "pause":
            self.state.update(status="paused", paused=True)
        elif body.get("action") == "stop":
            self.state.update(status="stopped", paused=True, currentTime=0)
        else:
            assert body.get("action") == "status", body
        return {"ok": True, "state": copy.deepcopy(self.state)}


def manager_for(helper):
    manager = browser.SpotifyBrowserManager()
    manager._process = type("SyntheticProcess", (), {"poll": lambda self: None})()
    manager._port = 31337
    manager._token = "private-token"
    manager._session_id = "private-session"
    manager._started_at = 1000
    manager.environment_status = lambda force=False: {"profilePath": "synthetic-only"}
    manager._request = helper.request
    return manager


def count(helper):
    return dict(Counter(f"{method} {route}" for method, route in helper.calls))


def measure():
    helper = FakeHelper(delay=0.002)
    manager = manager_for(helper)
    broker = broker_mod.SpotifyClientBroker()
    elapsed = []
    with patch.object(browser, "_manager", manager):
        for _ in range(30):
            start = time.perf_counter()
            result = broker._state("synthetic-client")
            elapsed.append((time.perf_counter() - start) * 1000)
            assert result["engine"] == STATE
    ordered = sorted(elapsed)
    return {
        "kind": "synthetic: actual Python read path, fake helper, 2ms delay per request",
        "python": sys.version.split()[0], "platform": platform.platform(),
        "samples": len(elapsed), "requests": count(helper),
        "p50Ms": round(ordered[math.ceil(len(ordered) * 0.50) - 1], 3),
        "p95Ms": round(ordered[math.ceil(len(ordered) * 0.95) - 1], 3),
        "maxMs": round(max(elapsed), 3),
    }


def regression():
    helper = FakeHelper()
    manager = manager_for(helper)
    broker = broker_mod.SpotifyClientBroker()
    with patch.object(browser, "_manager", manager):
        result = broker._state("synthetic-client")
        assert result["engine"] == STATE, "broker lost the helper's existing transport snapshot"
        assert count(helper) == {"GET /status": 1}, (
            "one broker state read must reuse GET /status transport; redundant reads: " + str(count(helper)))
        assert result["trackGeneration"] == 7 and result["engineEpoch"] == 1
        assert "private-" not in repr(result) and "profilePath" not in repr(result)

        helper.calls.clear()
        managed = manager.status()
        assert managed["transport"] == STATE and "sessionId" not in managed
        managed["transport"]["currentTime"] = -1
        assert helper.state["currentTime"] == 25, "snapshot alias changed the fake provider"

        # No cache/TTL: sequential observations must see a mutation immediately.
        helper.calls.clear()
        helper.state.update(currentTime=26, eventCursor=12)
        fresh = broker._state("synthetic-client")
        assert fresh["engine"]["currentTime"] == 26 and fresh["engine"]["eventCursor"] == 12
        assert count(helper) == {"GET /status": 1}

        # An explicit mutation response remains authoritative over the helper status snapshot.
        helper.calls.clear()
        explicit = {**STATE, "currentTime": 91}
        assert broker._state("synthetic-client", explicit)["engine"] == explicit
        assert count(helper) == {"GET /status": 1}

        # Compatibility for legacy helpers/fakes that omit or cannot provide transport.
        for missing, malformed in ((True, None), (False, None), (False, "invalid"), (False, []), (False, 1)):
            helper.transport_present = not missing
            helper.transport_override = malformed
            helper.override_transport = True
            helper.calls.clear()
            assert broker._state("synthetic-client")["engine"] == helper.state
            assert count(helper) == {"GET /status": 2, "POST /transport": 1}

        helper.transport_present = True
        helper.override_transport = False
        helper.calls.clear()
        grant = broker.connect({"mode": "localhost", "parentOrigin": "http://127.0.0.1:8765"},
                               {"serverOrigin": "http://127.0.0.1:8765"})
        with broker._lock:
            broker._acquire_locked(broker._clients[grant["clientId"]])
        seek = broker.command({"clientToken": grant["clientToken"], "command": {
            "connectionId": grant["connectionId"], "commandId": "seek", "clientCommandSeq": 1,
            "action": "seek", "payload": {"seconds": 91},
        }}, {"serverOrigin": "http://127.0.0.1:8765"})
        assert seek["ok"] and seek["isOwner"] and seek["engine"]["currentTime"] == 91
        assert count(helper) == {"GET /status": 2, "POST /transport": 1}
        assert broker._state(grant["clientId"])["engine"]["currentTime"] == 91

        # A changed engine identity must remain visible immediately and retire old ownership.
        manager._started_at += 1
        helper.state.update(generation=8, eventCursor=13)
        restarted = broker._state(grant["clientId"])
        assert restarted["engineEpoch"] == 2 and restarted["trackGeneration"] == 8
        assert not restarted["isOwner"] and restarted["ownerClientId"] == ""

        # A retired connection is rejected before any helper request; read reuse adds no authority.
        broker._clients[grant["clientId"]]["connectionId"] = "replacement-lease"
        helper.calls.clear()
        rejected = broker.command({"clientToken": grant["clientToken"], "command": {
            "connectionId": grant["connectionId"], "commandId": "late-status", "clientCommandSeq": 2,
            "action": "status", "payload": {},
        }}, {"serverOrigin": "http://127.0.0.1:8765"})
        assert rejected.get("disconnected") and not helper.calls

        helper.calls.clear()
        helper.reachable = False
        unavailable = broker._state("synthetic-client")
        assert not unavailable["managed"]["helperReachable"] and unavailable["engine"] == {}
        assert count(helper) == {"GET /status": 1}, "unhealthy status must not send transport"


def run():
    baseline = "--baseline" in sys.argv
    metrics = measure()
    artifact = ROOT / "data/runtime/smoke-results" / (
        "LAST-AUDIOFLIX-SPOTIFY-STATUS-READS-BASELINE.json" if baseline
        else "LAST-AUDIOFLIX-SPOTIFY-STATUS-READS.json")
    artifact.parent.mkdir(parents=True, exist_ok=True)
    if not baseline:
        try:
            regression()
        except Exception as exc:
            metrics["failure"] = f"{type(exc).__name__}: {exc}"
            artifact.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
            raise
    artifact.write_text(json.dumps(metrics, indent=2) + "\n", encoding="utf-8")
    label = "BASELINE" if baseline else "OK"
    print(f"AUDIOFLIX_SPOTIFY_STATUS_READS_{label} synthetic samples={metrics['samples']} "
          f"requests={metrics['requests']} p50={metrics['p50Ms']}ms "
          f"p95={metrics['p95Ms']}ms max={metrics['maxMs']}ms")


if __name__ == "__main__":
    run()
