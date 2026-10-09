"""Deterministic authority/concurrency smoke for the any-browser Spotify broker."""
from __future__ import annotations

import pathlib
import sys
import threading
import time

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server_modules import audioflix_spotify_broker as mod  # noqa: E402


class FakeEngine:
    def __init__(self):
        self.calls = []
        self.started = 1000
        self.state = {
            "status": "paused", "spotifyId": "", "generation": 0,
            "currentTime": 0, "duration": 0, "paused": True,
            "completionId": "", "eventCursor": 0,
        }
        self.import_started = threading.Event()
        self.release_import = threading.Event()

    def ensure_engine(self, page_url):
        self.calls.append(("ensure", page_url))
        return {"ok": True, "helperReachable": True, "engineStartedAt": self.started,
                "authState": "signed-in", "browserRunning": True}

    def status(self):
        return {"ok": True, "helperReachable": True, "engineStartedAt": self.started,
                "authState": "signed-in", "browserRunning": True, "state": self.state["status"]}

    def transport(self, payload=None):
        payload = dict(payload or {})
        self.calls.append(("transport", payload))
        action = payload.get("action")
        if action == "load":
            self.state.update({
                "status": "loaded", "spotifyId": payload.get("spotifyId", ""),
                "generation": payload.get("generation", 0), "currentTime": 0,
                "duration": payload.get("duration", 0), "paused": True,
                "completionId": "",
            })
        elif action == "play":
            self.state.update({"status": "playing", "paused": False})
        elif action == "pause":
            self.state.update({"status": "paused", "paused": True})
        elif action == "seek":
            self.state["currentTime"] = payload.get("seconds", 0)
        elif action == "stop":
            self.state.update({"status": "stopped", "paused": True, "currentTime": 0})
        return {"ok": True, "state": dict(self.state)}

    def set_effective_volume(self, volume, track_id=""):
        self.calls.append(("volume", float(volume), track_id))
        return {"ok": True, "volume": float(volume), "held": True, "reached": 1}

    def import_playlist(self, url):
        self.calls.append(("import", url))
        self.import_started.set()
        self.release_import.wait(2)
        return {"ok": True, "count": 163, "expectedCount": 163, "scrapeSource": "managed-session"}

    def auth(self, open_login=False, url=""):
        self.calls.append(("auth", bool(open_login), url))
        return {"ok": True, "authState": "signed-in"}


fake = FakeEngine()
mod.engine.ensure_engine = fake.ensure_engine
mod.engine.status = fake.status
mod.engine.transport = fake.transport
mod.engine.set_effective_volume = fake.set_effective_volume
mod.engine.import_playlist = fake.import_playlist
mod.engine.auth = fake.auth

broker = mod.SpotifyClientBroker()
context = {"serverOrigin": "http://127.0.0.1:8765"}

# Localhost gets a relay-scoped capability only when the parent origin exactly matches the relay.
local = broker.connect({
    "mode": "localhost", "parentOrigin": "http://127.0.0.1:8765",
    "documentId": "http-doc", "libraryScopeId": "origin:http://127.0.0.1:8765",
}, context)
assert local["ok"] and local["connected"] and local["clientToken"]
assert not broker.connect({
    "mode": "localhost", "parentOrigin": "http://127.0.0.1:9999", "documentId": "bad"
}, context)["ok"]
assert not broker.connect({"mode": "file", "parentOrigin": "https://evil.example"}, context)["ok"]

# A file/null-origin document receives no authority until the trusted approval page approves it.
file_pending = broker.connect({
    "mode": "file", "parentOrigin": "null", "documentId": "file-doc",
    "libraryScopeId": "file:/c:/eveos/eveos.html",
}, context)
assert file_pending["ok"] and file_pending["pairingRequired"]
assert "clientToken" not in file_pending
view = broker.pairing_view(file_pending["pairId"])
assert view["ok"] and view["code"] == file_pending["code"] and view["csrf"]
assert broker.pair_status({"pairId": file_pending["pairId"]})["approved"] is False
assert not broker.approve({"pairId": file_pending["pairId"], "csrf": "wrong"})["ok"]
assert broker.approve({"pairId": file_pending["pairId"], "csrf": view["csrf"]})["ok"]
file_grant = broker.pair_status({"pairId": file_pending["pairId"]})
assert file_grant["ok"] and file_grant["approved"] and file_grant["clientToken"]

