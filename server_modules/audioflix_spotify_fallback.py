"""Explicit Spotify localization fallback for Audioflix.

The normal Spotify matcher stays strict and remains the default. This module is reached only after
an explicit fallback action. Spotify supplies identity/metadata; independent catalog sources supply
the playable recording. The resolver searches YouTube/YouTube Music first, then a bounded SoundCloud
tier, while keeping duration, title, artist, and edition checks source-independent.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

from server_modules import audioflix_localize as localize
from server_modules import audioflix_spotify_match as spotify_match


# Historical name retained for API/state compatibility.
STRATEGY = "expanded-youtube-search"
SEARCH_RESULTS_PER_QUERY = 6
MAX_QUERY_VARIANTS = 3
FAST_QUERY_COUNT = 1
PRIMARY_CONFIRM_QUERY_COUNT = 2
FALLBACK_HYDRATE_LIMIT = 2
SOUNDCLOUD_RESULTS_PER_QUERY = 6
SOUNDCLOUD_MAX_QUERY_VARIANTS = 2
SOUNDCLOUD_HYDRATE_LIMIT = 3
DESCRIPTION_CREDIT_MAX_DELTA_SECONDS = 2.5
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
    """Identity tokens preserving non-Latin text plus accent-folded aliases."""
    normalized = spotify_match._normalize_search_query(str(value or ""))
    unicode_text = unicodedata.normalize("NFKC", normalized).casefold()
    ascii_text = unicodedata.normalize("NFKD", normalized).encode("ascii", "ignore").decode("ascii").lower()
    words = re.findall(r"[^\W_]+", unicode_text, flags=re.UNICODE)
    if ascii_text and ascii_text != unicode_text:
        words.extend(re.findall(r"[a-z0-9]+", ascii_text))
    return {word for word in words if word not in _NOISE_WORDS and len(word) > 1}


def _artist_tokens(value) -> set[str]:
    """Artist identity tokens plus a joined alias for spaced/CamelCase presentation differences."""
    normalized = spotify_match._normalize_search_query(str(value or ""))
    unicode_text = unicodedata.normalize("NFKC", normalized).casefold()
    ordered = [
        word for word in re.findall(r"[^\W_]+", unicode_text, flags=re.UNICODE)
        if word not in _NOISE_WORDS and len(word) > 1
    ]
    output = set(ordered)
    if 1 < len(ordered) <= 4:
        output.add("".join(ordered))
    ascii_text = unicodedata.normalize("NFKD", normalized).encode("ascii", "ignore").decode("ascii").lower()
    ascii_words = [
        word for word in re.findall(r"[a-z0-9]+", ascii_text)
        if word not in _NOISE_WORDS and len(word) > 1
    ]
    output.update(ascii_words)
    if 1 < len(ascii_words) <= 4:
        output.add("".join(ascii_words))
    return output


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


def _strip_search_credit_suffix(value: str) -> str:
    """Remove trailing producer-credit shorthand only from search aliases."""
    text = str(value or "").strip()
    return " ".join(re.sub(
        r"\s+\b(?:pr|prod|producer)\s*/\s*[^\s/|;]+\s*$",
        " ", text, flags=re.IGNORECASE,
    ).split()).strip()


def _title_token_variants(value) -> list[set[str]]:
    """Canonical title plus safe sub-title variants used only for identity comparison."""
    text = spotify_match._normalize_search_query(str(value or ""))
    variants: list[set[str]] = []

    def add(part: str):
        tokens = _tokens(part)
        if tokens and tokens not in variants:
            variants.append(tokens)

    add(text)
    clean = _strip_search_credit_suffix(text)
    if clean != text:
        add(clean)
    for part in re.split(r"\s*(?:/|\||;)\s*", text):
        if len(_tokens(part)) >= 2:
            add(part)
    without_parenthetical = re.sub(r"\([^)]*\)", " ", text)
    if len(_tokens(without_parenthetical)) >= 2:
        add(without_parenthetical)
    return variants


def _title_query_aliases(value) -> list[str]:
    """Search-only title aliases, with the cleanest useful form first."""
    raw = str(value or "").strip()
    normalized = spotify_match._normalize_search_query(raw)
    credit_stripped = _strip_search_credit_suffix(normalized)
    aliases: list[str] = []

    def add(part: str):
        clean = " ".join(str(part or "").split()).strip()
        key = clean.casefold()
        if clean and len(_tokens(clean)) >= 2 and all(existing.casefold() != key for existing in aliases):
            aliases.append(clean)

    add(credit_stripped)
    add(normalized)
    add(raw)
    for part in re.split(r"\s*(?:/|\||;)\s*", normalized):
        add(part)
    add(re.sub(r"\([^)]*\)", " ", normalized))
    return aliases[:4]


def query_variants(meta: dict) -> list[str]:
    """Bounded YouTube-family queries ordered from highest to lowest yield."""
    title = str(meta.get("title") or "").strip()
    artists = [str(v or "").strip() for v in (meta.get("artists") or []) if str(v or "").strip()]
    artist = artists[0] if artists else ""
    aliases = _title_query_aliases(title) or [title]
    raw: list[str] = []

    for alias in aliases:
        raw.append(" ".join(part for part in (artist, alias) if part))
    for alias in aliases[:1]:
        raw.append(" ".join(part for part in (f'"{alias}"', artist, "audio") if part))
    raw.append(" ".join(part for part in (artist, aliases[0], "Topic") if part))

    seen = set()
    output = []
    for query in raw:
        clean = " ".join(query.split()).strip()
        key = clean.casefold()
        if clean and key not in seen:
            seen.add(key)
            output.append(clean)
        if len(output) >= MAX_QUERY_VARIANTS:
            break
    return output


def soundcloud_query_variants(meta: dict) -> list[str]:
    """SoundCloud queries favor title-only discovery so reposts with unrelated uploaders are findable."""
    title = str(meta.get("title") or "").strip()
    artists = [str(v or "").strip() for v in (meta.get("artists") or []) if str(v or "").strip()]
    artist = artists[0] if artists else ""
    aliases = _title_query_aliases(title) or [title]
    raw: list[str] = []
    for alias in aliases:
        raw.append(alias)
        if artist:
            raw.append(f"{artist} {alias}")

    seen = set()
    output = []
    for query in raw:
        clean = " ".join(query.split()).strip()
        key = clean.casefold()
        if clean and key not in seen:
            seen.add(key)
            output.append(clean)
        if len(output) >= SOUNDCLOUD_MAX_QUERY_VARIANTS:
            break
    return output


def stored_track_metadata(track: dict) -> dict:
    """Use import-time Spotify identity when title, artist and duration are all present."""
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
    """Concrete source URL without converting non-YouTube IDs into YouTube IDs."""
    row = item if isinstance(item, dict) else {}
    if str(row.get("_source") or "").casefold() == "soundcloud":
        for key in ("webpage_url", "permalink_url", "original_url", "url"):
            clean = str(row.get(key) or "").strip()
            if clean.startswith(("http://", "https://")):
                return clean
        return ""
    return spotify_match._candidate_url(row)


def _candidate_identity_tokens(item: dict) -> set[str]:
    """Structured artist/uploader identity, intentionally excluding the free-form media title."""
    actual = set()
    for key in ("artist", "artists", "uploader", "uploader_id", "channel", "creator", "album_artist"):
        value = item.get(key)
        if isinstance(value, (list, tuple, set)):
            for part in value:
                actual |= _artist_tokens(part)
        else:
            actual |= _artist_tokens(value)
    return actual


def _title_artist_credit_tokens(value: str) -> set[str]:
    """Artist tokens only from explicit title-credit shapes such as ``Artist - Song`` or ``Song by Artist``."""
    text = spotify_match._normalize_search_query(str(value or "")).strip()
    if not text:
        return set()
    actual = set()

    # Leading ``Artist - Song`` / en-dash / em-dash notation.
    parts = re.split(r"\s+[-–—]\s+", text, maxsplit=1)
    if len(parts) == 2 and parts[0].strip():
        actual |= _artist_tokens(parts[0])

    # Trailing/in-title ``Song by Artist`` credit. Edition/noise words delimit the credited name.
    for match in re.finditer(
        r"\bby\s+(.+?)(?=\s+(?:clean|explicit|official|audio|video|lyrics?|visualizer|hd|hq)\b|$)",
        text,
        flags=re.IGNORECASE,
    ):
        actual |= _artist_tokens(match.group(1))
    return actual


def _soundcloud_credit_tokens(item: dict) -> set[str]:
    if str(item.get("_source") or "").casefold() != "soundcloud":
        return set()
    actual = set()
    for key in ("description", "fulltitle"):
        actual |= _artist_tokens(item.get(key))
    return actual


def rank_candidates(meta: dict, candidates) -> tuple[list[dict], list[dict], float]:
    """Verify candidate recording identity without source-specific song exceptions."""
    target = float(meta.get("duration_seconds") or 0)
    tolerance = _tolerance(target)
    title_variants = _title_token_variants(meta.get("title")) or [_tokens(meta.get("title"))]
    wanted_artists = set()
    for artist in meta.get("artists") or []:
        wanted_artists |= _artist_tokens(artist)
    wanted_edition = _has_marker(meta.get("title"), spotify_match.EDITION_MARKERS)

    accepted: list[dict] = []
    rejected: list[dict] = []
    for raw in candidates or []:
        item = raw if isinstance(raw, dict) else {}
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
        artist_evidence = "metadata" if artist_overlap > 0 else ""

        # Explicit media-title artist credits are valid identity evidence across providers, but only
        # after title identity and duration already pass their normal fallback gates.
        if wanted_artists and artist_overlap <= 0 and title_overlap >= 0.5:
            title_credit_overlap = _overlap(wanted_artists, _title_artist_credit_tokens(title))
            if title_credit_overlap > 0:
                artist_overlap = title_credit_overlap
                artist_evidence = "title-credit"

        # SoundCloud repost/archival accounts can differ from the original artist. Description/full
        # title credit is accepted only behind strong title identity and near-exact duration.
        if (
            wanted_artists and artist_overlap <= 0
            and entry["source"].casefold() == "soundcloud"
            and title_overlap >= 0.5
            and delta <= DESCRIPTION_CREDIT_MAX_DELTA_SECONDS
        ):
            credit_overlap = _overlap(wanted_artists, _soundcloud_credit_tokens(item))
            if credit_overlap > 0:
                artist_overlap = credit_overlap
                artist_evidence = "soundcloud-description"

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
            "artistEvidence": artist_evidence,
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
    """Bound YouTube + YouTube Music discovery and hydrate only top title-relevant rows."""
    import yt_dlp

    count = max(1, int(results or 1))
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": "in_playlist",
        "ignoreerrors": True,
        "playlistend": count,
    }
    wanted = _tokens(query)
    with yt_dlp.YoutubeDL(opts) as ydl:
        rows = spotify_match._collect_search_rows(ydl, query, count)
        rows.sort(key=lambda row: -_overlap(wanted, _tokens((row or {}).get("title"))))
        return spotify_match._hydrate_flat_rows(ydl, rows, limit=FALLBACK_HYDRATE_LIMIT)


def _hydrate_soundcloud_rows(ydl, rows, query: str, limit: int = SOUNDCLOUD_HYDRATE_LIMIT):
    """Hydrate only top SoundCloud search rows so repost description credits are available."""
    output = []
    wanted = _tokens(query)
    prepared = []
    for item in rows or []:
        if not isinstance(item, dict):
            continue
        row = dict(item)
        row["_source"] = "soundcloud"
        prepared.append(row)
    prepared.sort(key=lambda row: -_overlap(wanted, _tokens(row.get("title"))))

    probes = 0
    cap = max(0, int(limit or 0))
    detail_keys = (
        "id", "title", "duration", "view_count", "playback_count", "webpage_url", "permalink_url",
        "original_url", "url", "description", "fulltitle", "uploader", "uploader_id", "artist",
        "artists", "creator", "album_artist", "formats", "abr",
    )
    for row in prepared:
        url = _candidate_url(row)
        needs_detail = not row.get("description") or not isinstance(row.get("duration"), (int, float))
        if url and needs_detail and probes < cap:
            probes += 1
            try:
                detail = ydl.extract_info(url, download=False)
            except Exception:  # noqa: BLE001
                detail = None
            if isinstance(detail, dict):
                for key in detail_keys:
                    value = detail.get(key)
                    if value not in (None, "", []):
                        row[key] = value
                row["_source"] = "soundcloud"
        output.append(row)
    return output


def _soundcloud_search(query: str, results: int):
    """Flat SoundCloud discovery followed by bounded detail hydration for likely matches."""
    import yt_dlp

    count = max(1, min(int(results or 1), SOUNDCLOUD_RESULTS_PER_QUERY))
    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": "in_playlist",
        "ignoreerrors": True,
        "playlistend": count,
    }
    clean = spotify_match._normalize_search_query(query)
    with yt_dlp.YoutubeDL(opts) as ydl:
        found = ydl.extract_info(f"scsearch{count}:{clean}", download=False)
        rows = [row for row in ((found or {}).get("entries") or []) if isinstance(row, dict)]
        return _hydrate_soundcloud_rows(ydl, rows, clean)


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


def _decisive_match(entry: dict) -> bool:
    """Strong identity can safely stop the bounded search early."""
    if not isinstance(entry, dict):
        return False
    try:
        delta = float(entry.get("delta"))
    except (TypeError, ValueError):
        return False
    title_overlap = float(entry.get("titleOverlap") or 0)
    artist_overlap = float(entry.get("artistOverlap") or 0)

    # Explicit ``Artist - Song`` / ``Song by Artist`` credits are strong enough to use the normal
    # five-second fallback window without spending another network round trip.
    if (
        entry.get("artistEvidence") == "title-credit"
        and artist_overlap > 0
        and title_overlap >= 0.8
        and delta <= MIN_TOLERANCE_SECONDS
    ):
        return True
    if delta > 2.0:
        return False
    if artist_overlap > 0 and title_overlap >= 0.5:
        return True
    return not entry.get("partialTitle") and title_overlap >= 0.8


def _success_result(meta: dict, queries: list[str], accepted: list[dict], rejected: list[dict], tolerance: float) -> dict:
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


def find_fallback_match(url: str, searcher=None, opener=None, metadata: dict | None = None) -> dict:
    meta = metadata or spotify_match.fetch_track_metadata(url, opener=opener)
    if not meta.get("ok"):
        return {**meta, "strategy": STRATEGY}

    queries = query_variants(meta)
    if not queries:
        return {"ok": False, "strategy": STRATEGY, "message": "Spotify returned no searchable title or artist."}
    sc_queries = soundcloud_query_variants(meta) if searcher is None else []

    search = searcher or _search
    collected: list[dict] = []
    seen: set[str] = set()
    search_errors: list[str] = []
    accepted: list[dict] = []
    rejected: list[dict] = []
    tolerance = _tolerance(float(meta.get("duration_seconds") or 0))

    def run_one(search_fn, query: str, label: str = "") -> bool:
        nonlocal accepted, rejected, tolerance
        try:
            _append_candidates(collected, seen, search_fn(query, SEARCH_RESULTS_PER_QUERY) or [])
        except Exception as exc:  # noqa: BLE001
            search_errors.append(f"{label}{query}: {exc}")
            return False
        accepted, rejected, tolerance = rank_candidates(meta, collected)
        return bool(accepted and _decisive_match(accepted[0]))

    primary_index = 0
    if primary_index < len(queries):
        if run_one(search, queries[primary_index]):
            return _success_result(meta, queries, accepted, rejected, tolerance)
        primary_index += 1

    if accepted:
        if primary_index < min(PRIMARY_CONFIRM_QUERY_COUNT, len(queries)):
            if run_one(search, queries[primary_index]):
                return _success_result(meta, queries, accepted, rejected, tolerance)
            primary_index += 1
        return _success_result(meta, queries, accepted, rejected, tolerance)

    sc_index = 0
    if sc_queries:
        if run_one(_soundcloud_search, sc_queries[sc_index], "SoundCloud "):
            return _success_result(meta, queries, accepted, rejected, tolerance)
        sc_index += 1
        if accepted:
            return _success_result(meta, queries, accepted, rejected, tolerance)

    while primary_index < len(queries):
        if run_one(search, queries[primary_index]):
            return _success_result(meta, queries, accepted, rejected, tolerance)
        primary_index += 1
        if accepted:
            return _success_result(meta, queries, accepted, rejected, tolerance)

    while sc_index < len(sc_queries):
        if run_one(_soundcloud_search, sc_queries[sc_index], "SoundCloud "):
            return _success_result(meta, queries, accepted, rejected, tolerance)
        sc_index += 1
        if accepted:
            return _success_result(meta, queries, accepted, rejected, tolerance)

    detail = f" Searched {len(collected)} unique candidate(s) across {len(queries)} primary query variant(s)."
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
