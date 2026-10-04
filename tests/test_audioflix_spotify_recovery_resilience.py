import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from server_modules import audioflix_spotify_fallback as fallback


ROOT = Path(__file__).resolve().parents[1]
SPOTIFY_URL = "https://open.spotify.com/track/1234567890123456789012"


def resolved_fixture():
    return {
        "ok": True,
        "strategy": fallback.STRATEGY,
        "spotify": {
            "ok": True,
            "title": "Example Song",
            "artists": ["Example Artist"],
            "duration_seconds": 200.0,
        },
        "match": {
            "id": "AGEGATED001",
            "title": "Example Artist - Example Song (Official Audio)",
            "duration": 200,
            "url": "https://www.youtube.com/watch?v=AGEGATED001",
        },
        "alternatives": [{
            "id": "PUBLICALT01",
            "title": "Example Artist - Example Song",
            "duration": 201,
            "url": "https://www.youtube.com/watch?v=PUBLICALT01",
        }],
        "url": "https://www.youtube.com/watch?v=AGEGATED001",
    }


class SpotifyRecoveryResilienceTests(unittest.TestCase):
    def track(self):
        return {
            "id": "spotify-track",
            "title": "Example Song",
            "artist": "Example Artist",
            "duration": 200.0,
            "url": SPOTIFY_URL,
            "spotifyTrackId": "1234567890123456789012",
        }

    def test_search_collects_flat_rows_without_opening_every_video(self):
        source = (ROOT / "server_modules/audioflix_spotify_match.py").read_text(encoding="utf-8")
        self.assertIn('"extract_flat": "in_playlist"', source)
        self.assertIn('"ignoreerrors": True', source)
        self.assertIn("def _candidate_url", source)

    def test_explicit_fallback_refreshes_bridge_and_shows_start_feedback(self):
        source = (ROOT / "js/modules/features/audioflix/audioflix.native.identity.js").read_text(encoding="utf-8")
        self.assertIn("function requestFreshProbe", source)
        self.assertIn("action !== 'retry-spotify-fallback'", source)
        self.assertIn("action !== 'localize-spotify-fallback-scope'", source)
        self.assertIn("Spotify Fallback started", source)
        self.assertIn("EXPLICIT_PROBE_TIMEOUT_MS", source)

    def test_candidate_chain_keeps_strong_alternatives(self):
        candidates = fallback.candidate_attempts(resolved_fixture())
        self.assertEqual([row["id"] for row in candidates], ["AGEGATED001", "PUBLICALT01"])

    def test_fallback_tries_next_strong_candidate_after_age_gate(self):
        with tempfile.TemporaryDirectory() as tmp:
            output = Path(tmp) / "Example Song.mp3"
            calls = []

            def fake_download(_yt_dlp, url, _outtmpl, _want_mp3, _media_format):
                calls.append(url)
                if "AGEGATED001" in url:
                    raise RuntimeError("ERROR: Sign in to confirm your age")
                output.write_bytes(b"test")
                return {"filepath": str(output), "duration": 201}

            with patch.object(fallback, "find_fallback_match", return_value=resolved_fixture()), \
                    patch.object(fallback.localize, "_prepare_dir", return_value=(Path(tmp), None)), \
                    patch.object(fallback.localize, "_get_yt_dlp", return_value=object()), \
                    patch.object(fallback.localize, "_download", side_effect=fake_download):
                result = fallback.localize_one({
                    "track": self.track(),
                    "targetDir": tmp,
                    "mediaFormat": "video",
                })

        self.assertTrue(result["ok"])
        self.assertEqual(result["matchedUrl"], "https://www.youtube.com/watch?v=PUBLICALT01")
        self.assertEqual(result["attemptedCandidates"], 2)
        self.assertEqual(len(calls), 2)

    def test_all_age_gated_matches_are_reported_as_inaccessible_not_no_match(self):
        fixture = resolved_fixture()
        fixture["alternatives"] = []
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(fallback, "find_fallback_match", return_value=fixture), \
                patch.object(fallback.localize, "_prepare_dir", return_value=(Path(tmp), None)), \
                patch.object(fallback.localize, "_get_yt_dlp", return_value=object()), \
                patch.object(fallback.localize, "_download", side_effect=RuntimeError("Sign in to confirm your age")):
            result = fallback.localize_one({
                "track": self.track(),
                "targetDir": tmp,
                "mediaFormat": "video",
            })

        self.assertFalse(result["ok"])
        self.assertEqual(result["failureKind"], "match_found_but_inaccessible")
        self.assertEqual(result["access"], "auth_required")
        self.assertEqual(result["matchedUrl"], "https://www.youtube.com/watch?v=AGEGATED001")
        self.assertIn("requires sign-in/age verification", result["error"])


if __name__ == "__main__":
    unittest.main()
