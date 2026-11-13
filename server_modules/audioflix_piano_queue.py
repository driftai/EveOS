"""Server-owned Piano queue scheduler; Chromium is never the transition clock.

The existing Piano native renderer remains the only audio owner. A queue is an
opt-in, authenticated projection of PianoPlayerQueue, not a separate mixer.
"""
from __future__ import annotations

import json
import random
import sys
import threading
import time
from pathlib import Path

from server_modules import audioflix_piano_native as native

ROOT = Path(__file__).resolve().parents[1]
PIANO_ROOT = ROOT / "tools" / "Piano-Auto-Player"
SONGS_PATH = PIANO_ROOT / "data" / "songs.json"
_LOCK = threading.RLock()
_QUEUE: dict | None = None
_MAX_ENTRIES = 500


def _entries(items: object) -> list[dict]:
    if not isinstance(items, list) or not 0 < len(items) <= _MAX_ENTRIES:
        raise RuntimeError("Piano queue requires between 1 and 500 entries.")
    entries, ids = [], set()
    for item in items:
        if not isinstance(item, dict):
            raise RuntimeError("Invalid Piano queue entry.")
        qid, sid = str(item.get("queueId") or ""), str(item.get("songId") or "")
        if not qid or len(qid) > 120 or not sid or len(sid) > 180 or qid in ids:
            raise RuntimeError("Piano queue entry ID is missing, duplicated, or invalid.")
        ids.add(qid)
        entries.append({"queueId": qid, "songId": sid})
    return entries


def _songs() -> dict:
    # Read-only snapshot of the Piano Backend library. Never write its data file.
    try:
        rows = json.loads(SONGS_PATH.read_text(encoding="utf-8")).get("songs", [])
    except (OSError, json.JSONDecodeError, AttributeError) as exc:
        raise RuntimeError("Piano library is unavailable to native queue playback.") from exc
    return {str(song.get("id")): song for song in rows if isinstance(song, dict) and song.get("id")}


def _timeline(song: dict, options: dict) -> dict:
    if str(PIANO_ROOT) not in sys.path:
        sys.path.insert(0, str(PIANO_ROOT))
    from app.playback_timing import PlaybackOptions
    from app.preview_timeline import build_performance_preview, build_sheet_preview
    valid = {
        "interval_ms": (10, 2000), "note_hold_ms": (1, 250), "speed": (.25, 3),
        "gate_percent": (10, 90), "modifier_lead_ms": (0, 30),
        "chord_spread_ms": (0, 30),
    }
    settings = {}
    for key, (lo, hi) in valid.items():
        if key in options:
            settings[key] = max(lo, min(hi, float(options[key])))
    overrides = ((song.get("identifiers") or {}).get("custom") or {})
    for key, setting in (("override_speed", "speed"), ("override_interval", "interval_ms"),
                         ("override_hold", "note_hold_ms"), ("override_gate", "gate_percent"),
                         ("override_chord_spread", "chord_spread_ms"),
                         ("override_black_lead", "modifier_lead_ms")):
        if key in overrides:
            lo, hi = valid[setting]
            settings[setting] = max(lo, min(hi, float(overrides[key])))
    if "override_interval" not in overrides and song.get("recommended_interval_ms"):
        settings["interval_ms"] = max(10, min(2000, float(song["recommended_interval_ms"])))
    settings["timing_profile"] = str(song.get("timing_profile") or "expressive")[:32]
    settings["piano_layout"] = str(options.get("piano_layout") or "61") if str(options.get("piano_layout")) in {"61", "88"} else "61"
    settings["start_event"] = 1  # Never inherit the prior song's seek position.
    settings["countdown_seconds"] = 0
    play = PlaybackOptions(**settings)
    performance = song.get("performance")
    if isinstance(performance, list) and performance:
        return build_performance_preview(performance, play)
    sheet = str(song.get("sheet") or "")
    if not sheet.strip():
        raise RuntimeError("Queued Piano song has no playable sheet or recording.")
    return build_sheet_preview(sheet, play)


