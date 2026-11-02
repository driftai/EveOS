"""Authenticated, short-lived provider PCM sessions over the existing native renderer."""

from __future__ import annotations

import base64
import hmac
import secrets
import threading
import time

from server_modules.audioflix_bridge_playback import _player_for, play_pcm, stop_stream

_LOCK = threading.RLock()
_START_LOCK = threading.Lock()
_MANAGED_IDLE_RECLAIM_SECONDS = 15
_SESSIONS: dict[str, dict] = {}
_TTL_SECONDS = 5 * 60
_MAX_PCM_BYTES = 65536  # A 4096-frame mono block is about 8 KiB; reject bulk uploads.


def _now() -> float:
    return time.time()


def _expired(entry: dict, now: float) -> bool:
    return now > float(entry.get("expiresAt") or 0)


def _discard(session_id: str, entry: dict) -> None:
    stop_stream({
        "deviceId": entry.get("deviceId") or "",
        "sampleRate": entry.get("sampleRate") or 48000,
        "itemId": session_id,
    })


def _reap(now: float) -> None:
    stale = []
    with _LOCK:
        for session_id, entry in list(_SESSIONS.items()):
            if _expired(entry, now):
                stale.append((session_id, _SESSIONS.pop(session_id)))
    for session_id, entry in stale:
        # A PCM request may still be in flight. Drain it before flushing the stream.
        with entry["ioLock"]:
            _discard(session_id, entry)


def _require(payload: dict) -> tuple[str, dict]:
    session_id = str(payload.get("sessionId") or "")
    token = str(payload.get("captureToken") or "")
    now = _now()
    _reap(now)
    with _LOCK:
        entry = _SESSIONS.get(session_id)
        if not entry or not token or not hmac.compare_digest(token, entry["token"]):
            raise RuntimeError("Provider capture session is invalid or expired.")
        if _expired(entry, now):
            raise RuntimeError("Provider capture session expired.")
        entry["lastSeenAt"] = now
        entry["expiresAt"] = now + _TTL_SECONDS
        return session_id, entry


def start(payload: dict) -> dict:
    device_id = str(payload.get("deviceId") or "")
    sample_rate = max(8000, min(192000, int(payload.get("sampleRate") or 48000)))
    channels = max(1, min(2, int(payload.get("channels") or 1)))
    if not device_id.startswith("sd:"):
        raise RuntimeError("Provider capture requires an exact native output endpoint.")
    source = str(payload.get("source") or "provider-tab")[:80]
    # Only an inactive managed-Spotify lease for this *same endpoint* may be
    # reclaimed; active PCM and every other provider remain exclusive.
    with _START_LOCK:
        now = _now()
        _reap(now)
        orphan = None
        with _LOCK:
            if _SESSIONS:
                old_id, old = next(iter(_SESSIONS.items()))
                quiet = now - float(old.get("lastPcmAt", old["createdAt"]))
                if not (source == "managed-spotify"
                        and old["source"] == source and old["deviceId"] == device_id
                        and _MANAGED_IDLE_RECLAIM_SECONDS <= quiet < _TTL_SECONDS):
                    raise RuntimeError("Another provider capture session already owns the capture lane.")
                orphan = (old_id, _SESSIONS.pop(old_id))
        if orphan:
            # A final in-flight chunk must drain before its native stream is flushed.
            with orphan[1]["ioLock"]:
                _discard(*orphan)
        with _LOCK:
            if _SESSIONS:
                raise RuntimeError("Another provider capture session already owns the capture lane.")
            player = _player_for(device_id, sample_rate, 1, "provider-capture")
            if not player.stream or not player.stream.active:
                raise RuntimeError("Selected native output renderer did not start.")
            session_id = f"provider:{secrets.token_hex(12)}"
            token = secrets.token_urlsafe(32)
            entry = {
                "token": token,
                "ioLock": threading.Lock(),
                "deviceId": device_id,
                "sampleRate": sample_rate,
                "channels": channels,
                "source": source,
                "createdAt": now,
                "lastSeenAt": now,
                "lastPcmAt": now,
                "expiresAt": now + _TTL_SECONDS,
                "chunks": 0,
                "samples": 0,
                "nonzeroChunks": 0,
                "gain": 1.0,
            }
            _SESSIONS[session_id] = entry
    return {
        "ok": True,
        "sessionId": session_id,
        "captureToken": token,
        "deviceId": device_id,
        "sampleRate": sample_rate,
        "channels": channels,
        "rendererRunning": True,
        "expiresAt": int(entry["expiresAt"] * 1000),
    }


