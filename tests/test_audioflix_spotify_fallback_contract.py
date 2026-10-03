import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class SpotifyFallbackContractTests(unittest.TestCase):
    def test_standard_localization_never_auto_invokes_spotify_fallback(self):
        localize_js = (ROOT / "js/modules/features/audioflix/audioflix.localize.js").read_text(encoding="utf-8")
        forms_js = (ROOT / "js/modules/features/audioflix/audioflix.ui.forms.js").read_text(encoding="utf-8")
        native_js = (ROOT / "js/modules/features/audioflix/audioflix.native.localize.js").read_text(encoding="utf-8")
        bridge_py = (ROOT / "server_modules/audioflix_bridge.py").read_text(encoding="utf-8")

        self.assertIn("mediaFormat, 'standard').then", forms_js)
        self.assertIn("options.method === 'spotify-fallback' ? 'spotify-fallback' : 'standard'", native_js)
        self.assertIn('"/api/audioflix/localize-spotify-fallback": localize_spotify_fallback', bridge_py)

        start = localize_js.index("async function localizeScope(")
        end = localize_js.index("async function retrySpotifyRecovery(", start)
        standard_scope = localize_js[start:end]
        self.assertNotIn("retrySpotifyRecovery(", standard_scope)
        self.assertIn("finalizeLocalizationResult", standard_scope)

    def test_fallback_is_limited_to_spotify_tracks_in_mixed_scopes(self):
        localize_js = (ROOT / "js/modules/features/audioflix/audioflix.localize.js").read_text(encoding="utf-8")
        self.assertIn(
            "resolverMode === 'spotify-fallback' && isSpotifyTrack(it)",
            localize_js,
        )


if __name__ == "__main__":
    unittest.main()
