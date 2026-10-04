import unittest

from server_modules import audioflix_spotify_fallback as fallback
from server_modules import audioflix_spotify_match as match


class FakeYdl:
    def __init__(self):
        self.calls = []

    def extract_info(self, url, download=False):
        self.calls.append((url, download))
        if "AGEGATED" in url:
            raise RuntimeError("Sign in to confirm your age")
        if "Y0U6u2D8cMU" in url:
            return {
                "id": "Y0U6u2D8cMU",
                "title": "Tame Impala - One More Hour (Official Audio)",
                "duration": 433,
                "view_count": 26000000,
                "webpage_url": "https://www.youtube.com/watch?v=Y0U6u2D8cMU",
            }
        return None


class SpotifySearchHydrationTests(unittest.TestCase):
    def test_missing_duration_is_hydrated_without_losing_candidate_identity(self):
        ydl = FakeYdl()
        rows = [{
            "id": "Y0U6u2D8cMU",
            "title": "Tame Impala - One More Hour (Official Audio)",
            "duration": None,
        }]

        hydrated = match._hydrate_flat_rows(ydl, rows)

        self.assertEqual(hydrated[0]["id"], "Y0U6u2D8cMU")
        self.assertEqual(hydrated[0]["duration"], 433)
        self.assertEqual(hydrated[0]["view_count"], 26000000)
        self.assertEqual(len(ydl.calls), 1)

    def test_age_gated_probe_does_not_abort_later_candidates(self):
        ydl = FakeYdl()
        rows = [
            {"id": "AGEGATED001", "title": "Blocked candidate", "duration": None},
            {"id": "Y0U6u2D8cMU", "title": "Tame Impala - One More Hour (Official Audio)", "duration": None},
        ]

        hydrated = match._hydrate_flat_rows(ydl, rows)

        self.assertIsNone(hydrated[0].get("duration"))
        self.assertEqual(hydrated[1]["duration"], 433)
        self.assertEqual(len(ydl.calls), 2)

    def test_probe_limit_bounds_extra_network_work(self):
        ydl = FakeYdl()
        rows = [
            {"id": f"MISS{index}", "title": f"Candidate {index}", "duration": None}
            for index in range(5)
        ]

        hydrated = match._hydrate_flat_rows(ydl, rows, limit=2)

        self.assertEqual(len(hydrated), 5)
        self.assertEqual(len(ydl.calls), 2)

    def test_one_more_hour_is_not_misclassified_as_bulk_in_standard_matcher(self):
        meta = {"title": "One More Hour", "artists": ["Tame Impala"], "duration_seconds": 433.0}
        candidates = [
            {
                "id": "Y0U6u2D8cMU",
                "title": "Tame Impala - One More Hour (Official Audio)",
                "duration": 434,
                "view_count": 26326399,
                "webpage_url": "https://www.youtube.com/watch?v=Y0U6u2D8cMU",
            },
            {
                "id": "60xd_Wzwmcs",
                "title": "[ 1 HOUR ] Tame Impala - One More Hour Whatever I've done I did it for love (Lyrics)",
                "duration": 3601,
                "view_count": 25009,
                "webpage_url": "https://www.youtube.com/watch?v=60xd_Wzwmcs",
            },
        ]

        accepted, rejected = match.rank_candidates(meta, candidates, tolerance_seconds=3.0)

        self.assertEqual([row["id"] for row in accepted], ["Y0U6u2D8cMU"])
        self.assertTrue(any(row["id"] == "60xd_Wzwmcs" for row in rejected))

    def test_one_more_hour_is_not_misclassified_as_bulk_in_fallback_ranker(self):
        meta = {"title": "One More Hour", "artists": ["Tame Impala"], "duration_seconds": 433.0}
        candidates = [
            {
                "id": "Y0U6u2D8cMU",
                "title": "Tame Impala - One More Hour (Official Audio)",
                "duration": 434,
                "view_count": 26326399,
                "webpage_url": "https://www.youtube.com/watch?v=Y0U6u2D8cMU",
            },
            {
                "id": "60xd_Wzwmcs",
                "title": "[ 1 HOUR ] Tame Impala - One More Hour Whatever I've done I did it for love (Lyrics)",
                "duration": 3601,
                "view_count": 25009,
                "webpage_url": "https://www.youtube.com/watch?v=60xd_Wzwmcs",
            },
        ]

        accepted, rejected, tolerance = fallback.rank_candidates(meta, candidates)

        self.assertEqual(tolerance, 10.0)
        self.assertEqual([row["id"] for row in accepted], ["Y0U6u2D8cMU"])
        self.assertTrue(any(row["id"] == "60xd_Wzwmcs" for row in rejected))

    def test_search_query_normalization_splits_camelcase_without_mutating_identity(self):
        self.assertEqual(match._normalize_search_query('*FloatingAway* pr/gosha'), 'Floating Away pr/gosha')

    def test_collect_search_rows_merges_general_and_music_results(self):
        class SearchYdl:
            def extract_info(self, target, download=False):
                if target.startswith('ytsearch'):
                    return {'entries': [
                        {'id': 'same', 'title': 'Song', 'duration': 180},
                        {'id': 'general', 'title': 'General only', 'duration': 181},
                    ]}
                return {'entries': [
                    {'id': 'same', 'title': 'Song', 'duration': 180, 'view_count': 123},
                    {'id': 'music', 'title': 'Music only', 'duration': 180},
                ]}

        rows = match._collect_search_rows(SearchYdl(), 'artist song', 8)
        by_id = {row['id']: row for row in rows}
        self.assertEqual(set(by_id), {'same', 'general', 'music'})
        self.assertEqual(by_id['same']['view_count'], 123)

    def test_youtube_music_search_url_targets_songs(self):
        url = match._youtube_music_search_url('*FloatingAway* pr/gosha')
        self.assertIn('music.youtube.com/search?', url)
        self.assertIn('Floating+Away+pr%2Fgosha', url)
        self.assertTrue(url.endswith('#songs'))


if __name__ == "__main__":
    unittest.main()
