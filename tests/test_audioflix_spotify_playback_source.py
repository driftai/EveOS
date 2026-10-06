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
    assert first["identityUrl"] == track["url"]
    assert second["url"] == first["url"]
    assert second.get("cached") is True
    assert calls == [(track["url"], expected_metadata)]


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
    assert "No verified recording matched" in result["reason"]
