"""Resolve a Spotify track link to the YouTube video that holds the same recording.

Spotify's own audio is Widevine-encrypted and is NOT obtainable; the only Spotify bytes served in
the clear are the 30-second preview. So "localize a Spotify song" means: read the track's metadata
from Spotify, find the matching recording on YouTube, and localize THAT with the existing yt-dlp
pipeline. This module is only the matching half.

No Spotify API credentials are needed. https://open.spotify.com/embed/track/<id> returns a public
page whose embedded JSON carries the fields that matter, verified against a live track:

    "name": "Never Gonna Give You Up"
    "artists": [{"name": "Rick Astley"}]
    "duration": 213573          # milliseconds, exact

Note it does NOT include the ISRC, so matching leans on title + artist + that exact duration.

Duration is the discriminator that does the real work. Searching the example above returns the
official video (213s), two remasters (212-214s) and a live performance (234s). A tolerance gate drops
the live take outright; audio quality and then view count only break ties BETWEEN plausible
candidates, never acting as the primary signal — on its own, popularity happily picks a remix or a
lyric video with more plays than the original.

Note the winner is not required to be the "official" upload. For Lauren Aquilina's "King" the pick
is a 204M-view upload titled with a lyric rather than the song name, over the artist-titled lyric
video at 12.8M. Both are the same recording at the same bitrate, so the one the world actually plays
is the better default.
"""

from __future__ import annotations

import json
import re
import urllib.request

EMBED_URL = "https://open.spotify.com/embed/track/{track_id}"
# A browser UA: the embed page varies its payload for unknown clients.
_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36"
_TIMEOUT = 20

# Editions that are a DIFFERENT recording of the same song. Allowed only when the Spotify title says
# so too, otherwise a search for a studio track must not settle for a live or sped-up upload.
EDITION_MARKERS = (
    "live", "remix", "cover", "karaoke", "instrumental", "acoustic", "acapella", "a cappella",
    "sped up", "spedup", "slowed", "reverb", "nightcore", "8d", "bass boosted", "mashup",
    "tribute", "rehearsal", "demo", "concert", "session", "medley",
)
# Uploads that are not a single track at all.
BULK_MARKERS = ("full album", "greatest hits", "playlist", "mix ", " mix", "compilation", "hour",
                "hours", "megamix", "non stop", "nonstop", "all songs")

DEFAULT_TOLERANCE_SECONDS = 3.0
# YouTube reports whole seconds while Spotify gives milliseconds, so any delta under this is pure
# rounding noise and says nothing about which candidate is the better recording. Treat everything
# inside it as equally plausible and let view count decide — otherwise 0.15s of noise outranks a
# 156x popularity difference, which is how the official video loses to a remaster.
DURATION_NOISE_SECONDS = 1.5
DEFAULT_SEARCH_RESULTS = 8
# Flat YouTube search is deliberately used so one age-gated result cannot abort discovery. Some
# search rows omit duration, though, and duration is our main identity gate. Hydrate only a bounded
# number of those rows individually; a gated/broken video is caught per-row instead of poisoning the
# whole search, while common results keep the fast flat path.
SEARCH_HYDRATE_LIMIT = 6

# Prefer the better-sounding upload, but only when "better" is real. YouTube re-encodes everything
# onto its own ladder, so the top audio stream is ~130-160 kbps for essentially any modern upload:
# three uploads of one song measured 137.5 / 140.3 / 140.9 kbps. That spread is encoder noise, and
# ranking on the number itself would hand the win to whoever landed 0.6 kbps higher — the same shape
# of bug as ranking on duration precision. So quality is graded in coarse tiers. It only ever demotes
# an upload that is audibly worse (an old AAC-only rip, a phone recording), and inside one tier
# popularity still decides.
GOOD_AUDIO_KBPS = 128.0
POOR_AUDIO_KBPS = 96.0


def spotify_track_id(url: str) -> str:
    """Extract the track id from any open.spotify.com/track/... or spotify:track:... form."""
    text = str(url or "").strip()
    match = re.search(r"(?:track[/:])([A-Za-z0-9]{22})", text)
    return match.group(1) if match else ""


def _first(payload, *keys):
    """Walk nested dict/list payloads for the first occurrence of any key."""
    stack = [payload]
    while stack:
        node = stack.pop(0)
        if isinstance(node, dict):
            for key in keys:
                if key in node:
                    return node[key]
            stack.extend(node.values())
        elif isinstance(node, list):
            stack.extend(node)
    return None


