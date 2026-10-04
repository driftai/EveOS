import unittest

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


if __name__ == "__main__":
    unittest.main()
