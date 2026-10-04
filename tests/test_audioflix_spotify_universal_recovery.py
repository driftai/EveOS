import unittest
from unittest.mock import patch

from server_modules import audioflix_spotify_fallback as fallback


class SpotifyUniversalRecoveryTests(unittest.TestCase):
    def test_camelcase_title_tokens_are_split_for_identity(self):
        self.assertEqual(fallback._tokens("*FloatingAway* pr/gosha"), {"floating", "away", "pr", "gosha"})

    def test_segmented_title_can_match_when_artist_is_independently_corroborated(self):
        meta = {"title": "Waste No Time! / One Way!", "artists": ["evan aloe"], "duration_seconds": 145.0}
        candidate = {"id": "candidate-1", "title": "one way! (original)", "duration": 145, "uploader": "evan aloe", "webpage_url": "https://www.youtube.com/watch?v=candidate-1"}
        accepted, rejected, _ = fallback.rank_candidates(meta, [candidate])
        self.assertEqual(len(accepted), 1)
        self.assertFalse(rejected)
        self.assertTrue(accepted[0]["partialTitle"])
        self.assertGreater(accepted[0]["artistOverlap"], 0)

    def test_segmented_title_is_not_enough_without_artist_corroboration(self):
        meta = {"title": "Waste No Time! / One Way!", "artists": ["evan aloe"], "duration_seconds": 145.0}
        candidate = {"id": "candidate-2", "title": "one way!", "duration": 145, "uploader": "someone else", "webpage_url": "https://www.youtube.com/watch?v=candidate-2"}
        accepted, rejected, _ = fallback.rank_candidates(meta, [candidate])
        self.assertFalse(accepted)
        self.assertEqual(rejected[0]["reason"], "artist not corroborated")

    def test_stylized_title_can_match_normalized_words_with_artist_metadata(self):
        meta = {"title": "*FloatingAway* pr/gosha", "artists": ["SliceMaxxi"], "duration_seconds": 151.0}
        candidate = {"id": "candidate-3", "title": "Floating Away", "duration": 151, "artist": "SliceMaxxi", "webpage_url": "https://soundcloud.com/slicemaxxi/floating-away", "_source": "soundcloud"}
        accepted, rejected, _ = fallback.rank_candidates(meta, [candidate])
        self.assertEqual(len(accepted), 1)
        self.assertFalse(rejected)
        self.assertEqual(accepted[0]["source"], "soundcloud")

    def test_soundcloud_id_never_becomes_a_fake_youtube_url(self):
        self.assertEqual(fallback._candidate_url({"_source": "soundcloud", "id": "12345"}), "")
        self.assertEqual(fallback._candidate_url({"_source": "soundcloud", "id": "12345", "webpage_url": "https://soundcloud.com/artist/song"}), "https://soundcloud.com/artist/song")

    def test_query_variants_include_multi_part_aliases(self):
        queries = fallback.query_variants({"title": "Waste No Time! / One Way!", "artists": ["evan aloe"]})
        normalized = [query.casefold() for query in queries]
        self.assertTrue(any("evan aloe one way!" in query for query in normalized))
        self.assertTrue(any("evan aloe waste no time!" in query for query in normalized))

    def test_soundcloud_is_only_used_after_primary_sources_miss(self):
        meta = {"ok": True, "title": "FloatingAway", "artists": ["Example Artist"], "duration_seconds": 151.0}
        sc_candidate = {"id": "sc-1", "title": "Floating Away", "duration": 151, "uploader": "Example Artist", "webpage_url": "https://soundcloud.com/example/floating-away", "_source": "soundcloud"}
        with patch.object(fallback, "_search", return_value=[]) as primary, patch.object(fallback, "_soundcloud_search", return_value=[sc_candidate]) as secondary:
            result = fallback.find_fallback_match("", metadata=meta)
        self.assertTrue(result["ok"])
        self.assertEqual(result["match"]["source"], "soundcloud")
        self.assertGreater(primary.call_count, 0)
        self.assertGreater(secondary.call_count, 0)

    def test_soundcloud_is_skipped_when_primary_sources_already_match(self):
        meta = {"ok": True, "title": "Known Song", "artists": ["Known Artist"], "duration_seconds": 180.0}
        yt_candidate = {"id": "yt-1", "title": "Known Artist - Known Song", "duration": 180, "webpage_url": "https://www.youtube.com/watch?v=yt-1"}
        with patch.object(fallback, "_search", return_value=[yt_candidate]), patch.object(fallback, "_soundcloud_search", return_value=[]) as secondary:
            result = fallback.find_fallback_match("", metadata=meta)
        self.assertTrue(result["ok"])
        secondary.assert_not_called()


if __name__ == "__main__":
    unittest.main()
