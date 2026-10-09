"""Identity and ranking helpers for the explicit Audioflix Spotify fallback."""

from __future__ import annotations

import re
import unicodedata

from server_modules import audioflix_spotify_match as spotify_match

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

NOISE_WORDS = {
    "official", "audio", "video", "music", "lyrics", "lyric", "visualizer", "hd", "hq",
    "explicit", "clean", "version", "track",
}
AUTH_REQUIRED_MARKERS = (
    "sign in to confirm your age", "sign in to confirm", "age-restricted", "age restricted",
    "age verification", "age_verification_required", "age_check_required", "login required",
    "members-only", "members only",
)


def tokens(value) -> set[str]:
    normalized = spotify_match._normalize_search_query(str(value or ""))
    unicode_text = unicodedata.normalize("NFKC", normalized).casefold()
    ascii_text = unicodedata.normalize("NFKD", normalized).encode("ascii", "ignore").decode("ascii").lower()
    words = re.findall(r"[^\W_]+", unicode_text, flags=re.UNICODE)
    if ascii_text and ascii_text != unicode_text:
        words.extend(re.findall(r"[a-z0-9]+", ascii_text))
    return {word for word in words if word not in NOISE_WORDS and len(word) > 1}


def artist_tokens(value) -> set[str]:
    normalized = spotify_match._normalize_search_query(str(value or ""))
    unicode_text = unicodedata.normalize("NFKC", normalized).casefold()
    ordered = [word for word in re.findall(r"[^\W_]+", unicode_text, flags=re.UNICODE)
               if word not in NOISE_WORDS and len(word) > 1]
    output = set(ordered)
    if 1 < len(ordered) <= 4:
        output.add("".join(ordered))
    ascii_text = unicodedata.normalize("NFKD", normalized).encode("ascii", "ignore").decode("ascii").lower()
    ascii_words = [word for word in re.findall(r"[a-z0-9]+", ascii_text)
                   if word not in NOISE_WORDS and len(word) > 1]
    output.update(ascii_words)
    if 1 < len(ascii_words) <= 4:
        output.add("".join(ascii_words))
    return output


def has_marker(value: str, markers) -> bool:
    low = f" {str(value or '').lower()} "
    return any(marker in low for marker in markers)


def overlap(wanted: set[str], actual: set[str]) -> float:
    return len(wanted & actual) / float(len(wanted)) if wanted else 0.0


def tolerance(target_seconds: float) -> float:
    if target_seconds <= 0:
        return MIN_TOLERANCE_SECONDS
    return max(MIN_TOLERANCE_SECONDS, min(MAX_TOLERANCE_SECONDS, target_seconds * TOLERANCE_RATIO))


def strip_search_credit_suffix(value: str) -> str:
    text = str(value or "").strip()
    return " ".join(re.sub(
        r"\s+\b(?:pr|prod|producer)\s*/\s*[^\s/|;]+\s*$",
        " ", text, flags=re.IGNORECASE,
    ).split()).strip()


def title_token_variants(value) -> list[set[str]]:
    text = spotify_match._normalize_search_query(str(value or ""))
    variants: list[set[str]] = []

    def add(part: str):
        found = tokens(part)
        if found and found not in variants:
            variants.append(found)

    add(text)
    clean = strip_search_credit_suffix(text)
    if clean != text:
        add(clean)
    for part in re.split(r"\s*(?:/|\||;)\s*", text):
        if len(tokens(part)) >= 2:
            add(part)
    without_parenthetical = re.sub(r"\([^)]*\)", " ", text)
    if len(tokens(without_parenthetical)) >= 2:
        add(without_parenthetical)
    return variants


def title_query_aliases(value) -> list[str]:
    raw = str(value or "").strip()
    normalized = spotify_match._normalize_search_query(raw)
    credit_stripped = strip_search_credit_suffix(normalized)
    aliases: list[str] = []

    def add(part: str):
        clean = " ".join(str(part or "").split()).strip()
        key = clean.casefold()
        if clean and len(tokens(clean)) >= 2 and all(existing.casefold() != key for existing in aliases):
            aliases.append(clean)

    add(credit_stripped)
    add(normalized)
    add(raw)
    for part in re.split(r"\s*(?:/|\||;)\s*", normalized):
        add(part)
    add(re.sub(r"\([^)]*\)", " ", normalized))
    return aliases[:4]


