"""Small pure helpers shared by the managed Spotify browser runtime and its smokes."""
from __future__ import annotations

import re
from urllib.parse import urlsplit

_TRACK_ID_RE = re.compile(r"^[A-Za-z0-9]{22}$")


def clamp_volume(value, fallback: float = 1.0) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = float(fallback)
    if number != number or number in (float("inf"), float("-inf")):
        number = float(fallback)
    return max(0.0, min(1.0, number))


def normalize_track_id(value) -> str:
    raw = str(value or "").strip()
    if _TRACK_ID_RE.fullmatch(raw):
        return raw
    match = re.search(
        r"(?:spotify:track:|open\.spotify\.com/(?:embed/)?track/)([A-Za-z0-9]{22})(?:[?/#]|$)",
        raw,
        re.I,
    )
    return match.group(1) if match else ""


def validate_loopback_page_url(value: str) -> bool:
    try:
        parsed = urlsplit(str(value or "").strip())
    except ValueError:
        return False
    host = (parsed.hostname or "").lower()
    return parsed.scheme in {"http", "https"} and host in {"127.0.0.1", "localhost", "::1"}
