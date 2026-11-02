"""Piano PCM uses an authenticated independent lane on one physical native mixer."""

import base64
import importlib
import queue
import sys
import threading
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

capture = importlib.import_module("server_modules.audioflix_provider_capture")
playback = importlib.import_module("server_modules.audioflix_bridge_playback")


class Stream:
    active = True


class Player:
    stream = Stream()


def pcm(value=1000):
    raw = np.array([value] * 1024, dtype="<i2").tobytes()
    return base64.b64encode(raw).decode("ascii")


def main():
    old = capture._player_for, capture.play_pcm, capture.stop_stream, capture._now
    calls, stops = [], []
    capture._SESSIONS.clear()
    capture._player_for = lambda *args: calls.append(("open", args)) or Player()
    capture.play_pcm = lambda payload: calls.append(("pcm", payload.copy())) or {
        "ok": True, "deviceId": payload["deviceId"], "queued": 1024
    }
    capture.stop_stream = lambda payload: stops.append(payload.copy()) or {"ok": True}
    try:
        spotify = capture.start({"deviceId": "sd:7", "sampleRate": 48000, "source": "managed-spotify"})
        piano = capture.start({"deviceId": "sd:7", "sampleRate": 48000, "source": "piano-post-compressor",
            "lane": "piano-pcm", "ownerId": "piano-owner:fixture", "generation": 1})
        assert spotify["lane"] == "provider-capture" and piano["lane"] == "piano-pcm"
        piano_auth = {"sessionId": piano["sessionId"], "captureToken": piano["captureToken"],
            "lane": "piano-pcm", "ownerId": piano["ownerId"], "generation": 1}
        capture.chunk({**piano_auth, "audio": pcm(), "channels": 1, "maxAgeMs": 120})
        sent = [payload for kind, payload in calls if kind == "pcm"][-1]
        assert sent["lane"] == "piano-pcm" and sent["strictDevice"] is True and sent["maxAgeMs"] == 120
        try:
            capture.status({**piano_auth, "generation": 2})
            raise AssertionError("stale generation was accepted")
        except RuntimeError as error:
            assert "stale" in str(error)
        replacement = capture.start({"deviceId": "sd:7", "sampleRate": 48000, "source": "piano-post-compressor",
            "lane": "piano-pcm", "ownerId": piano["ownerId"], "generation": 2})
        assert replacement["generation"] == 2 and any(stop["lane"] == "piano-pcm" for stop in stops)
        capture.stop({"sessionId": replacement["sessionId"], "captureToken": replacement["captureToken"],
            "lane": "piano-pcm", "ownerId": replacement["ownerId"], "generation": 2})
        assert capture.status({"sessionId": spotify["sessionId"], "captureToken": spotify["captureToken"]})["ok"]

        stale = capture.start({"deviceId": "sd:7", "sampleRate": 48000, "source": "piano-post-compressor",
            "lane": "piano-pcm", "ownerId": "piano-owner:stale-fixture", "generation": 1})
        started_at = capture._SESSIONS[stale["sessionId"]]["createdAt"]
        capture._now = lambda: started_at + capture._PIANO_OWNER_GRACE_SECONDS + 0.1
        reclaimed = capture.start({"deviceId": "sd:7", "sampleRate": 48000, "source": "piano-post-compressor",
            "lane": "piano-pcm", "ownerId": "piano-owner:fresh-fixture", "generation": 1})
        assert reclaimed["ownerId"] == "piano-owner:fresh-fixture"
        assert any(stop.get("itemId") == stale["sessionId"] for stop in stops)
        capture.stop({"sessionId": reclaimed["sessionId"], "captureToken": reclaimed["captureToken"],
            "lane": "piano-pcm", "ownerId": reclaimed["ownerId"], "generation": 1})
        capture._now = old[3]

        player = playback._PcmPlayer.__new__(playback._PcmPlayer)
        player.q, player.pending, player.flush_pending, player.stream_id = queue.Queue(), None, False, None
        player.stream_lanes, player.stream_lanes_lock = {}, threading.Lock()
        player.voices, player.voices_lock, player.voices_paused = [], threading.Lock(), False
        player.last_used, player.source_rate, player.sample_rate = 0, 48000, 48000
        player._resample = playback._resample_mono
        player.enqueue(np.full(4, 0.2, dtype="float32"), "spotify", "provider-capture", 48000)
        player.enqueue(np.full(4, 0.3, dtype="float32"), "piano", "piano-pcm", 48000)
        output = np.zeros((4, 1), dtype="float32")
        player._mix(output, 4)
        assert np.allclose(output[:, 0], 0.5), output[:, 0]
        player.enqueue(np.ones(2, dtype="float32"), "spotify", "provider-capture", 48000)
        player.enqueue(np.ones(2, dtype="float32"), "piano", "piano-pcm", 48000)
        assert player.clear_stream("piano", "piano-pcm") == 1
        assert player._lane("provider-capture")["q"].qsize() == 1
    finally:
        capture._SESSIONS.clear()
        capture._player_for, capture.play_pcm, capture.stop_stream, capture._now = old
    print("AUDIOFLIX_PIANO_PCM_SMOKE_OK")


if __name__ == "__main__":
    main()