def _require_queue(payload: dict) -> dict:
    with _LOCK:
        q = _QUEUE
        auth = q.get("initialAuth") if q else None
        if not auth or any(str(payload.get(key) or "") != str(value) for key, value in auth.items()):
            raise RuntimeError("Piano queue authorization is invalid or expired.")
        return q


def _view(q: dict) -> dict:
    with _LOCK:
        auth = dict(q["currentAuth"])
        entries = [dict(item) for item in q["entries"]]
        view = {"ok": True, "active": bool(q["active"]), "queueId": q["queueId"],
                "items": entries, "currentQueueId": q["currentQueueId"],
                "playingQueueId": q["playingQueueId"], "playingSongId": q["playingSongId"],
                "cursor": q["cursor"], "mode": q["mode"], "loop": q["loop"],
                "transitionMs": q["transitionMs"], "cycle": q["cycle"],
                "error": q.get("error") or ""}
    try:
        status = native.status(auth)
    except RuntimeError:
        status = {"state": "error", "message": "Native Piano session became unavailable."}
    view["currentStatus"] = status
    view["currentSession"] = {**auth, "deviceId": q["deviceId"], "soundId": q["soundId"]}
    return view


def _choose(q: dict) -> dict | None:
    """Select exactly one next song; shuffle only at cycle boundaries."""
    with _LOCK:
        entries = q["entries"]
        cursor = q["cursor"] + 1
        if cursor >= len(entries):
            if not q["loop"]:
                q["active"] = False
                q["cursor"] = len(entries)
                q["currentQueueId"] = ""
                return None
            if q["mode"] == "shuffle" and len(entries) > 1:
                last = q["currentQueueId"]
                random.shuffle(entries)
                if entries[0]["queueId"] == last:
                    entries[0], entries[1] = entries[1], entries[0]
            q["cycle"] += 1
            cursor = 0
        elif q["mode"] == "shuffle":
            chosen = random.randrange(cursor, len(entries))
            entries[cursor], entries[chosen] = entries[chosen], entries[cursor]
        q["cursor"] = cursor
        q["currentQueueId"] = entries[cursor]["queueId"]
        return dict(entries[cursor])


def _worker(q: dict) -> None:
    while not q["cancel"].wait(.2):
        with _LOCK:
            if _QUEUE is not q or not q["active"]:
                return
            auth = dict(q["currentAuth"])
        try:
            status = native.status(auth)
        except Exception as exc:
            with _LOCK:
                q["active"] = False
                q["error"] = str(exc)
            return
        state = status.get("state")
        if state in {"stopped", "error", "replaced"}:
            with _LOCK:
                q["active"] = False
                q["error"] = str(status.get("message") or "Native playback stopped.")
            return
        if state != "complete":
            continue
        with _LOCK:
            if q["mode"] == "manual":
                q["active"] = False
                return
            next_song = _choose(q)
            pause = q["transitionMs"] / 1000
        if not next_song or q["cancel"].wait(pause):
            return
        try:
            songs = _songs()
            song = songs.get(next_song["songId"])
            if not song:
                raise RuntimeError("A queued song is missing from the saved Piano library.")
            timeline = _timeline(song, q["options"])
            with _LOCK:
                if _QUEUE is not q or not q["active"] or q["cancel"].is_set():
                    return
                new_generation = int(q["currentAuth"]["generation"]) + 1
                receipt = native.start({"ownerId": q["ownerId"], "generation": new_generation,
                                        "deviceId": q["deviceId"], "timeline": timeline,
                                        "soundId": q["soundId"], "volumePercent": q["volumePercent"],
                                        "sampleRate": q["sampleRate"]}, queue_internal=True)
                q["currentAuth"] = {key: receipt[key] for key in ("sessionId", "sessionToken", "ownerId", "generation")}
                q["playingQueueId"] = next_song["queueId"]
                q["playingSongId"] = next_song["songId"]
        except Exception as exc:
            with _LOCK:
                q["active"] = False
                q["error"] = f"Native queue stopped: {exc}"
            return


