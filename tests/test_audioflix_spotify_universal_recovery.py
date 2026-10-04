import unittest
from unittest.mock import patch

from server_modules import audioflix_spotify_fallback as fallback


class SpotifyUniversalRecoveryTests(unittest.TestCase):
    def test_camelcase_title_tokens_are_split_for_identity(self):
        self.assertEqual(fallback._tokens("*FloatingAway* pr/gosha"), {"floating", "away", "pr", "gosha"})

    def test_artist_tokens_bridge_camelcase_and_flat_spelling(self):
        wanted = fallback._artist_tokens("SliceMaxxi")
        flattened = fallback._artist_tokens("Slicemaxxi")
        self.assertIn("slicemaxxi", wanted)
        self.assertGreater(fallback._overlap(wanted, flattened), 0)

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

    def test_explicit_title_artist_credit_accepts_near_duration_match(self):
        meta = {"title": "*FloatingAway* pr/gosha", "artists": ["SliceMaxxi"], "duration_seconds": 151.0}
        candidate = {
            "id": "DTRpvx6oC30",
            "title": "*FloatingAway* prgosha by Slicemaxxi CLEAN",
            "duration": 147,
            "view_count": 1456,
            "webpage_url": "https://www.youtube.com/watch?v=DTRpvx6oC30",
        }
        accepted, rejected, _ = fallback.rank_candidates(meta, [candidate])
        self.assertEqual(len(accepted), 1)
        self.assertFalse(rejected)
        self.assertEqual(accepted[0]["artistEvidence"], "title-credit")
        self.assertEqual(accepted[0]["delta"], 4.0)
        self.assertTrue(fallback._decisive_match(accepted[0]))

    def test_arbitrary_artist_mention_is_not_title_credit(self):
        meta = {"title": "Floating Away", "artists": ["SliceMaxxi"], "duration_seconds": 151.0}
        candidate = {
            "id": "not-credit",
            "title": "Floating Away with Slicemaxxi vibes",
            "duration": 151,
            "uploader": "unrelated account",
            "webpage_url": "https://www.youtube.com/watch?v=not-credit",
        }
        accepted, rejected, _ = fallback.rank_candidates(meta, [candidate])
        self.assertFalse(accepted)
        self.assertEqual(rejected[0]["reason"], "artist not corroborated")

    def test_soundcloud_repost_description_can_corroborate_original_artist(self):
        meta = {"title": "*FloatingAway* pr/gosha", "artists": ["SliceMaxxi"], "duration_seconds": 151.0}
        candidate = {
            "id": "repost-1",
            "title": "Floating Away",
            "duration": 151.4,
            "uploader": "archive account",
            "description": "repost / archive — *FloatingAway* by SliceMaxxi",
            "webpage_url": "https://soundcloud.com/archive/floating-away",
            "_source": "soundcloud",
        }
        accepted, rejected, _ = fallback.rank_candidates(meta, [candidate])
        self.assertEqual(len(accepted), 1)
        self.assertFalse(rejected)
        self.assertEqual(accepted[0]["artistEvidence"], "soundcloud-description")
        self.assertGreater(accepted[0]["artistOverlap"], 0)

    def test_soundcloud_description_does_not_rescue_loose_duration(self):
        meta = {"title": "*FloatingAway* pr/gosha", "artists": ["SliceMaxxi"], "duration_seconds": 151.0}
        candidate = {
            "id": "repost-2",
            "title": "Floating Away",
            "duration": 155.0,
            "uploader": "archive account",
            "description": "repost by SliceMaxxi",
            "webpage_url": "https://soundcloud.com/archive/floating-away-long",
            "_source": "soundcloud",
        }
        accepted, rejected, _ = fallback.rank_candidates(meta, [candidate])
        self.assertFalse(accepted)
        self.assertEqual(rejected[0]["reason"], "artist not corroborated")

    def test_soundcloud_description_does_not_rescue_wrong_title(self):
        meta = {"title": "*FloatingAway* pr/gosha", "artists": ["SliceMaxxi"], "duration_seconds": 151.0}
        candidate = {
            "id": "repost-3",
            "title": "Completely Different Song",
            "duration": 151.0,
            "uploader": "archive account",
            "description": "music by SliceMaxxi",
            "webpage_url": "https://soundcloud.com/archive/different",
            "_source": "soundcloud",
        }
        accepted, rejected, _ = fallback.rank_candidates(meta, [candidate])
        self.assertFalse(accepted)
        self.assertTrue(rejected[0]["reason"].startswith("weak title overlap"))

    def test_producer_credit_suffix_gets_clean_search_alias_first(self):
        aliases = fallback._title_query_aliases("*FloatingAway* pr/gosha")
        self.assertEqual(aliases[0], "Floating Away")
        queries = [query.casefold() for query in fallback.query_variants({
            "title": "*FloatingAway* pr/gosha",
            "artists": ["SliceMaxxi"],
        })]
        self.assertEqual(queries[0], "slicemaxxi floating away")

    def test_soundcloud_title_only_query_runs_first_for_reposts(self):
        queries = fallback.soundcloud_query_variants({
            "title": "*FloatingAway* pr/gosha",
            "artists": ["SliceMaxxi"],
        })
        self.assertEqual(queries[0], "Floating Away")
        self.assertIn("SliceMaxxi Floating Away", queries)
        self.assertLessEqual(len(queries), fallback.SOUNDCLOUD_MAX_QUERY_VARIANTS)

    def test_soundcloud_flat_candidate_is_hydrated_for_description_credit(self):
        class FakeYDL:
            def __init__(self):
                self.calls = []

            def extract_info(self, url, download=False):
                self.calls.append(url)
                return {
                    "id": "repost-flat",
                    "title": "Floating Away",
                    "duration": 151.2,
                    "uploader": "archive account",
                    "description": "archived *FloatingAway* by SliceMaxxi",
                    "webpage_url": url,
                }

        ydl = FakeYDL()
        rows = [{
            "id": "repost-flat",
            "title": "Floating Away",
            "duration": 151.2,
            "webpage_url": "https://soundcloud.com/archive/floating-away",
        }]
        hydrated = fallback._hydrate_soundcloud_rows(ydl, rows, "Floating Away", limit=1)
        self.assertEqual(len(ydl.calls), 1)
        self.assertEqual(hydrated[0]["description"], "archived *FloatingAway* by SliceMaxxi")
        self.assertEqual(hydrated[0]["_source"], "soundcloud")

    def test_soundcloud_id_never_becomes_a_fake_youtube_url(self):
        self.assertEqual(fallback._candidate_url({"_source": "soundcloud", "id": "12345"}), "")
        self.assertEqual(fallback._candidate_url({"_source": "soundcloud", "id": "12345", "webpage_url": "https://soundcloud.com/artist/song"}), "https://soundcloud.com/artist/song")

    def test_query_variants_include_multi_part_aliases(self):
        queries = fallback.query_variants({"title": "Waste No Time! / One Way!", "artists": ["evan aloe"]})
        normalized = [query.casefold() for query in queries]
        self.assertTrue(any("evan aloe one way!" in query for query in normalized))
        self.assertTrue(any("evan aloe waste no time!" in query for query in normalized))
        self.assertLessEqual(len(queries), fallback.MAX_QUERY_VARIANTS)

    def test_soundcloud_is_only_used_after_primary_sources_miss(self):
        meta = {"ok": True, "title": "FloatingAway", "artists": ["Example Artist"], "duration_seconds": 151.0}
        sc_candidate = {"id": "sc-1", "title": "Floating Away", "duration": 151, "uploader": "Example Artist", "webpage_url": "https://soundcloud.com/example/floating-away", "_source": "soundcloud"}
        with patch.object(fallback, "_search", return_value=[]) as primary, patch.object(fallback, "_soundcloud_search", return_value=[sc_candidate]) as secondary:
            result = fallback.find_fallback_match("", metadata=meta)
        self.assertTrue(result["ok"])
        self.assertEqual(result["match"]["source"], "soundcloud")
        self.assertEqual(primary.call_count, fallback.FAST_QUERY_COUNT)
        self.assertEqual(secondary.call_count, 1)

    def test_soundcloud_is_skipped_when_primary_sources_already_match(self):
        meta = {"ok": True, "title": "Known Song", "artists": ["Known Artist"], "duration_seconds": 180.0}
        yt_candidate = {"id": "yt-1", "title": "Known Artist - Known Song", "duration": 180, "webpage_url": "https://www.youtube.com/watch?v=yt-1"}
        with patch.object(fallback, "_search", return_value=[yt_candidate]) as primary, patch.object(fallback, "_soundcloud_search", return_value=[]) as secondary:
            result = fallback.find_fallback_match("", metadata=meta)
        self.assertTrue(result["ok"])
        self.assertEqual(primary.call_count, 1)
        secondary.assert_not_called()

    def test_decisive_zero_delta_match_stops_after_first_query(self):
        meta = {"ok": True, "title": "Known Song", "artists": ["Known Artist"], "duration_seconds": 180.0}
        candidate = {
            "id": "yt-fast",
            "title": "Known Artist - Known Song",
            "duration": 180,
            "uploader": "Known Artist",
            "webpage_url": "https://www.youtube.com/watch?v=yt-fast",
        }
        with patch.object(fallback, "_search", return_value=[candidate]) as primary:
            result = fallback.find_fallback_match("", metadata=meta)
        self.assertTrue(result["ok"])
        self.assertEqual(primary.call_count, 1)

    def test_title_credit_near_match_stops_after_first_query(self):
        meta = {"ok": True, "title": "Floating Away", "artists": ["SliceMaxxi"], "duration_seconds": 151.0}
        candidate = {
            "id": "title-credit-fast",
            "title": "Floating Away by Slicemaxxi CLEAN",
            "duration": 147,
            "webpage_url": "https://www.youtube.com/watch?v=title-credit-fast",
        }
        with patch.object(fallback, "_search", return_value=[candidate]) as primary, \
                patch.object(fallback, "_soundcloud_search", return_value=[]) as secondary:
            result = fallback.find_fallback_match("", metadata=meta)
        self.assertTrue(result["ok"])
        self.assertEqual(result["match"]["artistEvidence"], "title-credit")
        self.assertEqual(primary.call_count, 1)
        secondary.assert_not_called()


if __name__ == "__main__":
    unittest.main()
