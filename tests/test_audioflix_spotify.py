import unittest
from pathlib import Path
from unittest.mock import patch

from server_modules import audioflix_spotify


class SpotifyPlaylistImportTests(unittest.TestCase):
    def test_helper_uses_full_web_player_playlist_instead_of_embed(self):
        normalized = audioflix_spotify.normalize_playlist_input(
            "https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M"
        )
        self.assertTrue(normalized["ok"])

        with patch("server_modules.audioflix_spotify._project_root", return_value=Path("/repo")):
            with patch("server_modules.audioflix_spotify._profile_dir", return_value=Path("/spotify-profile")):
                for mode in ("scrape", "login"):
                    with self.subTest(mode=mode):
                        command = audioflix_spotify._helper_command(mode, normalized)
                        self.assertEqual(command[3], normalized["url"])
                        self.assertNotIn("/embed/playlist/", command[3])


if __name__ == "__main__":
    unittest.main()
