"""Ensure delayed native PCM never bursts into playback after an endpoint stall."""

from __future__ import annotations

import base64
import queue
import sys
import threading
import time
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import audioflix_bridge_playback as playback


class FakePlayer:
    def __init__(self) -> None:
        self.blocks = []

    def enqueue(self, samples, stream_id=None, lane="primary", source_rate=None) -> None:
        self.blocks.append((samples.copy(), stream_id, lane, source_rate))


def main() -> None:
    player = FakePlayer()
    original_sd, original_np = playback.sd, playback.np
    original_player_for = playback._player_for
    playback.sd = object()
    playback.np = np

    try:
        def delayed_player(*_args):
            time.sleep(0.025)
            return player

        playback._player_for = delayed_player
        expired = playback._enqueue_mono(
            'sd:1', 24000, np.ones(16, dtype='float32'), 'pcm',
            expires_at_ms=(time.time() * 1000) + 2,
        )
        assert expired.get('stale') is True
        assert not player.blocks

        playback._player_for = lambda *_args: player
        raw = np.array([1000, -1000], dtype='<i2').tobytes()
        stale_payload = playback.play_pcm({
            'audio': base64.b64encode(raw).decode('ascii'),
            'deviceId': 'sd:1',
            'sampleRate': 24000,
            'channels': 1,
            'sentAtMs': (time.time() * 1000) - 2000,
            'maxAgeMs': 1200,
        })
        assert stale_payload.get('stale') is True
        assert not player.blocks

        fresh_payload = playback.play_pcm({
            'audio': base64.b64encode(raw).decode('ascii'),
            'deviceId': 'sd:1',
            'sampleRate': 24000,
            'channels': 1,
            'sentAtMs': time.time() * 1000,
            'maxAgeMs': 1200,
        })
        assert fresh_payload.get('ok') is True
        assert len(player.blocks) == 1

        # A native output can outlive the browser element that fed it. Prove ownership moves
        # atomically between tracks so an old queued tail cannot overlap the next song.
        stream_player = playback._PcmPlayer.__new__(playback._PcmPlayer)
        stream_player.last_used = 0.0
        stream_player.stream_id = None
        stream_player.source_rate = 24000
        stream_player.sample_rate = 24000
        stream_player._resample = playback._resample_mono
        stream_player.stream_lanes, stream_player.stream_lanes_lock = {}, threading.Lock()
        stream_player.q = queue.Queue(maxsize=8)
        stream_player.flush_pending = False
        playback._PcmPlayer.enqueue(stream_player, np.ones(8, dtype='float32'), 'track:alpha')
        playback._PcmPlayer.enqueue(stream_player, np.ones(8, dtype='float32'), 'track:alpha')
        assert stream_player.q.qsize() == 2
        playback._PcmPlayer.enqueue(stream_player, np.ones(8, dtype='float32'), 'track:beta')
        assert stream_player.stream_id == 'track:beta'
        assert stream_player.q.qsize() == 1
        assert stream_player.flush_pending is True
        assert playback._PcmPlayer.clear_stream(stream_player, 'track:alpha') == 0
        assert stream_player.q.qsize() == 1
        assert playback._PcmPlayer.clear_stream(stream_player, 'track:beta') == 1
        assert stream_player.q.empty()

        voice_player = playback._PcmPlayer.__new__(playback._PcmPlayer)
        voice_player.q, voice_player.pending, voice_player.flush_pending = queue.Queue(), None, False
        voice_player.stream_lanes, voice_player.stream_lanes_lock = {}, threading.Lock()
        voice_player.voices_lock, voice_player.voices_paused = threading.Lock(), False
        voice_player.voices = [{"samples": np.ones(4, dtype='float32'), "pos": 0, "vid": "layer", "vol": 1.0}]
        assert playback._PcmPlayer.set_voices_paused(voice_player, True) == 1
        muted = np.zeros((2, 1), dtype='float32')
        playback._PcmPlayer._mix(voice_player, muted, 2)
        assert voice_player.voices[0]['pos'] == 0 and not muted.any()
        playback._PcmPlayer.set_voices_paused(voice_player, False)
        resumed = np.zeros((2, 1), dtype='float32')
        playback._PcmPlayer._mix(voice_player, resumed, 2)
        assert voice_player.voices[0]['pos'] == 2 and resumed.any()
    finally:
        playback.sd, playback.np = original_sd, original_np
        playback._player_for = original_player_for

    print('AUDIOFLIX_NATIVE_PCM_FRESHNESS_SMOKE_OK')


if __name__ == '__main__':
    main()