def chunk(payload: dict) -> dict:
    session_id, entry = _require(payload)
    audio = str(payload.get("audio") or "")
    if not audio:
        raise RuntimeError("Provider capture chunk is empty.")
    # Bound decode allocation, and reject malformed/mismatched channel frames before
    # they can be forwarded into the native callback queue.
    if len(audio) > ((_MAX_PCM_BYTES + 2) // 3) * 4 + 4:
        raise RuntimeError("Provider capture PCM block exceeds the size limit.")
    raw = base64.b64decode(audio, validate=True)
    if not raw or len(raw) > _MAX_PCM_BYTES:
        raise RuntimeError("Provider capture PCM block exceeds the size limit.")
    channels = int(payload.get("channels") or entry["channels"])
    if channels != entry["channels"] or len(raw) % (2 * channels):
        raise RuntimeError("Provider capture PCM channels or frame alignment mismatch.")
    gain = max(0.0, min(1.0, float(payload.get("gain", 1.0))))

    # Stop and chunk must serialize against the same session. Without this fence,
    # a verified HTTP chunk may enqueue *after* Stop has already cleared the PCM
    # stream, leaving orphan audio on CABLE.
    with entry["ioLock"]:
        with _LOCK:
            if _SESSIONS.get(session_id) is not entry:
                raise RuntimeError("Provider capture session has already stopped.")
        result = play_pcm({
            "audio": audio,
            "deviceId": entry["deviceId"],
            "sampleRate": entry["sampleRate"],
            "channels": channels,
            "streamId": session_id,
            "sentAtMs": payload.get("sentAtMs") or int(_now() * 1000),
            "maxAgeMs": payload.get("maxAgeMs") or 1200,
            "lane": "provider-capture",
            "strictDevice": True,
            "gain": gain,
        })
        if result.get("ok") is not True or result.get("deviceId") != entry["deviceId"]:
            raise RuntimeError(result.get("message") or "Provider capture native renderer rejected PCM.")
        with _LOCK:
            if _SESSIONS.get(session_id) is not entry:
                raise RuntimeError("Provider capture session has already stopped.")
            entry["lastPcmAt"] = _now()
            entry["chunks"] += 1
            entry["samples"] += len(raw) // 2 // channels
            entry["nonzeroChunks"] += int(any(raw))
            entry["gain"] = gain
    return {
        "ok": True,
        "sessionId": session_id,
        "deviceId": result.get("deviceId"),
        "rendererRunning": True,
        "queued": result.get("queued") or 0,
        "gain": gain,
        "nonzero": bool(any(raw)),
    }


def status(payload: dict) -> dict:
    session_id, entry = _require(payload)
    return {
        "ok": True,
        "sessionId": session_id,
        "deviceId": entry["deviceId"],
        "sampleRate": entry["sampleRate"],
        "channels": entry["channels"],
        "source": entry["source"],
        "chunks": entry["chunks"],
        "samples": entry["samples"],
        "nonzeroChunks": entry["nonzeroChunks"],
        "gain": entry["gain"],
        "expiresAt": int(entry["expiresAt"] * 1000),
    }


def stop(payload: dict) -> dict:
    session_id, entry = _require(payload)
    with entry["ioLock"]:
        with _LOCK:
            if _SESSIONS.get(session_id) is not entry:
                raise RuntimeError("Provider capture session has already stopped.")
            _SESSIONS.pop(session_id, None)
        _discard(session_id, entry)
    return {
        "ok": True,
        "sessionId": session_id,
        "deviceId": entry["deviceId"],
        "chunks": entry["chunks"],
        "samples": entry["samples"],
        "nonzeroChunks": entry["nonzeroChunks"],
        "stopped": True,
    }


def handle(path: str, payload: dict) -> dict:
    action = {
        "/api/audioflix/provider-capture/start": start,
        "/api/audioflix/provider-capture/chunk": chunk,
        "/api/audioflix/provider-capture/status": status,
        "/api/audioflix/provider-capture/stop": stop,
    }.get(path)
    if not action:
        raise RuntimeError("Unknown provider capture action.")
    return action(payload)
