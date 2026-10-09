"""Explicit Spotify localization fallback for Audioflix.

Identity/ranking lives in ``audioflix_spotify_fallback_match``; this module owns bounded discovery,
provider hydration, candidate attempts, and localization so the public fallback API stays unchanged.
"""

from __future__ import annotations

from pathlib import Path

from server_modules import audioflix_localize as localize
from server_modules import audioflix_spotify_match as spotify_match
from server_modules.audioflix_spotify_fallback_match import (
    STRATEGY, SEARCH_RESULTS_PER_QUERY, PRIMARY_CONFIRM_QUERY_COUNT, FALLBACK_HYDRATE_LIMIT,
    SOUNDCLOUD_RESULTS_PER_QUERY, SOUNDCLOUD_HYDRATE_LIMIT, MIN_TOLERANCE_SECONDS,
    MAX_DOWNLOAD_CANDIDATES, AUTH_REQUIRED_MARKERS, tokens, overlap, tolerance,
    query_variants, soundcloud_query_variants, stored_track_metadata, candidate_url, rank_candidates,
)

# Keep the historical private names available to existing focused smokes/importers.
_tokens = tokens
_overlap = overlap
_tolerance = tolerance
_candidate_url = candidate_url
_AUTH_REQUIRED_MARKERS = AUTH_REQUIRED_MARKERS


