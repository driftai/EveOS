"""Audioflix native PCM playback, streaming, and one-shot voice mixing."""

from __future__ import annotations

import base64
import threading
import time
from pathlib import Path

from server_modules import audioflix_bridge_media
from server_modules.audioflix_bridge_player import PcmPlayer as _PcmPlayer
try:
    import numpy as np
except Exception:  # pragma: no cover - optional runtime dependency
    np = None

try:
    import sounddevice as sd
except Exception:  # pragma: no cover - optional runtime dependency
    sd = None

_PLAYERS: dict[str, "_PcmPlayer"] = {}
_PLAYER_LOCKS: dict[str, threading.Lock] = {}
_LOCK = threading.Lock()
_PROJECT_ROOT = Path(__file__).resolve().parents[1]


def refresh_portaudio_devices() -> None:
    """Reinitialize PortAudio without racing active Audioflix players."""
    if sd is None:
        return
    with _LOCK:
        for player in list(_PLAYERS.values()):
            try:
                player.close()
            except Exception:
                pass
        _PLAYERS.clear()
        _PLAYER_LOCKS.clear()
        sd._terminate()
        sd._initialize()


def _resample_mono(samples, src_rate: int, dst_rate: int):
    if np is None or not src_rate or not dst_rate or int(src_rate) == int(dst_rate):
        return samples
    mono = np.asarray(samples, dtype="float32").reshape(-1)
    if mono.size == 0:
        return mono
    dst_count = int(round(mono.size * (int(dst_rate) / float(src_rate))))
    if dst_count <= 0:
        return mono[:0]
    return np.interp(np.linspace(0.0, mono.size - 1, dst_count), np.arange(mono.size), mono).astype("float32")


def _open_output_stream(device_index: int, channels: int, callback, preferred_rate: int):
    rates = [preferred_rate] if preferred_rate else []
    try:
        r = int(sd.query_devices(device_index).get("default_samplerate") or 0)
        if r:
            rates.append(r)
    except Exception:
        pass
    rates.extend([48000, 44100, 96000, 32000, 24000, 16000])
    seen, last_err = set(), None
    for rate in rates:
        r = int(rate or 0)
        if r <= 0 or r in seen:
            continue
        seen.add(r)
        try:
            stream = sd.OutputStream(samplerate=r, channels=channels, dtype="float32", device=device_index, blocksize=1024, callback=callback)
            stream.start()
            return stream, r
        except Exception as err:
            last_err = err
    raise RuntimeError(f"Could not open stream for {device_index}: {last_err}")


def _player_for(device_id: str, sample_rate: int, channels: int, lane: str = "primary") -> _PcmPlayer:
    if sd is None or np is None:
        raise RuntimeError("Native playback requires the optional sounddevice and numpy packages.")
    if not isinstance(device_id, str) or not device_id.startswith("sd:"):
        try:
            default_idx = sd.default.device[1]
            if default_idx is not None and default_idx >= 0:
                device_id = f"sd:{default_idx}"
            else:
                raise ValueError()
        except Exception:
            raise RuntimeError("Selected native output is not a playable sounddevice endpoint.")
    lane = str(lane or "primary").strip().lower()
    if lane not in {"primary", "provider-capture", "piano-pcm"}:
        raise RuntimeError("Unknown native playback lane.")
    key = f"{device_id}:{channels}:shared"
    index = int(str(device_id).split(":", 1)[1])
    with _LOCK:
        open_lock = _PLAYER_LOCKS.setdefault(device_id, threading.Lock())
    with open_lock:
        with _LOCK:
            player = _PLAYERS.get(key)
        # Recreate if missing, closed, OR its stream has died. A dead stream silently swallowed
        # soundboard voices — they queued onto it but never played — so reviving here self-heals the
        # next play even if a stream ever stops (callback error, device hiccup, sample-rate switch).
        try:
            alive = player is not None and not player.closed and player.stream is not None and player.stream.active
        except Exception:
            alive = False
        if not alive:
            if player is not None:
                try:
                    player.close()
                except Exception:
                    pass
            player = _PcmPlayer(index, sample_rate, channels, _open_output_stream, _resample_mono)
            with _LOCK:
                _PLAYERS[key] = player
        return player