def parse_embed_html(html: str) -> dict:
    """Pull name / artists / duration_ms / preview out of an embed page's JSON blobs.

    Kept separate from the fetch so it is testable against a captured fixture without network.
    """
    best = {}
    for blob in re.findall(r'<script[^>]*type="application/json"[^>]*>(.*?)</script>', html or "",
                           re.DOTALL):
        try:
            data = json.loads(blob)
        except Exception:  # noqa: BLE001
            continue
        name = _first(data, "name", "title")
        duration = _first(data, "duration", "duration_ms", "durationMs")
        artists = _first(data, "artists")
        preview = _first(data, "audioPreview")
        if isinstance(name, str) and name.strip() and not best.get("title"):
            best["title"] = name.strip()
        if isinstance(duration, (int, float)) and duration > 0 and not best.get("duration_ms"):
            best["duration_ms"] = int(duration)
        if isinstance(artists, list) and artists and not best.get("artists"):
            names = [a.get("name") for a in artists if isinstance(a, dict) and a.get("name")]
            if names:
                best["artists"] = names
        if isinstance(preview, dict) and preview.get("url") and not best.get("preview_url"):
            best["preview_url"] = preview["url"]
    return best


def fetch_track_metadata(url: str, opener=None) -> dict:
    """Public metadata for a Spotify track. No API key, no login."""
    track_id = spotify_track_id(url)
    if not track_id:
        return {"ok": False, "message": "That does not look like a Spotify track link."}
    request = urllib.request.Request(EMBED_URL.format(track_id=track_id),
                                     headers={"User-Agent": _UA})
    try:
        read = opener or (lambda req: urllib.request.urlopen(req, timeout=_TIMEOUT).read())
        html = read(request)
        if isinstance(html, bytes):
            html = html.decode("utf-8", errors="replace")
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": f"Could not read the Spotify track page: {exc}"}

    meta = parse_embed_html(html)
    if not meta.get("title"):
        return {"ok": False, "message": "Spotify did not return a track title for that link."}
    meta.update({"ok": True, "track_id": track_id,
                 "duration_seconds": (meta.get("duration_ms") or 0) / 1000.0})
    return meta


def _has(text: str, markers) -> bool:
    low = f" {str(text or '').lower()} "
    return any(marker in low for marker in markers)


def _candidate_url(item) -> str:
    """Return a concrete watch URL even when yt-dlp flat search leaves only an id."""
    row = item if isinstance(item, dict) else {}
    for value in (row.get("webpage_url"), row.get("url")):
        clean = str(value or "").strip()
        if clean.startswith(("http://", "https://")):
            return clean
    video_id = str(row.get("id") or "").strip()
    return f"https://www.youtube.com/watch?v={video_id}" if video_id else ""


def _hydrate_flat_rows(ydl, entries, limit: int = SEARCH_HYDRATE_LIMIT):
    """Fill missing duration/details without letting one inaccessible result abort the search."""
    output = []
    probes = 0
    cap = max(0, int(limit or 0))
    for entry in entries or []:
        if not isinstance(entry, dict):
            continue
        row = dict(entry)
        duration = row.get("duration")
        if isinstance(duration, (int, float)) and duration > 0:
            output.append(row)
            continue
        url = _candidate_url(row)
        if not url or probes >= cap:
            output.append(row)
            continue
        probes += 1
        try:
            detail = ydl.extract_info(url, download=False)
        except Exception:  # noqa: BLE001
            detail = None
        if isinstance(detail, dict):
            for key in ("id", "title", "duration", "view_count", "webpage_url", "formats", "abr"):
                value = detail.get(key)
                if value not in (None, "", []):
                    row[key] = value
        output.append(row)
    return output


def best_audio_abr(item) -> float:
    """Highest audio-only bitrate yt-dlp lists for a candidate, or 0.0 when it reports none.

    Search results already carry `formats`, so reading this costs no extra request. Flat search rows
    intentionally have no formats; unknown quality stays neutral and is checked during download.
    """
    best = 0.0
    for fmt in ((item or {}).get("formats") or []):
        if not isinstance(fmt, dict) or fmt.get("vcodec") != "none":
            continue
        if fmt.get("acodec") in (None, "none"):
            continue
        try:
            best = max(best, float(fmt.get("abr") or 0))
        except (TypeError, ValueError):
            continue
    if best <= 0:
        try:
            best = float((item or {}).get("abr") or 0)
        except (TypeError, ValueError):
            best = 0.0
    return best


def quality_tier(abr: float) -> int:
    """0 = normal YouTube audio, 1 = noticeably compressed, 2 = poor.

    An unknown bitrate deliberately scores as normal: yt-dlp does not always report one, and
    demoting a candidate over missing metadata would reorder the pick on a data gap rather than on
    how it sounds. Falling through to popularity is the behaviour that has been choosing correctly.
    """
    if abr <= 0 or abr >= GOOD_AUDIO_KBPS:
        return 0
    return 1 if abr >= POOR_AUDIO_KBPS else 2


