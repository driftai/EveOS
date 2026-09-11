from __future__ import annotations

import json
import threading
import time
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .parser import summarize_sheet
from .performance_notes import clean_performance


class SongLibrary:
    def __init__(self, path: Path) -> None:
        self.path = path
        self._lock = threading.RLock()
        self.path.parent.mkdir(parents=True, exist_ok=True)
        if not self.path.exists():
            self._write({"songs": []})

    def list(self) -> list[dict[str, Any]]:
        with self._lock:
            data = self._read()
            changed = False
            songs: list[dict[str, Any]] = []
            for song in data.get("songs", []):
                enriched, was_changed = self._enrich_record(song)
                songs.append(enriched)
                changed = changed or was_changed
            if changed:
                data["songs"] = songs
                self._write(data)
            return sorted(songs, key=lambda song: song.get("updated_at", 0), reverse=True)

    def get(self, song_id: str) -> dict[str, Any] | None:
        with self._lock:
            data = self._read()
            for song in data.get("songs", []):
                if str(song.get("id")) == str(song_id):
                    enriched, _ = self._enrich_record(song)
                    return enriched
            return None

    def save(self, song: dict[str, Any]) -> dict[str, Any]:
        with self._lock:
            data = self._read()
            songs = data.setdefault("songs", [])
            song_id = str(song.get("id") or f"song-{int(time.time() * 1000)}")
            existing = next((item for item in songs if str(item.get("id")) == song_id), {})
            performance = self._clean_performance(song.get("performance")) if "performance" in song else existing.get("performance") or []
            sheet = str(song.get("sheet") if "sheet" in song else existing.get("sheet") or "")
            kind = "performance" if performance and not sheet.strip() else str(song.get("kind") or existing.get("kind") or "sheet")
            identifiers = self._merge_identifiers(existing.get("identifiers"), song.get("identifiers"))
            record = {
                **existing,
                "id": song_id,
                "title": str(song.get("title") or existing.get("title") or "Untitled").strip(),
                "artist": str(song.get("artist") or existing.get("artist") or "").strip(),
                "kind": kind,
                "sheet": sheet,
                "performance": performance,
                "duration_ms": int(song.get("duration_ms") or self._duration(performance) or existing.get("duration_ms") or 0),
                "source": str(song.get("source") or existing.get("source") or ("recorder" if performance else "manual")),
                "source_url": str(song.get("source_url") or existing.get("source_url") or ""),
                "timing_profile": str(song.get("timing_profile") or existing.get("timing_profile") or "expressive"),
                "transcription_diagnostics": song.get("transcription_diagnostics") if isinstance(song.get("transcription_diagnostics"), dict) else existing.get("transcription_diagnostics", {}),
                "identifiers": identifiers,
                "updated_at": time.time(),
            }
            for key, value in song.items():
                if key not in record and key not in {"identifiers"}:
                    record[key] = value
            record, _ = self._enrich_record(record)
            for index, current in enumerate(songs):
                if str(current.get("id")) == song_id:
                    songs[index] = record
                    break
            else:
                songs.append(record)
            self._write(data)
            return record

    def update_identifiers(self, song_id: str, identifiers: dict[str, Any]) -> dict[str, Any] | None:
        with self._lock:
            data = self._read()
            songs = data.get("songs", [])
            for index, current in enumerate(songs):
                if str(current.get("id")) != str(song_id):
                    continue
                merged = self._merge_identifiers(current.get("identifiers"), identifiers)
                updated = {**current, "identifiers": merged, "updated_at": time.time()}
                updated, _ = self._enrich_record(updated)
                songs[index] = updated
                data["songs"] = songs
                self._write(data)
                return updated
            return None

    def delete(self, song_id: str) -> bool:
        with self._lock:
            data = self._read()
            songs = data.get("songs", [])
            filtered = [song for song in songs if song.get("id") != song_id]
            changed = len(filtered) != len(songs)
            if changed:
                data["songs"] = filtered
                self._write(data)
            return changed

    @staticmethod
    def _clean_performance(raw: Any) -> list[dict[str, Any]]:
        return clean_performance(raw)

    @staticmethod
    def _duration(events: list[dict[str, Any]]) -> int:
        if not events:
            return 0
        return int(max(event["at_ms"] + event["duration_ms"] for event in events))

    @staticmethod
    def _clean_values(raw: Any) -> list[str]:
        values = raw if isinstance(raw, list) else str(raw or "").split(",")
        return list(dict.fromkeys(str(value).strip()[:80] for value in values if str(value).strip()))[:40]

    @classmethod
    def _merge_identifiers(cls, existing: Any, incoming: Any) -> dict[str, Any]:
        base = existing if isinstance(existing, dict) else {}
        patch = incoming if isinstance(incoming, dict) else {}
        custom_source = patch.get("custom") if "custom" in patch else base.get("custom", {})
        custom: dict[str, str] = {}
        if isinstance(custom_source, dict):
            for key, value in custom_source.items():
                clean_key = str(key).strip()[:80]
                if clean_key:
                    custom[clean_key] = str(value).strip()[:240]
        rating = patch.get("personal_rating", base.get("personal_rating"))
        try:
            rating = None if rating in (None, "") else max(0, min(5, round(float(rating), 2)))
        except (TypeError, ValueError):
            rating = None
        return {
            "genre": cls._clean_values(patch.get("genre", base.get("genre", []))),
            "tags": cls._clean_values(patch.get("tags", base.get("tags", []))),
            "author": str(patch.get("author", base.get("author", "")) or "").strip()[:180],
            "personal_rating": rating,
            "custom": custom,
        }

    def _enrich_record(self, record: dict[str, Any]) -> tuple[dict[str, Any], bool]:
        identifiers = self._merge_identifiers(record.get("identifiers"), None)
        automatic = self._automatic_identifiers(record)
        changed = identifiers != record.get("identifiers") or automatic != record.get("automatic_identifiers")
        enriched = {**record, "identifiers": identifiers, "automatic_identifiers": automatic}
        return enriched, changed

    def _automatic_identifiers(self, record: dict[str, Any]) -> dict[str, Any]:
        performance = record.get("performance") if isinstance(record.get("performance"), list) else []
        sheet = str(record.get("sheet") or "")
        event_count = len(performance)
        note_count = sum(max(1, len(str(event.get("key") or ""))) for event in performance)
        chord_count = sum(1 for event in performance if len(str(event.get("key") or "")) > 1)
        pauses = 0
        if sheet.strip():
            try:
                summary = summarize_sheet(sheet, str(record.get("timing_profile") or "expressive"))
                event_count = int(summary.get("events") or event_count)
                note_count = int(summary.get("notes") or note_count)
                chord_count = int(summary.get("chords") or chord_count)
                pauses = int(summary.get("pauses") or 0)
            except Exception:
                pass
        duration_ms = int(record.get("duration_ms") or self._duration(performance) or 0)
        minutes = max(duration_ms / 60000, 1e-6)
        density = round(event_count / minutes, 2) if event_count else 0.0
        source = str(record.get("source") or "")
        source_url = str(record.get("source_url") or "")
        host = urlparse(source_url).netloc.lower()
        diagnostics = record.get("transcription_diagnostics") if isinstance(record.get("transcription_diagnostics"), dict) else {}
        conversion_values = []
        for key in ("hifi_specialist_coverage", "hifi_basic_coverage", "hifi_worst_window_confidence"):
            try:
                value = float(diagnostics.get(key))
                if 0 <= value <= 1:
                    conversion_values.append(value)
            except (TypeError, ValueError):
                pass
        conversion_rating = round(sum(conversion_values) / len(conversion_values) * 5, 2) if conversion_values else None
        duration_bucket = "short" if duration_ms < 180000 else "medium" if duration_ms < 420000 else "long"
        density_bucket = "sparse" if density < 30 else "steady" if density < 120 else "dense"
        origin = "converted" if source_url and ("youtube" in source.lower() or "media" in source.lower() or "piano" in source.lower()) else "local"
        engine = str(record.get("transcription_engine") or diagnostics.get("transcription_engine") or "")
        quality = str(record.get("transcription_quality") or "")
        auto_tags = [
            f"origin:{origin}",
            f"kind:{record.get('kind') or 'sheet'}",
            f"length:{duration_bucket}",
            f"density:{density_bucket}",
        ]
        if engine:
            auto_tags.append(f"engine:{engine}")
        if quality:
            auto_tags.append(f"quality:{quality}")
        return {
            "author": str(record.get("artist") or identifiers_author(record) or "").strip(),
            "source": source,
            "source_host": host,
            "kind": str(record.get("kind") or "sheet"),
            "duration_ms": duration_ms,
            "event_count": event_count,
            "note_count": note_count,
            "chord_count": chord_count,
            "pause_count": pauses,
            "event_density_per_minute": density,
            "duration_bucket": duration_bucket,
            "density_bucket": density_bucket,
            "transcription_engine": engine,
            "transcription_quality": quality,
            "conversion_rating": conversion_rating,
            "updated_at": float(record.get("updated_at") or 0),
            "tags": auto_tags,
        }

    def _read(self) -> dict[str, Any]:
        try:
            return json.loads(self.path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            return {"songs": []}

    def _write(self, data: dict[str, Any]) -> None:
        temp = self.path.with_suffix(".tmp")
        temp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
        temp.replace(self.path)


def identifiers_author(record: dict[str, Any]) -> str:
    identifiers = record.get("identifiers")
    return str(identifiers.get("author") or "") if isinstance(identifiers, dict) else ""