def _enqueue_mono(device_id: str, sample_rate: int, samples, kind: str, stream_id=None,
                  expires_at_ms=None, lane="primary", strict_device=False) -> dict:
    if sd is None or np is None:
        raise RuntimeError("Native playback requires the optional sounddevice and numpy packages.")
    if not device_id:
        device_id = "default"
    mono = np.asarray(samples, dtype="float32").reshape(-1)
    used_device, fell_back = device_id, False
    try:
        player = _player_for(device_id, sample_rate, 1, lane)
    except Exception:
        # Legacy lanes may fall back and report it; strict capture must fail closed.
        if device_id == "default" or strict_device:
            raise
        player = _player_for("default", sample_rate, 1, lane)
        used_device, fell_back = "default", True
    if expires_at_ms is not None and (time.time() * 1000) > expires_at_ms:
        return {"ok": False, "stale": True, "message": "Expired PCM chunk was not queued."}
    player.enqueue(mono, stream_id, lane, sample_rate)
    lane_stats = player.lane_stats(lane) if callable(getattr(player, "lane_stats", None)) else {
        "dropped": 0, "underruns": 0, "backlogFrames": 0, "enqueuedFrames": int(mono.shape[0])
    }
    return {
        "ok": True,
        "kind": kind,
        "queued": int(mono.shape[0]),
        "sampleRate": sample_rate,
        "deviceId": used_device,
        "requestedDeviceUnavailable": fell_back,
        **lane_stats,
    }


def play_pcm(payload: dict) -> dict:
    if sd is None or np is None:
        return {"ok": False, "message": "Native playback requires sounddevice and numpy."}
    audio, device_id = str(payload.get("audio") or ""), str(payload.get("deviceId") or "")
    if not audio:
        return {"ok": False, "message": "Missing PCM audio payload."}
    sent_at_ms = float(payload.get("sentAtMs") or 0)
    max_age_ms = max(100.0, min(5000.0, float(payload.get("maxAgeMs") or 1200)))
    expires_at_ms = sent_at_ms + max_age_ms if sent_at_ms > 0 else None
    if expires_at_ms is not None and (time.time() * 1000) > expires_at_ms:
        return {"ok": False, "stale": True, "message": "Expired PCM chunk was not decoded."}
    samples = np.frombuffer(base64.b64decode(audio), dtype="<i2").astype("float32") / 32768.0
    samples *= max(0.0, min(1.0, float(payload.get("gain", 1.0))))
    channels = max(1, int(payload.get("channels") or 1))
    if channels > 1:
        samples = samples.reshape((-1, channels))[:, 0]
    return _enqueue_mono(
        device_id, int(payload.get("sampleRate") or 24000), samples, "pcm",
        payload.get("streamId"), expires_at_ms, payload.get("lane") or "primary",
        payload.get("strictDevice") is True,
    )


def play_tone(payload: dict) -> dict:
    if sd is None or np is None:
        return {"ok": False, "message": "Native playback requires sounddevice and numpy."}
    return audioflix_bridge_media.play_tone(payload, np, _enqueue_mono)


def play_media(payload: dict) -> dict:
    if sd is None or np is None:
        return {"ok": False, "message": "Native playback requires sounddevice and numpy."}
    return audioflix_bridge_media.play_media(payload, np, _enqueue_mono, _PROJECT_ROOT)


def play_voice(payload: dict) -> dict:
    """Add a complete clip as a mixable one-shot voice (soundboard layering)."""
    if sd is None or np is None:
        return {"ok": False, "message": "Native playback requires sounddevice and numpy."}
    audio, device_id = str(payload.get("audio") or ""), str(payload.get("deviceId") or "")
    if not audio:
        return {"ok": False, "message": "Missing PCM audio payload."}
    if not device_id:
        return {"ok": False, "message": "No native output device selected."}
    samples = np.frombuffer(base64.b64decode(audio), dtype="<i2").astype("float32") / 32768.0
    channels = max(1, int(payload.get("channels") or 1))
    if channels > 1:
        samples = samples.reshape((-1, channels))[:, 0]
    volume = max(0.0, min(4.0, float(payload.get("volume", 1.0) or 1.0)))
    player = _player_for(device_id, int(payload.get("sampleRate") or 24000), 1)
    # replace=True atomically swaps the prior voice with this id (single-lane "normal"
    # play) so a separate clear+add can't race and drop the new sound.
    if payload.get("replace"):
        player.clear_voices(payload.get("voiceId"))
    player.add_voice(samples, payload.get("voiceId"), volume, int(payload.get("sampleRate") or 24000))
    return {"ok": True, "kind": "voice", "queued": int(samples.shape[0]), "deviceId": device_id, "voices": len(player.voices)}

