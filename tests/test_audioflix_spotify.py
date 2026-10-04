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

    def test_private_share_token_is_preserved_and_scrape_uses_full_saved_session(self):
        normalized = audioflix_spotify.normalize_playlist_input(
            "https://open.spotify.com/playlist/5cLjZEw99fbjUcLHfMgkOL?si=share-context&pt=private-access-token"
        )
        self.assertTrue(normalized["ok"])
        self.assertIn("pt=private-access-token", normalized["url"])
        self.assertIn("pt=private-access-token", normalized["embedUrl"])
        self.assertIn("si=share-context", normalized["url"])

        with patch("server_modules.audioflix_spotify._project_root", return_value=Path("/repo")):
            with patch("server_modules.audioflix_spotify._profile_dir", return_value=Path("/spotify-profile")):
                scrape = audioflix_spotify._helper_command("scrape", normalized)
                self.assertEqual(scrape[3], normalized["url"])
                self.assertNotIn("/embed/playlist/", scrape[3])

    def test_private_share_and_bare_playlist_use_distinct_cache_keys(self):
        bare = audioflix_spotify.normalize_playlist_input(
            "https://open.spotify.com/playlist/5cLjZEw99fbjUcLHfMgkOL"
        )
        private = audioflix_spotify.normalize_playlist_input(
            "https://open.spotify.com/playlist/5cLjZEw99fbjUcLHfMgkOL?pt=private-access-token"
        )
        self.assertNotEqual(audioflix_spotify._cache_key(bare), audioflix_spotify._cache_key(private))


if __name__ == "__main__":
    unittest.main()
