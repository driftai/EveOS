"""Explicit Spotify localization fallback for Audioflix.

This module is intentionally separate from the normal Spotify matcher. The normal localizer stays
strict and remains the default. This fallback is only reached after an explicit user action from the
Audioflix UI (or a direct localhost API call).

Spotify is used for track identity/metadata only. No Spotify audio is decrypted, recorded, or
requested here. The fallback performs a broader independent-source search (currently YouTube through
yt-dlp), verifies title/artist/duration, then hands the selected recording to the existing Audioflix
download pipeline.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from server_modules import audioflix_localize as localize
from server_modules import audioflix_spotify_match as spotify_match


STRATEGY = "expanded-youtube-search"
SEARCH_RESULTS_PER_QUERY = 16
MIN_TOLERANCE_SECONDS = 5.0
MAX_TOLERANCE_SECONDS = 10.0
TOLERANCE_RATIO = 0.025

_NOISE_WORDS = {
    "official", "audio", "video", "music", "lyrics", "lyric", "visualizer", "hd", "hq",
    "explicit", "clean", "version", "track",
}


def _tokens(value) -> set[str]:
    text = unicodedata.normalize("NFKD", str(value or "")).encode("ascii", "ignore").decode("ascii")
    words = re.findall(r"[a-z0-9]+", text.lower())
    return {word for word in words if word not in _NOISE_WORDS and len(word) > 1}


def _has_marker(value: str, markers) -> bool:
    low = f" {str(value or '').lower()} "
    return any(marker in low for marker in markers)


def _overlap(wanted: set[str], actual: set[str]) -> float:
    if not wanted:
        return 0.0
    return len(wanted & actual) / float(len(wanted))


def _tolerance(target_seconds: float) -> float:
    if target_seconds <= 0:
        return MIN_TOLERANCE_SECONDS
    return max(MIN_TOLERANCE_SECONDS, min(MAX_TOLERANCE_SECONDS, target_seconds * TOLERANCE_RATIO))


def query_variants(meta: dict) -> list[str]:
    title = str(meta.get("title") or "").strip()
    artists = [str(value or "").strip() for value in (meta.get("artists") or []) if str(value or "").strip()]
    artist = artists[0] if artists else ""
    raw = [
        " ".join(part for part in (artist, title) if part),
        " ".join(part for part in (f'"{title}"' if title else "", artist, "audio") if part),
        " ".join(part for part in (artist, title, "Topic") if part),
        " ".join(part for part in (title, artist, "official audio") if part),
    ]
    seen = set()
    variants = []
    for query in raw:
        clean = " ".join(query.split()).strip()
        key = clean.lower()
        if clean and key not in seen:
            seen.add(key)
            variants.append(clean)
    return variants


def rank_candidates(meta: dict, candidates) -> tuple[list[dict], list[dict], float]:
    """Broader than the normal matcher, but still refuse weak identity guesses.

    The normal path uses a tight ~3 second duration gate. The fallback expands that to 5-10 seconds
    depending on track length, then requires title overlap plus artist/title corroboration. Different
    editions (live/remix/cover/etc.) stay rejected unless Spotify itself names that edition.
    """
    target = float(meta.get("duration_seconds") or 0)
    tolerance = _tolerance(target)
    wanted_title = _tokens(meta.get("title"))
    wanted_artists = set()
    for artist in meta.get("artists") or []:
        wanted_artists |= _tokens(artist)
    wanted_edition = _has_marker(meta.get("title"), spotify_match.EDITION_MARKERS)

    accepted = []
    rejected = []
    for item in candidates or []:
        item = item if isinstance(item, dict) else {}
        title = str(item.get("title") or "").strip()
        duration = item.get("duration")
        entry = {
            "id": str(item.get("id") or ""),
            "title": title,
            "duration": duration,
            "views": int(item.get("view_count") or 0),
            "url": str(item.get("webpage_url") or item.get("url") or ""),
        }
        if not title:
            entry["reason"] = "no title"
            rejected.append(entry)
            continue
        if _has_marker(title, spotify_match.BULK_MARKERS):
            entry["reason"] = "album/compilation upload"
            rejected.append(entry)
            continue
        if not wanted_edition and _has_marker(title, spotify_match.EDITION_MARKERS):
            entry["reason"] = "different edition (live/remix/etc)"
            rejected.append(entry)
            continue
        if not isinstance(duration, (int, float)) or duration <= 0:
            entry["reason"] = "unknown duration"
            rejected.append(entry)
            continue
        delta = abs(float(duration) - target) if target > 0 else 0.0
        if target > 0 and delta > tolerance:
            entry["reason"] = f"duration {duration}s vs {target:.1f}s"
            rejected.append(entry)
            continue

        actual = _tokens(title)
        title_overlap = _overlap(wanted_title, actual)
        artist_overlap = _overlap(wanted_artists, actual) if wanted_artists else 1.0
        # A fallback may accept noisier titles than the standard matcher, but it must still look like
        # the requested song. An artist match can rescue a moderately decorated title; otherwise the
        # title itself must be very strong.
        if title_overlap < 0.5:
            entry["reason"] = f"weak title overlap ({title_overlap:.2f})"
            rejected.append(entry)
            continue
        if wanted_artists and artist_overlap <= 0 and title_overlap < 0.8:
            entry["reason"] = "artist not corroborated"
            rejected.append(entry)
            continue

        abr = spotify_match.best_audio_abr(item)
        entry.update({
            "delta": round(delta, 3),
            "titleOverlap": round(title_overlap, 3),
            "artistOverlap": round(artist_overlap, 3),
            "abr": round(abr, 1),
            "quality": spotify_match.quality_tier(abr),
        })
        accepted.append(entry)

    accepted.sort(key=lambda entry: (
        0 if entry["delta"] <= 2.0 else 1,
        -entry["titleOverlap"],
        -entry["artistOverlap"],
        entry["quality"],
        -entry["views"],
        entry["delta"],
    ))
    return accepted, rejected, tolerance


def _search(query: str, results: int):
    return spotify_match._ytdlp_search(query, results)


def find_fallback_match(url: str, searcher=None, opener=None, metadata: dict | None = None) -> dict:
    meta = metadata or spotify_match.fetch_track_metadata(url, opener=opener)
    if not meta.get("ok"):
        return {**meta, "strategy": STRATEGY}

    queries = query_variants(meta)
    if not queries:
        return {"ok": False, "strategy": STRATEGY, "message": "Spotify returned no searchable title or artist."}

    search = searcher or _search
    collected = []
    seen = set()
    search_errors = []
    for query in queries:
        try:
            found = search(query, SEARCH_RESULTS_PER_QUERY) or []
        except Exception as exc:  # noqa: BLE001
            search_errors.append(f"{query}: {exc}")
            continue
        for item in found:
            if not isinstance(item, dict):
                continue
            key = str(item.get("id") or item.get("webpage_url") or item.get("url") or "").strip()
            if not key or key in seen:
                continue
            seen.add(key)
            collected.append(item)

    accepted, rejected, tolerance = rank_candidates(meta, collected)
    if not accepted:
        detail = f" Searched {len(collected)} unique candidate(s) across {len(queries)} query variants."
        if not collected and search_errors:
            detail += f" Search error: {search_errors[0][:180]}"
        return {
            "ok": False,
            "strategy": STRATEGY,
            "queries": queries,
            "spotify": meta,
            "rejected": rejected,
            "message": (
                f"Spotify fallback found no sufficiently strong match for {meta.get('title') or 'that track'} "
                f"within {tolerance:.1f}s.{detail}"
            ),
        }

    best = accepted[0]
    resolved_url = best.get("url") or (f"https://www.youtube.com/watch?v={best['id']}" if best.get("id") else "")
    if not resolved_url:
        return {"ok": False, "strategy": STRATEGY, "message": "Fallback match had no playable URL."}
    return {
        "ok": True,
        "strategy": STRATEGY,
        "queries": queries,
        "spotify": meta,
        "match": best,
        "alternatives": accepted[1:5],
        "rejected": rejected,
        "url": resolved_url,
        "toleranceSeconds": tolerance,
    }


def localize_one(payload: dict) -> dict:
    """Explicit fallback endpoint. It is never called by the standard localization endpoint."""
    track = payload.get("track") or {}
    tid = track.get("id")
    original_url = str(track.get("url") or "").strip()
    target_dir = localize._clean_path(payload.get("targetDir"))
    media_format = "video" if payload.get("mediaFormat") == "video" else "audio"

    if not spotify_match.spotify_track_id(original_url):
        return {
            "ok": False,
            "id": tid,
            "method": "spotify-fallback",
            "error": "Spotify fallback only accepts Spotify track URLs.",
        }

    resolved = find_fallback_match(original_url)
    if not resolved.get("ok"):
        return {
            "ok": False,
            "id": tid,
            "method": "spotify-fallback",
            "resolver": STRATEGY,
            "error": resolved.get("message") or "Spotify fallback could not resolve that track.",
        }

    path, err = localize._prepare_dir(target_dir)
    if err:
        return {**err, "id": tid, "method": "spotify-fallback", "resolver": STRATEGY}

    yt_dlp = localize._get_yt_dlp()
    if yt_dlp is None:
        return {
            "ok": False,
            "id": tid,
            "method": "spotify-fallback",
            "resolver": STRATEGY,
            "error": "yt-dlp is not installed on this system.",
        }

    spotify_meta = resolved.get("spotify") or {}
    title = spotify_meta.get("title") or track.get("title") or "track"
    resolved_url = str(resolved.get("url") or "").strip()
    outtmpl = str(path / (localize.safe_filename(title) + ".%(ext)s"))

    with localize._dl_lock:
        attempts = (False,) if media_format == "video" else (True, False)
        for want_mp3 in attempts:
            try:
                result = localize._download(yt_dlp, resolved_url, outtmpl, want_mp3, media_format)
                file_path = result.get("filepath")
                if file_path and Path(file_path).exists():
                    ext = Path(file_path).suffix.lstrip(".").lower()
                    return {
                        "ok": True,
                        "id": tid,
                        "filePath": str(file_path),
                        "ext": ext,
                        "mp3": ext == "mp3",
                        "mediaFormat": media_format,
                        "duration": result.get("duration") or 0,
                        "method": "spotify-fallback",
                        "resolver": STRATEGY,
                        "originalUrl": original_url,
                        "matchedUrl": resolved_url,
                        "matchedTitle": (resolved.get("match") or {}).get("title") or "",
                    }
            except Exception as exc:  # noqa: BLE001
                last = str(exc)[:300]
                if want_mp3 and ("ffmpeg" in last.lower() or "postprocess" in last.lower()):
                    continue
                return {
                    "ok": False,
                    "id": tid,
                    "method": "spotify-fallback",
                    "resolver": STRATEGY,
                    "error": last,
                }
    return {
        "ok": False,
        "id": tid,
        "method": "spotify-fallback",
        "resolver": STRATEGY,
        "error": "Fallback download produced no file.",
    }
