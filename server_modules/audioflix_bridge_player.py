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
        self.last_callback_at = time.monotonic()
        self.stream, self.sample_rate = open_stream(device_index, channels, self._callback, source_rate)

    def _callback(self, outdata, frames, _time_info, _status) -> None:
        self.last_frames, self.cb_count = frames, self.cb_count + 1
        self.last_callback_at = time.monotonic()
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
                    if voice.get("paused"):
                        survivors.append(voice)
                        continue
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
                    if (state is not None and state.get("stream_id")
                            and state.get("enqueued", 0) and not state.get("starved")):
                        state["underruns"] += 1
                        state["starved"] = True
                    break
            if state is not None:
                state["starved"] = False
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
                "dropped": 0, "underruns": 0, "enqueued": 0, "starved": False,
                "resample_rate": 0, "resample_input": 0, "resample_next": 0.0, "resample_tail": None,
            })

    def _resample_lane(self, samples, state, source_rate):
        source_rate, target_rate = int(source_rate or self.source_rate), int(self.sample_rate)
        mono = np.asarray(samples, dtype="float32").reshape(-1)
        if not len(mono):
            return mono
        if source_rate == target_rate:
            if state["resample_rate"]:
                state.update(resample_rate=0, resample_input=0, resample_next=0.0, resample_tail=None)
            return mono
        if state["resample_rate"] != source_rate:
            state.update(resample_rate=source_rate, resample_input=0, resample_next=0.0, resample_tail=None)
        start, end = state["resample_input"], state["resample_input"] + len(mono) - 1
        tail = state["resample_tail"]
        values = np.concatenate(([tail], mono)) if tail is not None else mono
        x_start = start - 1 if tail is not None else start
        step, position = source_rate / float(target_rate), max(float(x_start), state["resample_next"])
        count = max(0, int(np.floor((end - position) / step)) + 1)
        if count:
            positions = position + np.arange(count, dtype="float64") * step
            converted = np.interp(positions, np.arange(x_start, end + 1), values).astype("float32")
            state["resample_next"] = position + count * step
        else:
            converted = mono[:0]
        state["resample_input"], state["resample_tail"] = end + 1, float(mono[-1])
        return converted

    def add_voice(self, samples, vid=None, vol=1.0, source_rate=None) -> None:
        self.last_used = time.monotonic()
        samples = self._resample(samples, source_rate or self.source_rate, self.sample_rate)
        with self.voices_lock:
            if len(self.voices) >= 32:
                self.voices = self.voices[-31:]
            self.voices.append({"samples": samples, "pos": 0, "vid": vid, "vol": vol,
                                "paused": False, "sample_rate": self.sample_rate})

    def set_voice_paused(self, vid, paused) -> int:
        count = 0
        with self.voices_lock:
            for voice in self.voices:
                if voice.get("vid") == vid:
                    voice["paused"], count = bool(paused), count + 1
        return count

    def seek_voice(self, vid, seconds) -> int:
        count = 0
        with self.voices_lock:
            for voice in self.voices:
                if voice.get("vid") == vid:
                    target = round(max(0.0, float(seconds)) * int(voice.get("sample_rate") or self.sample_rate))
                    voice["pos"], count = min(target, len(voice["samples"])), count + 1
        return count

    def voice_status(self, vid) -> dict | None:
        with self.voices_lock:
            voice = next((item for item in self.voices if item.get("vid") == vid), None)
            if voice is None:
                return None
            rate = max(1, int(voice.get("sample_rate") or self.sample_rate))
            return {"position": int(voice["pos"]), "frames": int(len(voice["samples"])),
                    "currentTime": float(voice["pos"]) / rate,
                    "duration": float(len(voice["samples"])) / rate,
                    "paused": bool(voice.get("paused")), "sampleRate": rate}

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
            state.update(resample_input=0, resample_next=0.0, resample_tail=None,
                         resample_rate=0, starved=False)
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
        samples = (self._resample(samples, source_rate or self.source_rate, self.sample_rate)
                   if state is None else self._resample_lane(samples, state, source_rate))
        if state is not None:
            state["enqueued"] += len(samples)
        try:
            source.put_nowait(samples)
        except queue.Full:
            if state is not None:
                state["dropped"] += 1
            try:
                source.get_nowait()
                source.put_nowait(samples)
            except queue.Empty:
                pass

    def lane_stats(self, lane="primary") -> dict:
        state = self._lane(lane)
        if state is None:
            return {"dropped": 0, "underruns": 0, "backlogFrames": self.q.qsize()}
        pending = len(state["pending"]) if state["pending"] is not None else 0
        with state["q"].mutex:
            queued = sum(len(block) for block in list(state["q"].queue))
        return {"dropped": state["dropped"], "underruns": state["underruns"],
                "backlogFrames": pending + queued,
                "enqueuedFrames": state["enqueued"]}

    def stream_health(self, lane="primary", expected_id=None) -> dict:
        """Read-only physical callback and logical-lane health for an owned session."""
        try:
            active = bool(not self.closed and self.stream and self.stream.active)
        except Exception:
            active = False
        callback_age_ms = max(0, int((time.monotonic() - self.last_callback_at) * 1000))
        if str(lane or "primary") == "primary":
            stream_id = self.stream_id
        else:
            with self.stream_lanes_lock:
                state = self.stream_lanes.get(str(lane or "").strip().lower())
                stream_id = state.get("stream_id") if state else None
        identity_ok = expected_id is None or stream_id in (None, expected_id)
        return {
            "ok": active and callback_age_ms <= 1500 and identity_ok,
            "active": active,
            "callbackCount": int(self.cb_count),
            "callbackAgeMs": callback_age_ms,
            "streamId": stream_id,
            "identityOk": identity_ok,
        }

    def close(self) -> None:
        self.closed = True
        try:
            self.stream.stop()
            self.stream.close()
        except Exception:
            pass