def invalidate() -> None:
    global _QUEUE
    with _LOCK:
        if _QUEUE:
            _QUEUE["cancel"].set()
            _QUEUE["active"] = False
            _QUEUE = None


def arm(payload: dict) -> dict:
    global _QUEUE
    _, entry = native._require(payload)
    with native._LOCK:
        receipt = native._public(entry)
        if entry["sessionId"] != native._ACTIVE_ID:
            raise RuntimeError("The requested native Piano session is no longer the active owner.")
        if receipt["state"] not in {"rendering", "playing", "paused"}:
            raise RuntimeError("Native queue requires a live Piano song first.")
        items = _entries(payload.get("items"))
        current = str(payload.get("currentQueueId") or "")
        index = next((i for i, item in enumerate(items) if item["queueId"] == current), -1)
        if index < 0:
            raise RuntimeError("Current queue entry is not present.")
        songs = _songs()
        if any(item["songId"] not in songs for item in items):
            raise RuntimeError("A queued song is missing from the saved Piano library.")
        mode = str(payload.get("mode") or "ordered")
        if mode not in {"ordered", "manual", "shuffle"}:
            raise RuntimeError("Invalid native Piano queue mode.")
        options = payload.get("options") if isinstance(payload.get("options"), dict) else {}
        q = {"queueId": f"native-queue:{entry['sessionId']}", "initialAuth": {key: payload[key] for key in ("sessionId", "sessionToken", "ownerId", "generation")},
             "currentAuth": {key: receipt[key] for key in ("sessionId", "ownerId", "generation")},
             "entries": items, "currentQueueId": current, "cursor": index,
             "playingQueueId": current, "playingSongId": items[index]["songId"],
             "ownerId": entry["ownerId"], "deviceId": entry["deviceId"],
             "soundId": entry["soundId"], "sampleRate": entry["sampleRate"],
             "volumePercent": max(0, min(100, float(payload.get("volumePercent") or 100))),
             "options": dict(options), "mode": mode, "loop": bool(payload.get("loop")),
             "transitionMs": max(250, min(1500, int(payload.get("transitionMs") or 750))),
             "cycle": 0, "active": True, "cancel": threading.Event(), "error": ""}
        q["currentAuth"]["sessionToken"] = entry["token"]
    invalidate()
    with _LOCK:
        _QUEUE = q
        worker = threading.Thread(target=_worker, args=(q,), daemon=True, name="eveos-piano-native-queue")
        q["thread"] = worker
        worker.start()
    return _view(q)


def status(payload: dict) -> dict:
    return _view(_require_queue(payload))


def update(payload: dict) -> dict:
    q = _require_queue(payload)
    with _LOCK:
        mode = str(payload.get("mode") or q["mode"])
        if mode not in {"ordered", "manual", "shuffle"}:
            raise RuntimeError("Invalid queue mode.")
        q["mode"] = mode
        q["loop"] = bool(payload.get("loop", q["loop"]))
        q["transitionMs"] = max(250, min(1500, int(payload.get("transitionMs") or q["transitionMs"])))
        if "items" in payload:
            incoming = _entries(payload["items"])
            if not any(item["queueId"] == q["currentQueueId"] for item in incoming):
                raise RuntimeError("Cannot remove the playing item from the native queue; stop first.")
            q["entries"] = incoming
            q["cursor"] = next(i for i, item in enumerate(incoming) if item["queueId"] == q["currentQueueId"])
    return _view(q)


def stop(payload: dict) -> dict:
    q = _require_queue(payload)
    with _LOCK:
        q["active"] = False
        q["cancel"].set()
    return _view(q)


def handle(path: str, payload: dict) -> dict:
    action = {
        "/api/audioflix/piano-native/queue-arm": arm,
        "/api/audioflix/piano-native/queue-status": status,
        "/api/audioflix/piano-native/queue-update": update,
        "/api/audioflix/piano-native/queue-stop": stop,
    }.get(path)
    if not action:
        raise RuntimeError("Unknown Piano native queue action.")
    return action(payload)
