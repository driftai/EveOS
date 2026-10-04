"""Explicit Spotify localization fallback for Audioflix.

This module is intentionally separate from the normal Spotify matcher. The normal localizer stays
strict and remains the default. This fallback is only reached after an explicit user action from the
Audioflix UI (or a direct localhost API call).

Spotify is used for track identity/metadata only. No Spotify audio is decrypted, recorded, or
requested here. The fallback performs broader independent-source search (YouTube, YouTube Music,
and a second-tier SoundCloud search), verifies title/artist/duration, then hands the selected
recording to the existing Audioflix yt-dlp download pipeline.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from server_modules import audioflix_localize as localize
from server_modules import audioflix_spotify_match as spotify_match


# Keep the historical resolver name for API/state compatibility even though the explicit fallback
# can now use SoundCloud after the YouTube-family search surfaces fail to produce a strong match.
STRATEGY = "expanded-youtube-search"
SEARCH_RESULTS_PER_QUERY = 12
MAX_QUERY_VARIANTS = 8
MIN_TOLERANCE_SECONDS = 5.0
MAX_TOLERANCE_SECONDS = 10.0
TOLERANCE_RATIO = 0.025
MAX_DOWNLOAD_CANDIDATES = 5

_NOISE_WORDS = {
    "official", "audio", "video", "music", "lyrics", "lyric", "visualizer", "hd", "hq",
    "explicit", "clean", "version", "track",
}
_AUTH_REQUIRED_MARKERS = (
    "sign in to confirm your age", "sign in to confirm", "age-restricted", "age restricted",
    "age verification", "age_verification_required", "age_check_required", "login required",
    "members-only", "members only",
)


def _tokens(value) -> set[str]:
    """Identity tokens that preserve non-Latin text while also matching accent-folded spellings."""
    normalized = spotify_match._normalize_search_query(str(value or ""))
    unicode_text = unicodedata.normalize("NFKC", normalized).casefold()
    ascii_text = unicodedata.normalize("NFKD", normalized).encode("ascii", "ignore").decode("ascii").lower()
    words = re.findall(r"[^\W_]+", unicode_text, flags=re.UNICODE)
    if ascii_text and ascii_text != unicode_text:
        words.extend(re.findall(r"[a-z0-9]+", ascii_text))
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


def _title_token_variants(value) -> list[set[str]]:
    """Canonical title plus safe sub-title variants for slash/pipe multi-part Spotify names."""
    text = spotify_match._normalize_search_query(str(value or ""))
    variants = []

    def add(part: str):
        tokens = _tokens(part)
        if tokens and tokens not in variants:
            variants.append(tokens)

    add(text)
    for part in re.split(r"\s*(?:/|\||;)\s*", text):
        if len(_tokens(part)) >= 2:
            add(part)
    without_parenthetical = re.sub(r"\([^)]*\)", " ", text)
    if len(_tokens(without_parenthetical)) >= 2:
        add(without_parenthetical)
    return variants


def _title_query_aliases(value) -> list[str]:
    """Search-only title aliases; canonical Spotify identity is never rewritten."""
    raw = str(value or "").strip()
    normalized = spotify_match._normalize_search_query(raw)
    aliases = []

    def add(part: str):
        clean = " ".join(str(part or "").split()).strip()
        key = clean.casefold()
        if clean and len(_tokens(clean)) >= 2 and all(existing.casefold() != key for existing in aliases):
            aliases.append(clean)

    add(raw)
    add(normalized)
    for part in re.split(r"\s*(?:/|\||;)\s*", normalized):
        add(part)
    add(re.sub(r"\([^)]*\)", " ", normalized))
    return aliases[:4]


def query_variants(meta: dict) -> list[str]:
    title = str(meta.get("title") or "").strip()
    artists = [str(value or "").strip() for value in (meta.get("artists") or []) if str(value or "").strip()]
    artist = artists[0] if artists else ""
    aliases = _title_query_aliases(title) or [title]
    raw = [
        " ".join(part for part in (artist, title) if part),
        " ".join(part for part in (f'"{title}"' if title else "", artist, "audio") if part),
        " ".join(part for part in (artist, title, "Topic") if part),
        " ".join(part for part in (title, artist, "official audio") if part),
    ]
    for alias in aliases:
        if alias != title:
            raw.append(" ".join(part for part in (artist, alias) if part))
            raw.append(" ".join(part for part in (f'"{alias}"', artist, "audio") if part))

    seen = set()
    variants = []
    for query in raw:
        clean = " ".join(query.split()).strip()
        key = clean.casefold()
        if clean and key not in seen:
            seen.add(key)
            variants.append(clean)
        if len(variants) >= MAX_QUERY_VARIANTS:
            break
    return variants


def stored_track_metadata(track: dict) -> dict:
    """Return import-time Spotify metadata only when it is strong enough for safe recovery.

    A removed Spotify track may stop returning an embed page later. Audioflix already persisted its
    title, artist and exact playlist duration at import time, so retain that identity instead of
    throwing it away and making recovery depend on the now-dead Spotify page. Duration remains
    mandatory: without it the fallback would become materially looser than the existing matcher.
    """
    item = track if isinstance(track, dict) else {}
    title = str(item.get("title") or "").strip()
    artist = str(item.get("artist") or "").strip()
    try:
        duration = float(item.get("duration") or 0)
    except (TypeError, ValueError):
        duration = 0.0
    if not title or not artist or duration <= 0:
        return {}

    track_id = str(item.get("spotifyTrackId") or "").strip()
    if not track_id:
        track_id = spotify_match.spotify_track_id(str(item.get("url") or ""))
    meta = {
        "ok": True,
        "title": title,
        "artists": [artist],
        "duration_seconds": duration,
        "track_id": track_id,
        "metadata_source": "eveos-import",
    }
    isrc = str(item.get("isrc") or "").strip()
    if isrc:
        meta["isrc"] = isrc
    return meta


def _candidate_url(item) -> str:
    """Concrete media URL without ever turning a non-YouTube extractor id into a YouTube id."""
    row = item if isinstance(item, dict) else {}
    source = str(row.get("_source") or "").casefold()
    if source == "soundcloud":
        for key in ("webpage_url", "permalink_url", "original_url", "url"):
            clean = str(row.get(key) or "").strip()
            if clean.startswith(("http://", "https://")):
                return clean
        return ""
    return spotify_match._candidate_url(row)


def _candidate_identity_tokens(item: dict) -> set[str]:
    actual = set()
    for key in ("title", "artist", "artists", "uploader", "uploader_id", "channel", "creator", "album_artist"):
        value = item.get(key)
        if isinstance(value, (list, tuple, set)):
            for part in value:
                actual |= _tokens(part)
        else:
            actual |= _tokens(value)
    return actual


def rank_candidates(meta: dict, candidates) -> tuple[list[dict], list[dict], float]:
    """Broader than the normal matcher, but still refuse weak identity guesses.

    Multi-part Spotify titles can match one of their named segments, but a partial-segment match is
    accepted only when artist/uploader metadata independently corroborates the Spotify artist.
    Duration and edition gates remain mandatory for every source.
    """
    target = float(meta.get("duration_seconds") or 0)
    tolerance = _tolerance(target)
    title_variants = _title_token_variants(meta.get("title")) or [_tokens(meta.get("title"))]
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
            "views": int(item.get("view_count") or item.get("playback_count") or 0),
            "url": _candidate_url(item),
            "source": str(item.get("_source") or "youtube"),
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

        actual_title = _tokens(title)
        overlaps = [_overlap(variant, actual_title) for variant in title_variants]
        title_overlap = max(overlaps or [0.0])
        best_variant_index = overlaps.index(title_overlap) if overlaps else 0
        partial_title = best_variant_index > 0
        identity_tokens = _candidate_identity_tokens(item)
        artist_overlap = _overlap(wanted_artists, identity_tokens) if wanted_artists else 1.0
        if title_overlap < 0.5:
            entry["reason"] = f"weak title overlap ({title_overlap:.2f})"
            rejected.append(entry)
            continue
        if wanted_artists and artist_overlap <= 0 and (partial_title or title_overlap < 0.8):
            entry["reason"] = "artist not corroborated"
            rejected.append(entry)
            continue
        if not entry["url"]:
            entry["reason"] = "candidate has no playable URL"
            rejected.append(entry)
            continue

        abr = spotify_match.best_audio_abr(item)
        entry.update({
            "delta": round(delta, 3),
            "titleOverlap": round(title_overlap, 3),
            "artistOverlap": round(artist_overlap, 3),
            "partialTitle": partial_title,
            "abr": round(abr, 1),
            "quality": spotify_match.quality_tier(abr),
        })
        accepted.append(entry)

    accepted.sort(key=lambda entry: (
        0 if entry["delta"] <= 2.0 else 1,
        1 if entry["partialTitle"] else 0,
        -entry["titleOverlap"],
        -entry["artistOverlap"],
        entry["quality"],
        -entry["views"],
        entry["delta"],
    ))
    return accepted, rejected, tolerance


def _search(query: str, results: int):
    return spotify_match._ytdlp_search(query, results)


def _soundcloud_search(query: str, results: int):
    """Fallback-only SoundCloud catalog search with complete metadata and bounded results."""
    import yt_dlp

    count = max(1, int(results or 1))
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "ignoreerrors": True,
        "playlistend": count,
    }
    clean = spotify_match._normalize_search_query(query)
    with yt_dlp.YoutubeDL(opts) as ydl:
        found = ydl.extract_info(f"scsearch{count}:{clean}", download=False)
    rows = []
    for item in ((found or {}).get("entries") or []):
        if not isinstance(item, dict):
            continue
        row = dict(item)
        row["_source"] = "soundcloud"
        rows.append(row)
    return rows[:count]


def _candidate_key(item: dict) -> str:
    url = _candidate_url(item)
    if url:
        return url.casefold()
    source = str(item.get("_source") or "youtube").casefold()
    ident = str(item.get("id") or "").strip()
    return f"{source}:{ident}" if ident else ""


def _append_candidates(collected: list[dict], seen: set[str], found) -> None:
    for item in found or []:
        if not isinstance(item, dict):
            continue
        key = _candidate_key(item)
        if not key or key in seen:
            continue
        seen.add(key)
        collected.append(item)


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
            _append_candidates(collected, seen, search(query, SEARCH_RESULTS_PER_QUERY) or [])
        except Exception as exc:  # noqa: BLE001
            search_errors.append(f"{query}: {exc}")

    accepted, rejected, tolerance = rank_candidates(meta, collected)

    # Only pay the cost of a second provider when the YouTube-family catalog surfaces did not yield
    # a verified recording. Custom test/search injectors remain deterministic and never trigger I/O.
    if not accepted and searcher is None:
        for query in queries:
            try:
                _append_candidates(collected, seen, _soundcloud_search(query, SEARCH_RESULTS_PER_QUERY))
            except Exception as exc:  # noqa: BLE001
                search_errors.append(f"SoundCloud {query}: {exc}")
        accepted, rejected, tolerance = rank_candidates(meta, collected)

    if not accepted:
        detail = f" Searched {len(collected)} unique candidate(s) across {len(queries)} query variants."
        if not collected and search_errors:
            detail += f" Search error: {search_errors[0][:180]}"
        return {
            "ok": False,
            "strategy": STRATEGY,
            "failureKind": "no_match",
            "queries": queries,
            "spotify": meta,
            "rejected": rejected,
            "message": (
                f"Spotify fallback found no sufficiently strong match for {meta.get('title') or 'that track'} "
                f"within {tolerance:.1f}s.{detail}"
            ),
        }

    best = accepted[0]
    resolved_url = _candidate_url(best)
    if not resolved_url:
        return {"ok": False, "strategy": STRATEGY, "failureKind": "no_match", "message": "Fallback match had no playable URL."}
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


def candidate_attempts(resolved: dict) -> list[dict]:
    """Ordered strong matches to try, deduplicated by concrete media URL."""
    rows = [resolved.get("match") or {}, *(resolved.get("alternatives") or [])]
    output = []
    seen = set()
    for row in rows:
        if not isinstance(row, dict):
            continue
        url = _candidate_url(row)
        if not url or url in seen:
            continue
        seen.add(url)
        output.append({**row, "url": url})
        if len(output) >= MAX_DOWNLOAD_CANDIDATES:
            break
    if not output:
        url = str(resolved.get("url") or "").strip()
        if url:
            output.append({"url": url, "title": str((resolved.get("match") or {}).get("title") or "")})
    return output


def classify_access_error(message: str) -> str:
    low = str(message or "").lower()
    if any(marker in low for marker in _AUTH_REQUIRED_MARKERS):
        return "auth_required"
    if any(marker in low for marker in ("private video", "video unavailable", "not available in your country", "geo restricted")):
        return "unavailable"
    return "download_error"


def _failure_after_candidates(tid, spotify_url, metadata_source, failures: list[dict]) -> dict:
    auth = next((entry for entry in failures if entry.get("kind") == "auth_required"), None)
    first = auth or (failures[0] if failures else {})
    count = len(failures)
    if auth:
        message = (
            f"Strong source match found ({auth.get('title') or auth.get('url') or 'candidate'}), but the source requires "
            f"sign-in/age verification. EveOS kept that candidate and tried {count} strong match"
            f"{'es' if count != 1 else ''}; none were accessible without authentication."
        )
        kind = "match_found_but_inaccessible"
    else:
        detail = str(first.get("error") or "Fallback download produced no file.")
        message = f"Strong match found, but localization failed after trying {count} candidate{'s' if count != 1 else ''}: {detail}"
        kind = "match_found_but_download_failed"
    return {
        "ok": False,
        "id": tid,
        "method": "spotify-fallback",
        "resolver": STRATEGY,
        "metadataSource": metadata_source,
        "failureKind": kind,
        "access": first.get("kind") or "download_error",
        "originalUrl": spotify_url,
        "matchedUrl": str(first.get("url") or ""),
        "matchedTitle": str(first.get("title") or ""),
        "attemptedCandidates": count,
        "candidateFailures": failures,
        "error": message,
    }


def localize_one(payload: dict) -> dict:
    """Explicit fallback endpoint. It is never called by the standard localization endpoint."""
    track = payload.get("track") or {}
    tid = track.get("id")
    original_url = str(track.get("url") or "").strip()
    spotify_id = str(track.get("spotifyTrackId") or "").strip() or spotify_match.spotify_track_id(original_url)
    target_dir = localize._clean_path(payload.get("targetDir"))
    media_format = "video" if payload.get("mediaFormat") == "video" else "audio"

    if not spotify_id:
        return {
            "ok": False,
            "id": tid,
            "method": "spotify-fallback",
            "failureKind": "invalid_source",
            "error": "Spotify fallback only accepts Spotify-linked tracks.",
        }

    spotify_url = original_url if spotify_match.spotify_track_id(original_url) else f"https://open.spotify.com/track/{spotify_id}"
    stored_meta = stored_track_metadata(track)
    metadata_source = "eveos-import" if stored_meta else "spotify-live"
    resolved = find_fallback_match(spotify_url, metadata=stored_meta or None)
    if not resolved.get("ok"):
        return {
            "ok": False,
            "id": tid,
            "method": "spotify-fallback",
            "resolver": STRATEGY,
            "metadataSource": metadata_source,
            "failureKind": resolved.get("failureKind") or "no_match",
            "error": resolved.get("message") or "Spotify fallback could not resolve that track.",
        }

    path, err = localize._prepare_dir(target_dir)
    if err:
        return {**err, "id": tid, "method": "spotify-fallback", "resolver": STRATEGY, "metadataSource": metadata_source}

    yt_dlp = localize._get_yt_dlp()
    if yt_dlp is None:
        return {
            "ok": False,
            "id": tid,
            "method": "spotify-fallback",
            "resolver": STRATEGY,
            "metadataSource": metadata_source,
            "failureKind": "local_dependency_missing",
            "error": "yt-dlp is not installed on this system.",
        }

    spotify_meta = resolved.get("spotify") or {}
    title = spotify_meta.get("title") or track.get("title") or "track"
    outtmpl = str(path / (localize.safe_filename(title) + ".%(ext)s"))
    candidates = candidate_attempts(resolved)
    failures = []

    with localize._dl_lock:
        for candidate in candidates:
            resolved_url = str(candidate.get("url") or "").strip()
            if not resolved_url:
                continue
            candidate_error = "Fallback download produced no file."
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
                            "metadataSource": metadata_source,
                            "failureKind": "",
                            "originalUrl": spotify_url,
                            "matchedUrl": resolved_url,
                            "matchedTitle": str(candidate.get("title") or ""),
                            "attemptedCandidates": len(failures) + 1,
                        }
                    candidate_error = "Fallback download produced no file."
                except Exception as exc:  # noqa: BLE001
                    candidate_error = str(exc)[:500]
                    if want_mp3 and ("ffmpeg" in candidate_error.lower() or "postprocess" in candidate_error.lower()):
                        continue
                    break
            failures.append({
                "url": resolved_url,
                "title": str(candidate.get("title") or ""),
                "kind": classify_access_error(candidate_error),
                "error": candidate_error,
            })

    return _failure_after_candidates(tid, spotify_url, metadata_source, failures)