seq = 0
def command(grant, action, payload=None, command_id=None):
    global seq
    seq += 1
    return broker.command({
        "clientToken": grant["clientToken"],
        "command": {
            "action": action, "payload": dict(payload or {}),
            "commandId": command_id or f"cmd-{seq}", "clientCommandSeq": seq,
        },
    }, context)

# Play is the deliberate ownership transfer. Load -> effective gain -> play is ordered so playback
# cannot start at full volume and attenuate afterward.
play = command(local, "play", {
    "spotifyId": "4cOdK2wGLETKBW3PvgPWqT", "title": "Smoke",
    "duration": 180, "effectiveVolume": 0.25,
})
assert play["ok"] and play["isOwner"] and play["engine"]["status"] == "playing"
load_index = next(i for i, call in enumerate(fake.calls) if call[0] == "transport" and call[1].get("action") == "load")
volume_index = next(i for i, call in enumerate(fake.calls) if call[0] == "volume")
play_index = next(i for i, call in enumerate(fake.calls) if call[0] == "transport" and call[1].get("action") == "play")
assert load_index < volume_index < play_index
assert fake.calls[volume_index][1] == 0.25

# Observer commands cannot race the current owner. Explicit Play transfers ownership.
observer_pause = command(file_grant, "pause")
assert observer_pause["ok"] is False and observer_pause["observer"] is True
file_play = command(file_grant, "play", {
    "spotifyId": "1WZGaNYzreZrvteuUEfp8X", "effectiveVolume": 0.5,
})
assert file_play["ok"] and file_play["isOwner"]
local_status = command(local, "status")
assert local_status["ok"] and not local_status["isOwner"]

# commandId is an idempotency key; same input returns same receipt, changed input is rejected.
seq += 1
idempotent_payload = {
    "clientToken": file_grant["clientToken"],
    "command": {
        "action": "seek", "payload": {"seconds": 42},
        "commandId": "same-id", "clientCommandSeq": seq,
    },
}
first = broker.command(idempotent_payload, context)
second = broker.command(idempotent_payload, context)
assert first == second and first["ok"]
changed = broker.command({
    "clientToken": file_grant["clientToken"],
    "command": {"action": "seek", "payload": {"seconds": 43},
                "commandId": "same-id", "clientCommandSeq": seq + 1},
}, context)
assert not changed["ok"] and "different" in changed["reason"]

# Long managed import must not hold the playback/status transport lock. While import is blocked,
# the current owner can still query status and adjust gain.
import_result = {}
def run_import():
    global seq
    seq += 1
    import_result.update(broker.command({
        "clientToken": file_grant["clientToken"],
        "command": {
            "action": "import",
            "payload": {"url": "https://open.spotify.com/playlist/1fY2i6tthQptx5Z3nn1g17?pt=private"},
            "commandId": "import-long", "clientCommandSeq": seq,
        },
    }, context))

thread = threading.Thread(target=run_import, daemon=True)
thread.start()
assert fake.import_started.wait(1), "import did not start"
status_started = time.monotonic()
status_during_import = command(file_grant, "status")
assert status_during_import["ok"] and time.monotonic() - status_started < 0.5
volume_during_import = command(file_grant, "volume", {
    "effectiveVolume": 0.33, "spotifyId": "1WZGaNYzreZrvteuUEfp8X"
})
assert volume_during_import["ok"]
fake.release_import.set()
thread.join(2)
assert import_result.get("ok") and import_result.get("count") == 163

# Public client state contains no helper/session/token material.
public = command(file_grant, "status")
public_repr = repr(public).lower()
assert "clienttoken" not in public_repr and "sessionid" not in public_repr and "profilepath" not in public_repr
assert public["engineEpoch"] >= 1 and public["ownerEpoch"] >= 1 and public["trackGeneration"] >= 2

print("AUDIOFLIX_SPOTIFY_BROKER_SMOKE_OK")
