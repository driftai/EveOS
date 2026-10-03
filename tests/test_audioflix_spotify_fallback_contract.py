import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SpotifyFallbackContractTests(unittest.TestCase):
    def test_standard_localization_never_auto_invokes_spotify_fallback(self):
        client = (ROOT / "js/modules/features/audioflix/audioflix.spotify.fallback.js").read_text(encoding="utf-8")
        native = (ROOT / "js/modules/features/audioflix/audioflix.native.localize.js").read_text(encoding="utf-8")
        bridge = (ROOT / "server_modules/audioflix_bridge.py").read_text(encoding="utf-8")

        self.assertIn("options.method === 'spotify-fallback' ? 'spotify-fallback' : 'standard'", native)
        self.assertIn("'/api/audioflix/localize-spotify-fallback'", native)
        self.assertIn('"/api/audioflix/localize-spotify-fallback": localize_spotify_fallback', bridge)
        self.assertIn("resolver === 'standard' ? failures.filter", client)
        self.assertIn("Nothing retries automatically", client)
        self.assertIn("mediaFormat, 'standard').then", client)

        start = client.index("async function localizeScopeCompat(")
        end = client.index("function getSpotifyRecovery()", start)
        standard_scope = client[start:end]
        self.assertNotIn("retrySpotifyRecovery(", standard_scope)

    def test_fallback_is_limited_to_spotify_tracks_in_mixed_scopes(self):
        client = (ROOT / "js/modules/features/audioflix/audioflix.spotify.fallback.js").read_text(encoding="utf-8")
        self.assertIn(
            "resolverMode === 'spotify-fallback' && isSpotifyTrack(item)",
            client,
        )
        self.assertIn("method = resolverMode === 'spotify-fallback'", client)

    def test_client_stays_under_first_party_line_cap(self):
        client_path = ROOT / "js/modules/features/audioflix/audioflix.spotify.fallback.js"
        self.assertLessEqual(len(client_path.read_text(encoding="utf-8").splitlines()), 450)


if __name__ == "__main__":
    unittest.main()