def _search(query: str, results: int):
    """Bound YouTube + YouTube Music discovery and hydrate only top title-relevant rows."""
    import yt_dlp

    count = max(1, int(results or 1))
    opts = {
        "quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True,
        "extract_flat": "in_playlist", "ignoreerrors": True, "playlistend": count,
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
        "quiet": True, "no_warnings": True, "skip_download": True, "noplaylist": True,
        "extract_flat": "in_playlist", "ignoreerrors": True, "playlistend": count,
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
    if not isinstance(entry, dict):
        return False
    try:
        delta = float(entry.get("delta"))
    except (TypeError, ValueError):
        return False
    title_overlap = float(entry.get("titleOverlap") or 0)
    artist_overlap = float(entry.get("artistOverlap") or 0)
    if (entry.get("artistEvidence") == "title-credit" and artist_overlap > 0
            and title_overlap >= 0.8 and delta <= MIN_TOLERANCE_SECONDS):
        return True
    if delta > 2.0:
        return False
    if artist_overlap > 0 and title_overlap >= 0.5:
        return True
    return not entry.get("partialTitle") and title_overlap >= 0.8


def _success_result(meta: dict, queries: list[str], accepted: list[dict], rejected: list[dict], allowed: float) -> dict:
    best = accepted[0]
    resolved_url = _candidate_url(best)
    if not resolved_url:
        return {"ok": False, "strategy": STRATEGY, "failureKind": "no_match", "message": "Fallback match had no playable URL."}
    return {
        "ok": True, "strategy": STRATEGY, "queries": queries, "spotify": meta, "match": best,
        "alternatives": accepted[1:5], "rejected": rejected, "url": resolved_url, "toleranceSeconds": allowed,
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
    allowed = _tolerance(float(meta.get("duration_seconds") or 0))

    def run_one(search_fn, query: str, label: str = "") -> bool:
        nonlocal accepted, rejected, allowed
        try:
            _append_candidates(collected, seen, search_fn(query, SEARCH_RESULTS_PER_QUERY) or [])
        except Exception as exc:  # noqa: BLE001
            search_errors.append(f"{label}{query}: {exc}")
            return False
        accepted, rejected, allowed = rank_candidates(meta, collected)
        return bool(accepted and _decisive_match(accepted[0]))

    primary_index = 0
    if primary_index < len(queries):
        if run_one(search, queries[primary_index]):
            return _success_result(meta, queries, accepted, rejected, allowed)
        primary_index += 1
    if accepted:
        if primary_index < min(PRIMARY_CONFIRM_QUERY_COUNT, len(queries)):
            if run_one(search, queries[primary_index]):
                return _success_result(meta, queries, accepted, rejected, allowed)
            primary_index += 1
        return _success_result(meta, queries, accepted, rejected, allowed)
    sc_index = 0
    if sc_queries:
        if run_one(_soundcloud_search, sc_queries[sc_index], "SoundCloud "):
            return _success_result(meta, queries, accepted, rejected, allowed)
        sc_index += 1
        if accepted:
            return _success_result(meta, queries, accepted, rejected, allowed)
    while primary_index < len(queries):
        if run_one(search, queries[primary_index]):
            return _success_result(meta, queries, accepted, rejected, allowed)
        primary_index += 1
        if accepted:
            return _success_result(meta, queries, accepted, rejected, allowed)
    while sc_index < len(sc_queries):
        if run_one(_soundcloud_search, sc_queries[sc_index], "SoundCloud "):
            return _success_result(meta, queries, accepted, rejected, allowed)
        sc_index += 1
        if accepted:
            return _success_result(meta, queries, accepted, rejected, allowed)
    detail = f" Searched {len(collected)} unique candidate(s) across {len(queries)} primary query variant(s)."
    if not collected and search_errors:
        detail += f" Search error: {search_errors[0][:180]}"
    return {
        "ok": False, "strategy": STRATEGY, "failureKind": "no_match", "queries": queries,
        "spotify": meta, "rejected": rejected,
        "message": f"Spotify fallback found no sufficiently strong match for {meta.get('title') or 'that track'} within {allowed:.1f}s.{detail}",
    }


def candidate_attempts(resolved: dict) -> list[dict]:
    rows = [resolved.get("match") or {}, *(resolved.get("alternatives") or [])]
    output, seen = [], set()
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
        "ok": False, "id": tid, "method": "spotify-fallback", "resolver": STRATEGY,
        "metadataSource": metadata_source, "failureKind": kind,
        "access": first.get("kind") or "download_error", "originalUrl": spotify_url,
        "matchedUrl": str(first.get("url") or ""), "matchedTitle": str(first.get("title") or ""),
        "attemptedCandidates": count, "candidateFailures": failures, "error": message,
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
        return {"ok": False, "id": tid, "method": "spotify-fallback", "failureKind": "invalid_source",
                "error": "Spotify fallback only accepts Spotify-linked tracks."}
    spotify_url = original_url if spotify_match.spotify_track_id(original_url) else f"https://open.spotify.com/track/{spotify_id}"
    stored_meta = stored_track_metadata(track)
    metadata_source = "eveos-import" if stored_meta else "spotify-live"
    resolved = find_fallback_match(spotify_url, metadata=stored_meta or None)
    if not resolved.get("ok"):
        return {
            "ok": False, "id": tid, "method": "spotify-fallback", "resolver": STRATEGY,
            "metadataSource": metadata_source, "failureKind": resolved.get("failureKind") or "no_match",
            "error": resolved.get("message") or "Spotify fallback could not resolve that track.",
        }
    path, err = localize._prepare_dir(target_dir)
    if err:
        return {**err, "id": tid, "method": "spotify-fallback", "resolver": STRATEGY, "metadataSource": metadata_source}
    yt_dlp = localize._get_yt_dlp()
    if yt_dlp is None:
        return {"ok": False, "id": tid, "method": "spotify-fallback", "resolver": STRATEGY,
                "metadataSource": metadata_source, "failureKind": "local_dependency_missing",
                "error": "yt-dlp is not installed on this system."}
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
                            "ok": True, "id": tid, "filePath": str(file_path), "ext": ext,
                            "mp3": ext == "mp3", "mediaFormat": media_format,
                            "duration": result.get("duration") or 0, "method": "spotify-fallback",
                            "resolver": STRATEGY, "metadataSource": metadata_source, "failureKind": "",
                            "originalUrl": spotify_url, "matchedUrl": resolved_url,
                            "matchedTitle": str(candidate.get("title") or ""), "attemptedCandidates": len(failures) + 1,
                        }
                    candidate_error = "Fallback download produced no file."
                except Exception as exc:  # noqa: BLE001
                    candidate_error = str(exc)[:500]
                    if want_mp3 and ("ffmpeg" in candidate_error.lower() or "postprocess" in candidate_error.lower()):
                        continue
                    break
            failures.append({
                "url": resolved_url, "title": str(candidate.get("title") or ""),
                "kind": classify_access_error(candidate_error), "error": candidate_error,
            })
    return _failure_after_candidates(tid, spotify_url, metadata_source, failures)
