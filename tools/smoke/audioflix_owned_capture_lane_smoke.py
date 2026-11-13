"""Piano PCM is generation-fenced and independent of the other native lanes.

Runs the real provider-capture sessions and the real PcmPlayer lanes against a fake
PortAudio stream, so queue preemption between lanes is observed in the actual mixer.
"""

import base64
import importlib
import sys
import types
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

playback = importlib.import_module("server_modules.audioflix_bridge_playback")
capture = importlib.import_module("server_modules.audioflix_provider_capture")


class FakeStream:
    active = True

    def start(self):
        pass

    def stop(self):
        pass

    def close(self):
        pass


def pcm(value, frames=4800):
    return base64.b64encode(np.full(frames, value, dtype="<i2").tobytes()).decode("ascii")


def rejected(fn, needle):
    try:
        fn()
    except RuntimeError as error:
        assert needle in str(error), str(error)
        return
    raise AssertionError(f"expected rejection containing {needle!r}")


def lane_backlog(player, lane):
    return player.stream_lanes[lane]["q"].qsize()


def main():
    saved = playback.sd, playback._open_output_stream
    playback.sd = types.SimpleNamespace()
    playback._open_output_stream = lambda index, channels, callback, rate: (FakeStream(), 48000)
    playback._PLAYERS.clear()
    capture._SESSIONS.clear()
    try:
        assert playback._player_for("sd:7", 48000, 1, "piano-pcm").stream.active
        rejected(lambda: playback._player_for("sd:7", 48000, 1, "electron-capture"), "Unknown native playback lane")
        rejected(lambda: capture.start({"deviceId": "sd:7", "lane": "electron-capture"}), "Unknown provider capture lane")
        rejected(lambda: playback._player_for("sd:7", 48000, 1, "made-up-lane"), "Unknown native playback lane")
        rejected(lambda: capture.start({"deviceId": "sd:7", "lane": "piano-pcm", "ownerId": "short", "generation": 1}),
                 "owner generation")

        # Primary writers still preempt each other.
        for stream in ("primary-a", "primary-a", "primary-b"):
            playback.play_pcm({"audio": pcm(500), "deviceId": "sd:7", "sampleRate": 48000,
                               "streamId": stream, "strictDevice": True})
        assert playback._PLAYERS["sd:7:1:shared"].q.qsize() == 1, "primary collision mechanism changed"
        playback._PLAYERS["sd:7:1:shared"].clear_stream()

        owner = "piano-host:fixture-0001"
        first = capture.start({"deviceId": "sd:7", "sampleRate": 48000, "lane": "piano-pcm",
                               "source": "piano", "ownerId": owner, "generation": 1})
        assert first["lane"] == "piano-pcm" and first["sessionId"].startswith("piano:")
        auth = {"sessionId": first["sessionId"], "captureToken": first["captureToken"],
                "lane": "piano-pcm", "ownerId": owner, "generation": 1}
        for _ in range(3):
            capture.chunk({**auth, "audio": pcm(1000), "channels": 1, "sampleRate": 48000})
        player = playback._PLAYERS["sd:7:1:shared"]
        assert lane_backlog(player, "piano-pcm") == 3

        # Other playback lanes can write to the same device without clearing Piano PCM.
        for stream in ("gemini-voice", "other-primary"):
            playback.play_pcm({"audio": pcm(2000), "deviceId": "sd:7", "sampleRate": 48000,
                               "streamId": stream, "strictDevice": True})
        provider = capture.start({"deviceId": "sd:7", "sampleRate": 48000, "source": "provider-tab"})
        capture.chunk({"sessionId": provider["sessionId"], "captureToken": provider["captureToken"],
                       "audio": pcm(3000), "channels": 1, "sampleRate": 48000})
        assert lane_backlog(player, "piano-pcm") == 3, "another lane preempted piano-pcm"

        # A second Piano host cannot take over a live lane, and no request without the
        # current owner generation is accepted.
        rejected(lambda: capture.start({"deviceId": "sd:7", "lane": "piano-pcm",
                                        "ownerId": "piano-host:intruder-02", "generation": 9}), "already owns")
        rejected(lambda: capture.chunk({**auth, "generation": 2, "audio": pcm(1)}), "stale")
        rejected(lambda: capture.chunk({**auth, "ownerId": "piano-host:intruder-02", "audio": pcm(1)}), "stale")
        rejected(lambda: capture.chunk({**auth, "lane": "primary", "audio": pcm(1)}), "stale")
        assert lane_backlog(player, "piano-pcm") == 3

        # Stop flushes exactly the owned lane; primary and provider-capture keep their audio.
        primary_before = player.q.qsize()
        provider_before = lane_backlog(player, "provider-capture")
        stopped = capture.stop(auth)
        assert stopped["stopped"] and stopped["lane"] == "piano-pcm"
        assert lane_backlog(player, "piano-pcm") == 0
        assert player.stream_lanes["piano-pcm"]["flush"] is True
        assert player.q.qsize() == primary_before and lane_backlog(player, "provider-capture") == provider_before

        # No resurrection: a chunk that was in flight when Stop ran is refused, not enqueued.
        rejected(lambda: capture.chunk({**auth, "audio": pcm(1000)}), "invalid or expired")
        assert lane_backlog(player, "piano-pcm") == 0

        # Same host, next generation after Stop/Start; then a newer generation hands off cleanly.
        second = capture.start({"deviceId": "sd:7", "sampleRate": 48000, "lane": "piano-pcm",
                                "ownerId": owner, "generation": 2})
        auth2 = {"sessionId": second["sessionId"], "captureToken": second["captureToken"],
                 "lane": "piano-pcm", "ownerId": owner, "generation": 2}
        capture.chunk({**auth2, "audio": pcm(1000)})
        third = capture.start({"deviceId": "sd:7", "sampleRate": 48000, "lane": "piano-pcm",
                               "ownerId": owner, "generation": 3})
        rejected(lambda: capture.chunk({**auth2, "audio": pcm(1000)}), "invalid or expired")
        assert lane_backlog(player, "piano-pcm") == 0
        capture.stop({"sessionId": third["sessionId"], "captureToken": third["captureToken"],
                      "lane": "piano-pcm", "ownerId": owner, "generation": 3})

        # A crashed host (no Stop, quiet past the grace) can be reclaimed by a new host.
        crashed = capture.start({"deviceId": "sd:7", "lane": "piano-pcm", "ownerId": owner, "generation": 4})
        capture._SESSIONS[crashed["sessionId"]]["lastSeenAt"] -= capture._PIANO_OWNER_GRACE_SECONDS + 1
        rescue = capture.start({"deviceId": "sd:7", "lane": "piano-pcm",
                                "ownerId": "piano-host:restarted-03", "generation": 1})
        assert rescue["sessionId"] != crashed["sessionId"] and crashed["sessionId"] not in capture._SESSIONS

    finally:
        playback.sd, playback._open_output_stream = saved
        for player in playback._PLAYERS.values():
            player.closed = True
        playback._PLAYERS.clear()
        capture._SESSIONS.clear()
    print("audioflix piano-pcm lane smoke passed")


if __name__ == "__main__":
    main()