def query_variants(meta: dict) -> list[str]:
    title = str(meta.get("title") or "").strip()
    artists = [str(v or "").strip() for v in (meta.get("artists") or []) if str(v or "").strip()]
    artist = artists[0] if artists else ""
    aliases = title_query_aliases(title) or [title]
    raw: list[str] = []
    for alias in aliases:
        raw.append(" ".join(part for part in (artist, alias) if part))
    for alias in aliases[:1]:
        raw.append(" ".join(part for part in (f'"{alias}"', artist, "audio") if part))
    raw.append(" ".join(part for part in (artist, aliases[0], "Topic") if part))
    seen, output = set(), []
    for query in raw:
        clean = " ".join(query.split()).strip()
        key = clean.casefold()
        if clean and key not in seen:
            seen.add(key); output.append(clean)
        if len(output) >= MAX_QUERY_VARIANTS:
            break
    return output


def soundcloud_query_variants(meta: dict) -> list[str]:
    title = str(meta.get("title") or "").strip()
    artists = [str(v or "").strip() for v in (meta.get("artists") or []) if str(v or "").strip()]
    artist = artists[0] if artists else ""
    aliases = title_query_aliases(title) or [title]
    raw: list[str] = []
    for alias in aliases:
        raw.append(alias)
        if artist:
            raw.append(f"{artist} {alias}")
    seen, output = set(), []
    for query in raw:
        clean = " ".join(query.split()).strip()
        key = clean.casefold()
        if clean and key not in seen:
            seen.add(key); output.append(clean)
        if len(output) >= SOUNDCLOUD_MAX_QUERY_VARIANTS:
            break
    return output


def stored_track_metadata(track: dict) -> dict:
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
        "ok": True, "title": title, "artists": [artist], "duration_seconds": duration,
        "track_id": track_id, "metadata_source": "eveos-import",
    }
    isrc = str(item.get("isrc") or "").strip()
    if isrc:
        meta["isrc"] = isrc
    return meta


def candidate_url(item) -> str:
    row = item if isinstance(item, dict) else {}
    if str(row.get("_source") or "").casefold() == "soundcloud":
        for key in ("webpage_url", "permalink_url", "original_url", "url"):
            clean = str(row.get(key) or "").strip()
            if clean.startswith(("http://", "https://")):
                return clean
        return ""
    return spotify_match._candidate_url(row)


def candidate_identity_tokens(item: dict) -> set[str]:
    actual = set()
    for key in ("artist", "artists", "uploader", "uploader_id", "channel", "creator", "album_artist"):
        value = item.get(key)
        if isinstance(value, (list, tuple, set)):
            for part in value:
                actual |= artist_tokens(part)
        else:
            actual |= artist_tokens(value)
    return actual


def title_artist_credit_tokens(value: str) -> set[str]:
    text = spotify_match._normalize_search_query(str(value or "")).strip()
    if not text:
        return set()
    actual = set()
    parts = re.split(r"\s+[-–—]\s+", text, maxsplit=1)
    if len(parts) == 2 and parts[0].strip():
        actual |= artist_tokens(parts[0])
    for match in re.finditer(
        r"\bby\s+(.+?)(?=\s+(?:clean|explicit|official|audio|video|lyrics?|visualizer|hd|hq)\b|$)",
        text, flags=re.IGNORECASE,
    ):
        actual |= artist_tokens(match.group(1))
    return actual


def soundcloud_credit_tokens(item: dict) -> set[str]:
    if str(item.get("_source") or "").casefold() != "soundcloud":
        return set()
    actual = set()
    for key in ("description", "fulltitle"):
        actual |= artist_tokens(item.get(key))
    return actual