def warm(payload: dict) -> dict:
    """Pre-open the output stream for a device + rate so the FIRST stream/voice isn't clipped by
    a cold WASAPI open. The client calls this when the native bridge is armed, so the first
    Gemini reply hits an already-running CABLE stream (was the first-play cutout)."""
    if sd is None or np is None:
        return {"ok": False, "message": "Native playback unavailable."}
    device_id = str(payload.get("deviceId") or "")
    if not device_id:
        return {"ok": False, "message": "No native output device selected."}
    rate = int(payload.get("sampleRate") or 24000)
    try:
        player = _player_for(device_id, rate, 1)
        return {"ok": True, "deviceId": device_id, "sampleRate": rate, "warmed": bool(player and player.stream)}
    except Exception as exc:
        return {"ok": False, "message": str(exc)}


def set_voice_volume(payload: dict) -> dict:
    if sd is None or np is None:
        return {"ok": False, "message": "Native playback unavailable."}
    device_id = str(payload.get("deviceId") or "")
    vid = payload.get("voiceId")
    vol = max(0.0, min(4.0, float(payload.get("volume", 1.0) or 1.0)))
    if not device_id or not vid:
        return {"ok": False, "message": "Missing deviceId or voiceId."}
    with _LOCK:
        players = [p for k, p in _PLAYERS.items() if k.startswith(device_id + ":")]
    updated = sum(p.set_voice_volume(vid, vol) for p in players)
    return {"ok": True, "updated": updated, "deviceId": device_id}

def clear_voices(payload: dict) -> dict:
    if sd is None or np is None:
        return {"ok": False, "message": "Native playback unavailable."}
    device_id = str(payload.get("deviceId") or "")
    vid = payload.get("voiceId")
    all_devices = payload.get("allDevices") is True
    with _LOCK:
        players = list(_PLAYERS.values()) if all_devices else [p for k, p in _PLAYERS.items() if k.startswith(device_id + ":")]
    cleared = sum(p.clear_voices(vid) for p in players)
    return {"ok": True, "cleared": cleared, "allDevices": all_devices}

def pause_voices(payload: dict) -> dict:
    if sd is None or np is None:
        return {"ok": False, "message": "Native playback unavailable."}
    device_id = str(payload.get("deviceId") or "")
    all_devices, paused = payload.get("allDevices") is True, payload.get("paused") is True
    with _LOCK:
        players = list(_PLAYERS.values()) if all_devices else [p for k, p in _PLAYERS.items() if k.startswith(device_id + ":")]
    affected = sum(player.set_voices_paused(paused) for player in players)
    return {"ok": True, "paused": paused, "affected": affected, "allDevices": all_devices}


def stop_stream(payload: dict) -> dict:
    """Stop the Gemini streaming lane without clearing independently mixed soundboard voices."""
    if sd is None or np is None:
        return {"ok": False, "message": "Native playback unavailable."}
    device_id = str(payload.get("deviceId") or "")
    all_devices = payload.get("allDevices") is True
    with _LOCK:
        players = list(_PLAYERS.values()) if all_devices else [p for k, p in _PLAYERS.items() if k.startswith(device_id + ":")]
    stream_id, lane = payload.get("itemId"), str(payload.get("lane") or "primary")
    dropped = sum(p.clear_stream(stream_id, lane) for p in players)
    return {"ok": True, "streamDropped": dropped, "allDevices": all_devices, "itemId": stream_id, "lane": lane}


def stream_health(device_id: str, lane: str, expected_id=None) -> dict:
    """Inspect an existing physical renderer without opening or replacing it."""
    with _LOCK:
        players = [player for key, player in _PLAYERS.items() if key.startswith(str(device_id) + ":")]
    if not players:
        return {"ok": False, "active": False, "reason": "renderer-missing"}
    snapshots = [player.stream_health(lane, expected_id) for player in players]
    healthy = next((item for item in snapshots if item.get("ok") is True), None)
    return healthy or {**snapshots[0], "ok": False, "reason": "renderer-stalled"}

def get_voice_debug() -> dict:
    """Return a lock-safe snapshot without exposing mutable player internals."""
    with _LOCK:
        return {
            key: {
                "source_rate": player.source_rate,
                "sample_rate": player.sample_rate,
                "last_frames": player.last_frames,
                "cb_count": player.cb_count,
                "stream_active": bool(player.stream and player.stream.active), "voices_paused": player.voices_paused,
                "voices": [
                    {
                        "len": int(len(voice["samples"])),
                        "pos": int(voice["pos"]),
                        "vid": voice.get("vid"),
                        "vol": voice.get("vol", 1.0),
                    }
                    for voice in player.voices
                ],
            }
            for key, player in _PLAYERS.items()
        }
