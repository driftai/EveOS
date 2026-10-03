import unittest

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

    def test_localize_endpoint_refuses_non_spotify_url_before_download(self):
        result = audioflix_spotify_fallback.localize_one({
            "track": {"id": "x", "title": "Nope", "url": "https://example.com/file.mp3"},
            "targetDir": "/tmp/music",
        })
        self.assertFalse(result["ok"])
        self.assertEqual(result["method"], "spotify-fallback")
        self.assertIn("only accepts Spotify track URLs", result["error"])


if __name__ == "__main__":
    unittest.main()
