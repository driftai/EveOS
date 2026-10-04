import unittest
from pathlib import Path
from unittest.mock import patch

from server_modules import audioflix_spotify


class SpotifyPlaylistImportTests(unittest.TestCase):
    def test_scrape_starts_with_embed_while_login_opens_full_web_player(self):
        normalized = audioflix_spotify.normalize_playlist_input(
            "https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M"
        )
        self.assertTrue(normalized["ok"])

        with patch("server_modules.audioflix_spotify._project_root", return_value=Path("/repo")):
            with patch("server_modules.audioflix_spotify._profile_dir", return_value=Path("/spotify-profile")):
                scrape = audioflix_spotify._helper_command("scrape", normalized)
                login = audioflix_spotify._helper_command("login", normalized)
                self.assertEqual(scrape[3], normalized["embedUrl"])
                self.assertEqual(login[3], normalized["url"])


if __name__ == "__main__":
    unittest.main()