def rank_candidates(meta: dict, candidates) -> tuple[list[dict], list[dict], float]:
    target = float(meta.get("duration_seconds") or 0)
    allowed_delta = tolerance(target)
    title_variants = title_token_variants(meta.get("title")) or [tokens(meta.get("title"))]
    wanted_artists = set()
    for artist in meta.get("artists") or []:
        wanted_artists |= artist_tokens(artist)
    wanted_edition = has_marker(meta.get("title"), spotify_match.EDITION_MARKERS)
    accepted: list[dict] = []
    rejected: list[dict] = []
    for raw in candidates or []:
        item = raw if isinstance(raw, dict) else {}
        title = str(item.get("title") or "").strip()
        duration = item.get("duration")
        entry = {
            "id": str(item.get("id") or ""), "title": title, "duration": duration,
            "views": int(item.get("view_count") or item.get("playback_count") or 0),
            "url": candidate_url(item), "source": str(item.get("_source") or "youtube"),
        }
        if not title:
            entry["reason"] = "no title"; rejected.append(entry); continue
        if has_marker(title, spotify_match.BULK_MARKERS):
            entry["reason"] = "album/compilation upload"; rejected.append(entry); continue
        if not wanted_edition and has_marker(title, spotify_match.EDITION_MARKERS):
            entry["reason"] = "different edition (live/remix/etc)"; rejected.append(entry); continue
        if not isinstance(duration, (int, float)) or duration <= 0:
            entry["reason"] = "unknown duration"; rejected.append(entry); continue
        delta = abs(float(duration) - target) if target > 0 else 0.0
        if target > 0 and delta > allowed_delta:
            entry["reason"] = f"duration {duration}s vs {target:.1f}s"; rejected.append(entry); continue
        actual_title = tokens(title)
        overlaps = [overlap(variant, actual_title) for variant in title_variants]
        title_overlap = max(overlaps or [0.0])
        best_variant_index = overlaps.index(title_overlap) if overlaps else 0
        partial_title = best_variant_index > 0
        identity_tokens = candidate_identity_tokens(item)
        artist_overlap = overlap(wanted_artists, identity_tokens) if wanted_artists else 1.0
        artist_evidence = "metadata" if artist_overlap > 0 else ""
        if wanted_artists and artist_overlap <= 0 and title_overlap >= 0.5:
            title_credit_overlap = overlap(wanted_artists, title_artist_credit_tokens(title))
            if title_credit_overlap > 0:
                artist_overlap = title_credit_overlap; artist_evidence = "title-credit"
        if (wanted_artists and artist_overlap <= 0 and entry["source"].casefold() == "soundcloud"
                and title_overlap >= 0.5 and delta <= DESCRIPTION_CREDIT_MAX_DELTA_SECONDS):
            credit_overlap = overlap(wanted_artists, soundcloud_credit_tokens(item))
            if credit_overlap > 0:
                artist_overlap = credit_overlap; artist_evidence = "soundcloud-description"
        if title_overlap < 0.5:
            entry["reason"] = f"weak title overlap ({title_overlap:.2f})"; rejected.append(entry); continue
        if wanted_artists and artist_overlap <= 0 and (partial_title or title_overlap < 0.8):
            entry["reason"] = "artist not corroborated"; rejected.append(entry); continue
        if not entry["url"]:
            entry["reason"] = "candidate has no playable URL"; rejected.append(entry); continue
        abr = spotify_match.best_audio_abr(item)
        entry.update({
            "delta": round(delta, 3), "titleOverlap": round(title_overlap, 3),
            "artistOverlap": round(artist_overlap, 3), "artistEvidence": artist_evidence,
            "partialTitle": partial_title, "abr": round(abr, 1), "quality": spotify_match.quality_tier(abr),
        })
        accepted.append(entry)
    accepted.sort(key=lambda entry: (
        0 if entry["delta"] <= 2.0 else 1, 1 if entry["partialTitle"] else 0,
        -entry["titleOverlap"], -entry["artistOverlap"], entry["quality"], -entry["views"], entry["delta"],
    ))
    return accepted, rejected, allowed_delta
