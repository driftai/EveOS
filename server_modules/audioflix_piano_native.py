"""Authenticated server-owned Piano rendering and native playback sessions."""
from __future__ import annotations

import hmac
from bisect import bisect_right
from pathlib import Path
import secrets
import threading
import time

from server_modules.audioflix_bridge_playback import _player_for
from server_modules.audioflix_piano_native_synth import render_timeline

_LOCK = threading.RLock()
_SESSIONS: dict[str, dict] = {}
_ACTIVE_ID = ""
_MAX_TIMELINE_BYTES = 24 * 1024 * 1024


def _cleanup_audio(entry: dict) -> None:
    path = entry.pop("renderFile", None)
    if path:
        try:
            Path(path).unlink(missing_ok=True)
        except OSError:
            # On Windows a released callback may hold the mapped buffer briefly.
            entry["renderFile"] = path


def _public(entry: dict) -> dict:
    player = entry.get("player")
    voice = player.voice_status(entry["voiceId"]) if player is not None else None
    state = entry["state"]
    if state in {"playing", "paused"} and not bool(player and getattr(player.stream, "active", False)):
        _stop_entry(entry, "error")
        entry["message"] = "Selected Piano native output stopped; no other device was selected."
        state = "error"
    elif state == "playing" and voice is None:
        state = entry["state"] = "complete"
        entry["currentTime"] = entry.get("duration", 0.0)
        entry["completedAt"] = time.time()
        _cleanup_audio(entry)
    current = voice.get("currentTime", 0.0) if voice else entry.get("currentTime", 0.0)
    duration = voice.get("duration", entry.get("duration", 0.0)) if voice else entry.get("duration", 0.0)
    current_index = min(entry["totalEvents"], max(1, bisect_right(entry.get("eventTimes", []), current)))
    return {
        "ok": True, "sessionId": entry["sessionId"], "ownerId": entry["ownerId"],
        "generation": entry["generation"], "deviceId": entry["deviceId"],
        "state": state, "paused": state == "paused", "currentTime": current,
        "duration": duration, "renderedEvents": entry.get("renderedEvents", 0),
        "totalEvents": entry["totalEvents"], "currentIndex": current_index,
        "message": entry.get("message", ""),
        "soundId": entry["soundId"], "rendererRunning": bool(player and player.stream and player.stream.active),
    }


def _require(payload: dict) -> tuple[str, dict]:
    session_id, token = str(payload.get("sessionId") or ""), str(payload.get("sessionToken") or "")
    with _LOCK:
        entry = _SESSIONS.get(session_id)
        if not entry or not token or not hmac.compare_digest(token, entry["token"]):
            raise RuntimeError("Server-owned Piano session is invalid.")
        if (str(payload.get("ownerId") or "") != entry["ownerId"]
                or int(payload.get("generation") or 0) != entry["generation"]):
            raise RuntimeError("Server-owned Piano owner or generation is stale.")
        return session_id, entry


def _stop_entry(entry: dict, state: str = "stopped") -> None:
    entry["cancel"].set()
    player = entry.get("player")
    if player is not None:
        player.clear_voices(entry["voiceId"])
    entry["state"], entry["message"] = state, "Server-owned Piano stopped."
    _cleanup_audio(entry)


def _render(entry: dict, timeline: dict, volume: float) -> None:
    try:
        entry["message"] = "Rendering Piano with the selected EveOS instrument…"
        def progress(done, total):
            with _LOCK:
                if _SESSIONS.get(entry["sessionId"]) is entry:
                    entry["renderedEvents"] = done
                    entry["message"] = f"Rendering Piano {done}/{total} events…"
        samples = render_timeline(timeline, entry["soundId"], volume, entry["sampleRate"],
                                  entry["cancel"].is_set, progress)
        render_file = str(samples.filename) if hasattr(samples, "filename") else None
        with _LOCK:
            if _SESSIONS.get(entry["sessionId"]) is not entry or entry["cancel"].is_set():
                if render_file:
                    try: Path(render_file).unlink(missing_ok=True)
                    except OSError: pass
                return
            if render_file: entry["renderFile"] = render_file
            player = entry["player"]
            if not player.stream or not player.stream.active:
                raise RuntimeError("Selected native Piano renderer stopped before playback.")
            player.clear_voices(entry["voiceId"])
            player.add_voice(samples, entry["voiceId"], 1.0, entry["sampleRate"])
            entry["duration"] = len(samples) / float(player.sample_rate)
            entry["state"], entry["message"] = "playing", "Playing from the server-owned Piano engine."
    except Exception as exc:  # noqa: BLE001
        with _LOCK:
            if _SESSIONS.get(entry["sessionId"]) is entry and not entry["cancel"].is_set():
                entry["state"], entry["message"] = "error", str(exc)
                _cleanup_audio(entry)


