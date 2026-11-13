#!/usr/bin/env python3
"""Focused contracts for the server-owned Piano renderer/session owner."""
from __future__ import annotations

import time
import sys
from pathlib import Path
from unittest.mock import patch

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from server_modules import audioflix_piano_native as native
from server_modules.audioflix_piano_native_synth import render_timeline


class Stream:
    active = True


class Player:
    def __init__(self):
        self.stream, self.sample_rate, self.voices = Stream(), 24000, {}

    def add_voice(self, samples, vid, vol, source_rate):
        self.voices[vid] = {"samples": np.asarray(samples), "pos": 0, "paused": False, "vol": vol}

    def clear_voices(self, vid=None):
        before = len(self.voices)
        self.voices = {} if vid is None else {key: value for key, value in self.voices.items() if key != vid}
        return before - len(self.voices)

    def set_voice_paused(self, vid, paused):
        if vid not in self.voices:
            return 0
        self.voices[vid]["paused"] = paused
        return 1

    def seek_voice(self, vid, seconds):
        if vid not in self.voices:
            return 0
        self.voices[vid]["pos"] = min(len(self.voices[vid]["samples"]), round(seconds * self.sample_rate))
        return 1

    def set_voice_volume(self, vid, value):
        if vid not in self.voices:
            return 0
        self.voices[vid]["vol"] = value
        return 1

    def voice_status(self, vid):
        voice = self.voices.get(vid)
        if not voice:
            return None
        return {"currentTime": voice["pos"] / self.sample_rate,
                "duration": len(voice["samples"]) / self.sample_rate,
                "paused": voice["paused"]}


def wait_state(receipt, expected="playing"):
    auth = {"sessionId": receipt["sessionId"], "sessionToken": receipt["sessionToken"],
            "ownerId": receipt["ownerId"], "generation": receipt["generation"]}
    deadline = time.time() + 2
    while time.time() < deadline:
        status = native.status(auth)
        if status["state"] == expected:
            return auth, status
        if status["state"] == "error":
            raise AssertionError(status["message"])
        time.sleep(0.01)
    raise AssertionError("server-owned Piano did not reach the expected state")


def run():
    synth = render_timeline({"duration_ms": 200, "events": [
        {"at_ms": 0, "duration_ms": 80, "midi_notes": [60, 64, 67]}
    ]}, "legacy_synth", 70, 24000)
    assert len(synth) >= 8000 and np.max(np.abs(synth)) > 0.01

    player = Player()
    timeline = {"duration_ms": 1000, "events": [
        {"event_index": 1, "at_ms": 0, "duration_ms": 80, "midi_notes": [60]},
        {"event_index": 2, "at_ms": 500, "duration_ms": 80, "midi_notes": [64]},
    ]}
    base = {"ownerId": "fixture-owner-0001", "generation": 1, "deviceId": "sd:4",
            "sampleRate": 24000, "soundId": "acoustic_grand", "timeline": timeline}
    with patch.object(native, "_player_for", return_value=player), patch.object(
            native, "render_timeline", return_value=np.ones(48000, dtype="float32") * 0.1):
        receipt = native.start(base)
        auth, status = wait_state(receipt)
        assert status["rendererRunning"] and status["duration"] == 2

        paused = native.pause({**auth, "paused": True})
        assert paused["state"] == "paused" and player.voices[receipt["sessionId"]]["paused"]
        resumed = native.pause({**auth, "paused": False})
        assert resumed["state"] == "playing"
        seeked = native.seek({**auth, "seconds": 1.25})
        assert 1.2 <= seeked["currentTime"] <= 1.3
        native.volume({**auth, "volume": 0.35})
        assert player.voices[receipt["sessionId"]]["vol"] == 0.35

        try:
            native.status({**auth, "generation": 2})
            raise AssertionError("stale generation was accepted")
        except RuntimeError as error:
            assert "stale" in str(error)
        try:
            native.start({**base, "ownerId": "another-owner-0002"})
            raise AssertionError("competing owner was accepted")
        except RuntimeError as error:
            assert "active" in str(error)

        replacement = native.start({**base, "generation": 2})
        auth2, _ = wait_state(replacement)
        assert receipt["sessionId"] not in player.voices and replacement["sessionId"] in player.voices
        stopped = native.stop(auth2)
        assert stopped["stopped"] and replacement["sessionId"] not in player.voices

    bridge = (ROOT / "server_modules" / "audioflix_bridge.py").read_text(encoding="utf-8")
    assert '"/api/audioflix/piano-native/start"' in bridge
    assert "_can_start_provider_capture(handler)" in bridge
    print("AUDIOFLIX_PIANO_NATIVE_SMOKE_OK")


if __name__ == "__main__":
    run()
