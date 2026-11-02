"""One physical Audioflix output stream with isolated logical PCM lanes."""

from __future__ import annotations

import queue
import threading
import time

try:
    import numpy as np
except Exception:  # pragma: no cover
    np = None


class PcmPlayer:
    def __init__(self, device_index, source_rate, channels, open_stream, resample) -> None:
        self.device_index, self.source_rate, self.channels = device_index, int(source_rate), channels
        self._resample = resample
        self.q, self.pending, self.closed = queue.Queue(maxsize=4096), None, False
        self.last_used, self.flush_pending, self.stream_id = time.monotonic(), False, None
        self.stream_lanes, self.stream_lanes_lock = {}, threading.Lock()
        self.voices, self.voices_lock, self.voices_paused = [], threading.Lock(), False
        self.last_frames, self.cb_count = 0, 0
        self.stream, self.sample_rate = open_stream(device_index, channels, self._callback, source_rate)

    def _callback(self, outdata, frames, _time_info, _status) -> None:
        self.last_frames, self.cb_count = frames, self.cb_count + 1
        outdata.fill(0)
        try:
            self._mix(outdata, frames)
        except Exception as exc:
            outdata.fill(0)
            if not getattr(self, "_cb_error_logged", False):
                self._cb_error_logged = True
                print(f"[Audioflix] audio callback error (stream kept alive): {exc!r}", flush=True)

    def _mix(self, outdata, frames) -> None:
        self._mix_stream(outdata, frames, None)
        with self.stream_lanes_lock:
            lanes = list(self.stream_lanes.values())
        for state in lanes:
            self._mix_stream(outdata, frames, state)
        with self.voices_lock:
            if self.voices and not self.voices_paused:
                survivors = []
                for voice in self.voices:
                    samples, pos, volume = voice["samples"], voice["pos"], voice.get("vol", 1.0)
                    count = min(len(samples) - pos, frames)
                    if count > 0:
                        segment = np.asarray(samples[pos:pos + count], dtype="float32").reshape(-1)[:count]
                        outdata[:count, 0] += segment if volume == 1.0 else segment * np.float32(volume)
                        voice["pos"] = pos + count
                    if voice["pos"] < len(samples):
                        survivors.append(voice)
                self.voices = survivors
        np.clip(outdata[:, 0], -1.0, 1.0, out=outdata[:, 0])

    def _mix_stream(self, outdata, frames, state) -> None:
        pending = self.pending if state is None else state["pending"]
        if self.flush_pending if state is None else state["flush"]:
            pending = None
            if state is None:
                self.flush_pending = False
            else:
                state["flush"] = False
        source = self.q if state is None else state["q"]
        written = 0
        while written < frames:
            if pending is None or len(pending) == 0:
                try:
                    pending = source.get_nowait()
                except queue.Empty:
                    break
            count = min(frames - written, len(pending))
            outdata[written:written + count, 0] += pending[:count]
            pending, written = pending[count:], written + count
        if state is None:
            self.pending = pending
        else:
            state["pending"] = pending

    def _lane(self, lane):
        lane = str(lane or "primary").strip().lower()
        if lane == "primary":
            return None
        with self.stream_lanes_lock:
            return self.stream_lanes.setdefault(lane, {
                "q": queue.Queue(maxsize=16 if lane == "piano-pcm" else 256),
                "pending": None, "flush": False, "stream_id": None,
            })

    def add_voice(self, samples, vid=None, vol=1.0, source_rate=None) -> None:
        self.last_used = time.monotonic()
        samples = self._resample(samples, source_rate or self.source_rate, self.sample_rate)
        with self.voices_lock:
            if len(self.voices) >= 32:
                self.voices = self.voices[-31:]
            self.voices.append({"samples": samples, "pos": 0, "vid": vid, "vol": vol})

    def set_voice_volume(self, vid, vol) -> int:
        count = 0
        if vid is not None:
            with self.voices_lock:
                for voice in self.voices:
                    if voice.get("vid") == vid:
                        voice["vol"], count = vol, count + 1
        return count

    def clear_voices(self, vid=None) -> int:
        with self.voices_lock:
            before = len(self.voices)
            self.voices = [] if vid is None else [voice for voice in self.voices if voice.get("vid") != vid]
            return before - len(self.voices)

    def set_voices_paused(self, paused) -> int:
        with self.voices_lock:
            self.voices_paused = bool(paused)
            return len(self.voices)

    def clear_stream(self, expected_id=None, lane="primary") -> int:
        state = self._lane(lane)
        stream_id = self.stream_id if state is None else state["stream_id"]
        if expected_id is not None and stream_id != expected_id:
            return 0
        source = self.q if state is None else state["q"]
        dropped = 0
        while True:
            try:
                source.get_nowait()
                dropped += 1
            except queue.Empty:
                break
        if state is None:
            self.flush_pending, self.stream_id = True, None
        else:
            state["flush"], state["stream_id"] = True, None
        return dropped

    def enqueue(self, samples, stream_id=None, lane="primary", source_rate=None) -> None:
        self.last_used = time.monotonic()
        state = self._lane(lane)
        current_id = self.stream_id if state is None else state["stream_id"]
        if stream_id is not None and current_id not in (None, stream_id):
            self.clear_stream(lane=lane)
        if state is None:
            self.stream_id, source = stream_id, self.q
        else:
            state["stream_id"], source = stream_id, state["q"]
        samples = self._resample(samples, source_rate or self.source_rate, self.sample_rate)
        try:
            source.put_nowait(samples)
        except queue.Full:
            try:
                source.get_nowait()
                source.put_nowait(samples)
            except queue.Empty:
                pass

    def close(self) -> None:
        self.closed = True
        try:
            self.stream.stop()
            self.stream.close()
        except Exception:
            pass
