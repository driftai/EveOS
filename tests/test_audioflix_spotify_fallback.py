import unittest
from unittest.mock import patch

from server_modules import audioflix_spotify_fallback


class SpotifyFallbackTests(unittest.TestCase):
    def setUp(self):
        self.meta = {
            "ok": True,
            "title": "Example Song",
            "artists": ["Example Artist"],
            "duration_seconds": 200.0,
        }

    def test_fallback_expands_search_and_accepts_match_outside_standard_duration_gate(self):
        calls = []

        def searcher(query, results):
            calls.append((query, results))
            return [{
                "id": "abc123",
                "title": "Example Artist - Example Song (Official Audio)",
                "duration": 204.2,
                "view_count": 500000,
                "webpage_url": "https://www.youtube.com/watch?v=abc123",
                "formats": [],
            }]

        result = audioflix_spotify_fallback.find_fallback_match(
            "https://open.spotify.com/track/1234567890123456789012",
            searcher=searcher,
            metadata=self.meta,
        )

        self.assertTrue(result["ok"])
        self.assertEqual(result["strategy"], "expanded-youtube-search")
        self.assertEqual(result["url"], "https://www.youtube.com/watch?v=abc123")
        self.assertGreaterEqual(len(calls), 2)
        self.assertGreater(result["toleranceSeconds"], 3.0)

    def test_fallback_rejects_duration_match_with_weak_identity(self):
        accepted, rejected, _ = audioflix_spotify_fallback.rank_candidates(self.meta, [{
            "id": "wrong",
            "title": "Totally Different Artist - Totally Different Track",
            "duration": 200,
            "view_count": 99999999,
            "webpage_url": "https://www.youtube.com/watch?v=wrong",
            "formats": [],
        }])

        self.assertEqual(accepted, [])
        self.assertEqual(len(rejected), 1)
        self.assertIn("title overlap", rejected[0]["reason"])

    def test_fallback_rejects_live_version_when_spotify_track_is_not_live(self):
        accepted, rejected, _ = audioflix_spotify_fallback.rank_candidates(self.meta, [{
            "id": "live",
            "title": "Example Artist - Example Song Live",
            "duration": 201,
            "view_count": 1000,
            "webpage_url": "https://www.youtube.com/watch?v=live",
            "formats": [],
        }])

        self.assertEqual(accepted, [])
        self.assertEqual(rejected[0]["reason"], "different edition (live/remix/etc)")

    def test_localize_endpoint_refuses_non_spotify_identity_before_download(self):
        result = audioflix_spotify_fallback.localize_one({
            "track": {"id": "x", "title": "Nope", "url": "https://example.com/file.mp3"},
            "targetDir": "/tmp/music",
        })
        self.assertFalse(result["ok"])
        self.assertEqual(result["method"], "spotify-fallback")
        self.assertIn("only accepts Spotify-linked tracks", result["error"])

    def test_saved_import_metadata_survives_a_dead_spotify_page(self):
        track = {
            "id": "saved",
            "title": "Who Needs Love",
            "artist": "Example Artist",
            "duration": 201.75,
            "url": "https://open.spotify.com/track/1234567890123456789012",
            "spotifyTrackId": "1234567890123456789012",
            "spotifyUri": "spotify:track:1234567890123456789012",
            "isrc": "USABC2600001",
        }
        captured = {}

        def stop_after_identity(url, searcher=None, opener=None, metadata=None):
            captured["url"] = url
            captured["metadata"] = metadata
            return {"ok": False, "message": "fixture stops before download"}

        with patch.object(audioflix_spotify_fallback, "find_fallback_match", side_effect=stop_after_identity):
            result = audioflix_spotify_fallback.localize_one({
                "track": track,
                "targetDir": "/tmp/music",
            })

        self.assertFalse(result["ok"])
        self.assertEqual(result["metadataSource"], "eveos-import")
        self.assertEqual(captured["metadata"]["title"], "Who Needs Love")
        self.assertEqual(captured["metadata"]["artists"], ["Example Artist"])
        self.assertEqual(captured["metadata"]["duration_seconds"], 201.75)
        self.assertEqual(captured["metadata"]["track_id"], "1234567890123456789012")
        self.assertEqual(captured["metadata"]["isrc"], "USABC2600001")

    def test_incomplete_saved_metadata_keeps_live_spotify_lookup(self):
        self.assertEqual(audioflix_spotify_fallback.stored_track_metadata({
            "title": "Missing duration",
            "artist": "Example Artist",
            "duration": 0,
            "url": "https://open.spotify.com/track/1234567890123456789012",
        }), {})


if __name__ == "__main__":
    unittest.main()