def search_query(meta: dict) -> str:
    artist = (meta.get("artists") or [""])[0]
    return " ".join(part for part in (artist, meta.get("title")) if part).strip()


def rank_candidates(meta: dict, candidates, tolerance_seconds: float = DEFAULT_TOLERANCE_SECONDS):
    """Score YouTube results against the Spotify track. Returns (accepted, rejected).

    Order of operations matters: reject on identity first, and only then let popularity break a tie.
    Sorting by views before filtering is what picks the wrong recording.
    """
    target = float(meta.get("duration_seconds") or 0)
    wanted_edition = _has(meta.get("title"), EDITION_MARKERS)
    accepted, rejected = [], []

    for item in candidates or []:
        title = str((item or {}).get("title") or "")
        duration = (item or {}).get("duration")
        views = int((item or {}).get("view_count") or 0)
        entry = {"title": title, "duration": duration, "views": views,
                 "url": _candidate_url(item), "id": (item or {}).get("id") or ""}

        if not entry["title"]:
            entry["reason"] = "no title"
            rejected.append(entry)
            continue
        if not isinstance(duration, (int, float)) or duration <= 0:
            entry["reason"] = "unknown duration"
            rejected.append(entry)
            continue
        if target > 0 and abs(float(duration) - target) > tolerance_seconds:
            entry["reason"] = f"duration {duration}s vs {target:.1f}s"
            rejected.append(entry)
            continue
        if _has(title, BULK_MARKERS):
            entry["reason"] = "album/compilation upload"
            rejected.append(entry)
            continue
        # A different edition is only acceptable if that is what was asked for.
        if not wanted_edition and _has(title, EDITION_MARKERS):
            entry["reason"] = "different edition (live/remix/etc)"
            rejected.append(entry)
            continue
        entry["delta"] = round(abs(float(duration) - target), 3)
        entry["abr"] = round(best_audio_abr(item), 1)
        entry["quality"] = quality_tier(entry["abr"])
        accepted.append(entry)

    # Three keys, each only breaking ties left by the one before it:
    #   1. is the duration difference meaningful at all (identity)
    #   2. is the audio audibly worse (fidelity, in coarse tiers)
    #   3. how many people played it (which upload the world treats as the one)
    # Identity leads because a pristine rip of the wrong recording is still the wrong recording.
    accepted.sort(key=lambda e: (0 if e["delta"] <= DURATION_NOISE_SECONDS else 1,
                                 e["quality"], -e["views"]))
    return accepted, rejected


def find_youtube_match(url: str, searcher=None, opener=None,
                       tolerance_seconds: float = DEFAULT_TOLERANCE_SECONDS,
                       results: int = DEFAULT_SEARCH_RESULTS) -> dict:
    """Spotify link -> the best-matching YouTube video, or a reason why none qualified."""
    meta = fetch_track_metadata(url, opener=opener)
    if not meta.get("ok"):
        return meta

    query = search_query(meta)
    if not query:
        return {"ok": False, "message": "Spotify returned no title or artist to search with."}

    try:
        candidates = (searcher or _ytdlp_search)(query, results)
    except Exception as exc:  # noqa: BLE001
        return {"ok": False, "message": f"YouTube search failed: {exc}", "query": query}

    accepted, rejected = rank_candidates(meta, candidates, tolerance_seconds)
    if not accepted:
        return {"ok": False, "query": query, "spotify": meta, "rejected": rejected,
                "message": (f"No YouTube result matched \"{query}\" within "
                            f"{tolerance_seconds:.0f}s of {meta.get('duration_seconds', 0):.0f}s.")}
    best = accepted[0]
    return {"ok": True, "query": query, "spotify": meta, "match": best,
            "alternatives": accepted[1:4], "rejected": rejected,
            "url": _candidate_url(best)}


def _ytdlp_search(query: str, results: int):
    """Collect YouTube search rows safely, hydrating missing duration on a bounded subset.

    Fully extracting every result makes one age/sign-in-gated video abort the entire search before
    the matcher can inspect the other results. Flat search avoids that. Some flat rows omit duration,
    so the first few such candidates are individually hydrated; failures remain isolated per row.
    """
    import yt_dlp  # imported lazily: the matcher is testable without it

    opts = {
        "quiet": True,
        "no_warnings": True,
        "skip_download": True,
        "noplaylist": True,
        "extract_flat": "in_playlist",
        "ignoreerrors": True,
    }
    with yt_dlp.YoutubeDL(opts) as ydl:
        found = ydl.extract_info(f"ytsearch{int(results)}:{query}", download=False)
        rows = [entry for entry in ((found or {}).get("entries") or []) if isinstance(entry, dict)]
        return _hydrate_flat_rows(ydl, rows)