def start(payload: dict) -> dict:
    global _ACTIVE_ID
    owner, generation = str(payload.get("ownerId") or "")[:120], int(payload.get("generation") or 0)
    device, timeline = str(payload.get("deviceId") or ""), payload.get("timeline")
    if len(owner) < 16 or generation < 1:
        raise RuntimeError("Server-owned Piano requires an authenticated owner generation.")
    if not device.startswith("sd:"):
        raise RuntimeError("Server-owned Piano requires an exact native output endpoint.")
    if not isinstance(timeline, dict) or not isinstance(timeline.get("events"), list):
        raise RuntimeError("Server-owned Piano requires a complete timeline.")
    if len(repr(timeline).encode("utf-8")) > _MAX_TIMELINE_BYTES:
        raise RuntimeError("Server-owned Piano timeline exceeds the safe limit.")
    from server_modules.audioflix_piano_native_synth import _BANKS
    sound_id = str(payload.get("soundId") or "acoustic_grand")
    if sound_id not in _BANKS and sound_id != "legacy_synth":
        raise RuntimeError("Unknown Piano instrument; native playback was not started.")
    sample_rate = max(24000, min(96000, int(payload.get("sampleRate") or 48000)))
    player = _player_for(device, sample_rate, 1, "piano-pcm")
    sample_rate = int(player.sample_rate)  # Do not resample a whole disk-backed song into RAM.
    if not player.stream or not player.stream.active:
        raise RuntimeError("Selected native Piano endpoint did not start.")
    with _LOCK:
        current = _SESSIONS.get(_ACTIVE_ID)
        if current and current["state"] not in {"stopped", "complete", "error"}:
            same_owner = current["ownerId"] == owner and generation > current["generation"]
            if not same_owner:
                raise RuntimeError("Another server-owned Piano session is active.")
            _stop_entry(current, "replaced")
        session_id = f"piano-native:{secrets.token_hex(12)}"
        entry = {
            "sessionId": session_id, "token": secrets.token_urlsafe(32), "ownerId": owner,
            "generation": generation, "deviceId": device, "sampleRate": sample_rate,
            "soundId": sound_id,
            "eventTimes": [float(e.get("at_ms") or 0) / 1000 for e in timeline["events"]],
            "voiceId": session_id, "player": player, "cancel": threading.Event(),
            "state": "rendering", "message": "Preparing server-owned Piano…",
            "renderedEvents": 0, "totalEvents": len(timeline["events"]), "createdAt": time.time(),
        }
        _SESSIONS[session_id], _ACTIVE_ID = entry, session_id
        thread = threading.Thread(target=_render, args=(entry, timeline, float(payload.get("volumePercent", 100))),
                                  daemon=True, name="audioflix-piano-native-render")
        entry["thread"] = thread
        thread.start()
        result = _public(entry)
        result["sessionToken"] = entry["token"]
        return result


def status(payload: dict) -> dict:
    _, entry = _require(payload)
    with _LOCK:
        return _public(entry)


def pause(payload: dict) -> dict:
    _, entry = _require(payload)
    paused = bool(payload.get("paused", True))
    with _LOCK:
        if entry["state"] not in {"playing", "paused"}:
            raise RuntimeError("Server-owned Piano is not currently playable.")
        if entry["player"].set_voice_paused(entry["voiceId"], paused) != 1:
            raise RuntimeError("Server-owned Piano renderer no longer owns this session.")
        entry["state"] = "paused" if paused else "playing"
        entry["message"] = "Server-owned Piano paused." if paused else "Server-owned Piano resumed."
        return _public(entry)


def seek(payload: dict) -> dict:
    _, entry = _require(payload)
    seconds = max(0.0, float(payload.get("seconds") or 0))
    with _LOCK:
        if entry["state"] not in {"playing", "paused"}:
            raise RuntimeError("Server-owned Piano cannot seek in its current state.")
        if entry["player"].seek_voice(entry["voiceId"], seconds) != 1:
            raise RuntimeError("Server-owned Piano renderer no longer owns this session.")
        entry["message"] = f"Server-owned Piano seeked to {seconds:.2f}s."
        return _public(entry)


def volume(payload: dict) -> dict:
    _, entry = _require(payload)
    value = max(0.0, min(1.0, float(payload.get("volume") or 0)))
    with _LOCK:
        if entry["player"].set_voice_volume(entry["voiceId"], value) != 1:
            raise RuntimeError("Server-owned Piano renderer no longer owns this session.")
        entry["message"] = f"Server-owned Piano volume {round(value * 100)}%."
        return _public(entry)


def stop(payload: dict) -> dict:
    session_id, entry = _require(payload)
    with _LOCK:
        _stop_entry(entry)
        result = _public(entry)
        result["stopped"] = True
        if _SESSIONS.get(session_id) is entry:
            _SESSIONS.pop(session_id, None)
        return result


def handle(path: str, payload: dict) -> dict:
    action = {
        "/api/audioflix/piano-native/start": start,
        "/api/audioflix/piano-native/status": status,
        "/api/audioflix/piano-native/pause": pause,
        "/api/audioflix/piano-native/seek": seek,
        "/api/audioflix/piano-native/volume": volume,
        "/api/audioflix/piano-native/stop": stop,
    }.get(path)
    if action is None:
        raise RuntimeError("Unknown server-owned Piano action.")
    return action(payload)
