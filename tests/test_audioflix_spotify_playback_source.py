import sys
import time
import types

from server_modules import audioflix_spotify as spotify
from server_modules import audioflix_spotify_fallback as fallback


def _clear_cache():
    with spotify._cache_lock:
        spotify._cache.clear()


def test_spotify_playback_source_uses_strict_matcher_and_caches(monkeypatch):
    _clear_cache()
    calls = []
    track = {
        "id": "spotify-track-1",
        "spotifyTrackId": "abc123",
        "url": "https://open.spotify.com/track/abc123",
        "title": "Example Song",
        "artist": "Example Artist",
        "duration": 201.0,
        "isrc": "USAAA2600001",
    }
    expected_metadata = {
        "title": "Example Song",
        "artist": "Example Artist",
        "duration": 201.0,
    }

    monkeypatch.setattr(fallback, "FALLBACK_HYDRATE_LIMIT", 2)
    monkeypatch.setattr(fallback, "stored_track_metadata", lambda value: expected_metadata)

    def fake_match(url, searcher=None, opener=None, metadata=None):
        calls.append((url, metadata))
        return {
            "ok": True,
            "url": "https://www.youtube.com/watch?v=matched-recording",
            "match": {
                "source": "youtube",
                "title": "Example Artist - Example Song",
            },
            "toleranceSeconds": 3.0,
        }

    monkeypatch.setattr(fallback, "find_fallback_match", fake_match)

    first = spotify.resolve_playback_source({"track": track})
    second = spotify.resolve_playback_source({"track": track})

    assert first["ok"] is True
    assert first["url"] == "https://www.youtube.com/watch?v=matched-recording"
    assert first["provider"] == "youtube"
    assert first["resolver"] == fallback.STRATEGY
    assert first["resolverRevision"] == spotify._PLAYBACK_RESOLVER_REVISION
    assert first["identityUrl"] == track["url"]
    assert second["url"] == first["url"]
    assert second.get("cached") is True
    assert calls == [(track["url"], expected_metadata)]
    # Live playback may inspect more candidates, but it must not widen the shared localization
    # resolver for later download/fallback requests in this long-running Python process.
    assert fallback.FALLBACK_HYDRATE_LIMIT == 2


def test_spotify_playback_source_keeps_identity_when_no_match(monkeypatch):
    _clear_cache()
    track = {
        "id": "spotify-track-missing",
        "url": "https://open.spotify.com/track/missing123",
        "title": "Unmatched Song",
    }

    monkeypatch.setattr(fallback, "stored_track_metadata", lambda value: {"title": value["title"]})
    monkeypatch.setattr(
        fallback,
        "find_fallback_match",
        lambda url, searcher=None, opener=None, metadata=None: {
            "ok": False,
            "reason": "No verified recording matched.",
        },
    )

    result = spotify.resolve_playback_source({"track": track})

    assert result["ok"] is False
    assert result["identityUrl"] == track["url"]
    assert result["resolver"] == fallback.STRATEGY
    assert result["resolverRevision"] == spotify._PLAYBACK_RESOLVER_REVISION
    assert "No verified recording matched" in result["reason"]


def test_spotify_playback_source_surfaces_fallback_message(monkeypatch):
    _clear_cache()
    track = {
        "id": "spotify-track-message",
        "url": "https://open.spotify.com/track/message123",
        "title": "Message Song",
    }

    monkeypatch.setattr(fallback, "stored_track_metadata", lambda value: {"title": value["title"]})
    monkeypatch.setattr(
        fallback,
        "find_fallback_match",
        lambda url, searcher=None, opener=None, metadata=None: {
            "ok": False,
            "message": "Searched six strict candidates and none matched.",
        },
    )

    result = spotify.resolve_playback_source({"track": track})

    assert result["ok"] is False
    assert result["reason"] == "Searched six strict candidates and none matched."


