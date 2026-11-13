"""Production source contract: exactly-one same-window Play fallback per revision.

Runs without opening Edge, accessing Spotify, or the native audio service.
The JavaScript VM regression covers actual timing and stale-owner behavior.
"""
from pathlib import Path
import unittest

HOST = Path(__file__).resolve().parents[1] / 'server' / 'spotify-embed-edge.html'


class PlayAfterLoadContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.source = HOST.read_text(encoding='utf-8-sig')

    def test_bounded_delayed_fallback(self):
        self.assertIn("setTimeout(() => {\n                if (awaitingMediaIdentity !== pending", self.source)
        self.assertIn("void acknowledgeLoadedMedia(pending)", self.source)
        self.assertIn("}, 2200);", self.source)

    def test_matching_revision_uri_and_single_owner(self):
        self.assertIn('awaitingMediaIdentity !== pending || atRevision !== revision', self.source)
        self.assertIn('requested !== selectedUri', self.source)
        self.assertIn('awaitingMediaIdentity = null; // prevents duplicate SDK+fallback arms', self.source)
        self.assertIn('awaiting.uri === info.playingURI', self.source)
        self.assertIn('info.isBuffering !== true', self.source)

    def test_no_unverified_playback_or_queue_completion(self):
        self.assertIn('const completedRevision = revision, completedUri = selectedUri', self.source)
        self.assertIn('completedRevision === revision && completedUri === selectedUri', self.source)
        self.assertIn("await send('ended', { playingURI: completedUri })", self.source)
        self.assertIn("const load = controller.loadEntity || controller.loadUri", self.source)
        self.assertNotIn('controller.play();', self.source)

    def test_v2_acknowledgement_retry_preserved(self):
        self.assertIn('for (let retry = 0; retry < 4 && expected === revision && requested === selectedUri; retry++)', self.source)
        self.assertIn("send('media-loaded', { playingURI: requested })", self.source)
        self.assertIn("Spotify is settling the new track; preparing Play.", self.source)


if __name__ == '__main__':
    unittest.main()