def test_spotify_playback_source_prefers_embed_search_then_keeps_broad_fallback(monkeypatch):
    _clear_cache()
    calls = []
    track = {
        "id": "spotify-track-fallback",
        "url": "https://open.spotify.com/track/fallback123",
        "title": "Fallback Song",
        "artist": "Fallback Artist",
        "duration": 180.0,
    }

    monkeypatch.setattr(fallback, "stored_track_metadata", lambda value: {
        "ok": True,
        "title": value["title"],
        "artists": [value["artist"]],
        "duration_seconds": value["duration"],
    })

    def fake_match(url, searcher=None, opener=None, metadata=None):
        calls.append(searcher)
        if searcher is not None:
            return {"ok": False, "message": "Embedded client could not prove a match."}
        return {
            "ok": True,
            "url": "https://soundcloud.com/example/fallback-song",
            "match": {
                "source": "soundcloud",
                "title": "Fallback Song",
            },
            "toleranceSeconds": 5.0,
        }

    monkeypatch.setattr(fallback, "find_fallback_match", fake_match)

    result = spotify.resolve_playback_source({"track": track})

    assert result["ok"] is True
    assert result["provider"] == "soundcloud"
    assert calls == [spotify._playback_youtube_search, None]


def test_spotify_playback_source_times_out_before_frontend_request_deadline(monkeypatch):
    _clear_cache()
    track = {
        "id": "spotify-track-timeout",
        "url": "https://open.spotify.com/track/timeout123",
        "title": "Slow Song",
        "artist": "Slow Artist",
        "duration": 180.0,
    }

    monkeypatch.setattr(spotify, "_PLAYBACK_RESOLVER_TIMEOUT_S", 0.05)
    monkeypatch.delenv("EVEOS_SPOTIFY_PLAYBACK_TIMEOUT_S", raising=False)
    monkeypatch.setattr(fallback, "stored_track_metadata", lambda value: {
        "title": value["title"],
        "artist": value["artist"],
        "duration": value["duration"],
    })

    def slow_match(url, searcher=None, opener=None, metadata=None):
        # Return a success after the synthetic stall so the abandoned worker exits cleanly instead
        # of entering a second fallback call after pytest has restored the monkeypatch.
        time.sleep(0.2)
        return {
            "ok": True,
            "url": "https://www.youtube.com/watch?v=late-success",
            "match": {"source": "youtube", "title": "Late Success"},
        }

    monkeypatch.setattr(fallback, "find_fallback_match", slow_match)

    result = spotify.resolve_playback_source({"track": track})

    assert result["ok"] is False
    assert result["failureKind"] == "timeout"
    assert "timed out" in result["reason"].lower()
    assert "bot check" in result["reason"].lower()


def test_spotify_playback_source_names_youtube_player_data_bot_check(monkeypatch):
    _clear_cache()
    track = {
        "id": "spotify-track-bot-check",
        "url": "https://open.spotify.com/track/botcheck123",
        "title": "Blocked Song",
    }

    monkeypatch.setattr(fallback, "stored_track_metadata", lambda value: {"title": value["title"]})
    monkeypatch.setattr(
        fallback,
        "find_fallback_match",
        lambda url, searcher=None, opener=None, metadata=None: {
            "ok": False,
            "message": "ERROR: Failed to extract any player response",
        },
    )

    result = spotify.resolve_playback_source({"track": track})

    assert result["ok"] is False
    assert result["reason"].startswith("YouTube refused player data (bot check).")


def test_playback_youtube_search_uses_web_embedded_client(monkeypatch):
    captured = {}

    class FakeYdl:
        def __init__(self, opts):
            captured.update(opts)

        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def extract_info(self, target, download=False):
            return {"entries": []}

    monkeypatch.setitem(sys.modules, "yt_dlp", types.SimpleNamespace(YoutubeDL=FakeYdl))

    rows = spotify._playback_youtube_search("Example Artist Example Song", 6)

    assert rows == []
    assert captured["extractor_args"]["youtube"]["player_client"] == ["web_embedded"]
    assert captured["skip_download"] is True
    assert captured["noplaylist"] is True
