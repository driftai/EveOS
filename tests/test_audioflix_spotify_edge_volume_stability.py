"""No-hardware regression tests for official Embed volume and output ownership."""
import unittest
import time
from types import SimpleNamespace
from threading import RLock
from unittest.mock import patch
import server_modules.audioflix_spotify_edge_route as route

from server_modules.audioflix_spotify_edge import EdgeSpotifyManager
from server_modules.audioflix_spotify_edge_route import _assigned_route_is_still_safe

URI = 'spotify:track:' + 'A' * 22
URI2 = 'spotify:track:' + 'B' * 22


class MockBackend:
    def __init__(self, endpoint='VB-CABLE', sessions=1):
        self.endpoint = endpoint
        self.sessions = sessions
        self.gains = []
        self.raise_volume = False

    def get(self, pid):
        assert pid == 123
        return self.endpoint

    def volume(self, pid, gain, target):
        assert pid == 123 and target == 'VB-CABLE'
        if self.raise_volume:
            raise RuntimeError('session momentarily inactive')
        self.gains.append(gain)
        return self.sessions


class EdgeVolumeStabilityTests(unittest.TestCase):
    def setUp(self):
        self.backend = MockBackend()
        self.manager = EdgeSpotifyManager(process_finder=lambda _: {123: 44.0})
        self.manager._running = True
        self.manager._uri = URI
        self.manager._media_revision = 5
        self.manager._profile_path = 'profile fixture'
        self.manager._routes = {123: (44.0, None)}
        self.manager._backend = self.backend
        self.manager._target = 'VB-CABLE'

    def send(self, value, **extras):
        return self.manager.command({'action': 'volume', 'payload': {
            'gain': value, 'spotifyUri': URI, 'revision': 5, **extras
        }}, 8765)

    def test_volume_applies_without_song_revision_or_pending_transport_change(self):
        before = self.manager._media_revision
        reply = self.send(.25)
        self.assertTrue(reply['ok'])
        self.assertTrue(reply['applied'])
        self.assertEqual(self.backend.gains, [.25])
        self.assertEqual(self.manager._pending, [])
        self.assertEqual(self.manager._media_revision, before)

    def test_zero_is_valid_and_not_translated_to_pause(self):
        reply = self.send(0)
        self.assertEqual(reply['gain'], 0)
        self.assertEqual(self.manager._pending, [])

    def test_stale_track_volume_fails_closed(self):
        reply = self.send(.5, spotifyUri=URI2)
        self.assertFalse(reply['ok'])
        self.assertEqual(self.backend.gains, [])

    def test_stale_media_revision_fails_closed(self):
        reply = self.send(.5, revision=4)
        self.assertFalse(reply['ok'])
        self.assertEqual(self.backend.gains, [])

    def test_invalid_gain_does_not_update_latest_intent(self):
        original = self.manager._desired_gain
        for gain in (-.1, 1.1, 'not-a-gain'):
            self.assertFalse(self.send(gain)['ok'])
        self.assertEqual(self.manager._desired_gain, original)

    def test_inactive_audio_session_is_pending_not_a_provider_disconnect(self):
        self.backend.sessions = 0
        reply = self.send(.5)
        self.assertTrue(reply['ok'])
        self.assertFalse(reply['applied'])
        self.assertEqual(reply['status'], 'pending-session')
        self.assertEqual(self.manager._desired_gain, .5)
        self.assertEqual(self.manager._pending, [])

    def test_transient_backend_failure_keeps_latest_gain_for_route_worker(self):
        self.backend.raise_volume = True
        reply = self.send(.3)
        self.assertTrue(reply['ok'])
        self.assertFalse(reply['applied'])
        self.assertEqual(self.manager._desired_gain, .3)
        self.assertEqual(self.manager._pending, [])

    def test_stopped_embed_rejects_volume(self):
        self.manager._running = False
        self.assertFalse(self.send(.4)['ok'])

    def test_seek_coalesces_latest_intent_for_the_active_revision(self):
        first = self.manager.command({'action': 'seek', 'payload': {
            'seconds': 12, 'spotifyUri': URI, 'revision': 5}}, 8765)
        second = self.manager.command({'action': 'seek', 'payload': {
            'seconds': 48, 'spotifyUri': URI, 'revision': 5}}, 8765)
        self.assertTrue(first['ok'] and second['ok'])
        seeks = [command for command in self.manager._pending if command['action'] == 'seek']
        self.assertEqual(len(seeks), 1)
        self.assertEqual(seeks[0]['seconds'], 48)

    def test_seek_rejects_stale_song_and_revision(self):
        wrong_song = self.manager.command({'action': 'seek', 'payload': {
            'seconds': 9, 'spotifyUri': URI2, 'revision': 5}}, 8765)
        stale = self.manager.command({'action': 'seek', 'payload': {
            'seconds': 9, 'spotifyUri': URI, 'revision': 4}}, 8765)
        self.assertFalse(wrong_song['ok'])
        self.assertFalse(stale['ok'])
        self.assertEqual(self.manager._pending, [])

    def test_real_playing_position_reconciles_waiting_autoplay_status(self):
        self.manager._nonce = 'S' * 40
        self.manager._status = 'cable-routed'
        self.manager._autoplay_status = 'waiting-for-new-card'
        self.manager._last_position_at = time.monotonic() - 1
        self.manager._last_progress_position = 1
        reply = self.manager.event({'session': self.manager._nonce, 'kind': 'position',
            'revision': 5, 'playingURI': URI, 'currentTime': 2, 'duration': 100, 'paused': False})
        self.assertTrue(reply['ok'])
        self.assertEqual(self.manager._autoplay_status, 'waiting-for-new-card',
                         'one advancing callback does not establish verified sustained playback')
        self.manager._last_position_at = time.monotonic() - 1.1
        confirmed = self.manager.event({'session': self.manager._nonce, 'kind': 'position',
            'revision': 5, 'playingURI': URI, 'currentTime': 3, 'duration': 100, 'paused': False})
        self.assertTrue(confirmed['ok'])
        self.assertEqual(self.manager._autoplay_status, 'confirmed')
        self.assertIn('confirmed', self.manager._message)

    def test_provider_play_failure_is_revision_owned_and_cleared_by_verified_playback(self):
        self.manager._nonce = 'S' * 40
        self.manager._status = 'cable-routed'
        failed = self.manager.event({'session': self.manager._nonce, 'kind': 'play-failed',
            'revision': 5, 'playingURI': URI})
        self.assertTrue(failed['ok'])
        self.assertEqual(self.manager.status()['failure']['revision'], 5)
        self.assertFalse(self.manager.status()['failure']['terminal'],
                         'provider autoplay error alone must not skip a valid track')
        self.manager._last_position_at = time.monotonic() - 1.1
        self.manager._last_progress_position = 1
        played = self.manager.event({'session': self.manager._nonce, 'kind': 'position',
            'revision': 5, 'playingURI': URI, 'currentTime': 2, 'duration': 100, 'paused': False})
        self.assertTrue(played['ok'])
        self.assertEqual(self.manager.status()['failure']['revision'], 5,
                         'one advancing callback is insufficient to clear an unverified failure')
        self.manager._last_position_at = time.monotonic() - 1.1
        recovered = self.manager.event({'session': self.manager._nonce, 'kind': 'position',
            'revision': 5, 'playingURI': URI, 'currentTime': 3, 'duration': 100, 'paused': False})
        self.assertTrue(recovered['ok'])
        self.assertEqual(self.manager.status()['failure']['revision'], -1)
        self.assertFalse(self.manager.status()['failure']['terminal'])

    def test_verified_owned_route_survives_zero_active_sessions(self):
        self.assertTrue(_assigned_route_is_still_safe(self.manager, {123:44.0}, [], SimpleNamespace(id='VB-CABLE')))

    def test_active_session_on_wrong_endpoint_is_not_safe(self):
        self.assertFalse(_assigned_route_is_still_safe(self.manager, {123:44.0}, [(123, 'SPEAKERS', None)], SimpleNamespace(id='VB-CABLE')))

    def test_new_owned_pid_active_on_wrong_endpoint_is_not_safe(self):
        self.assertFalse(_assigned_route_is_still_safe(
            self.manager, {123:44.0, 456:55.0},
            [(456, 'SPEAKERS', None)], SimpleNamespace(id='VB-CABLE')))

    def test_wrong_persisted_endpoint_is_not_safe(self):
        self.backend.endpoint = 'SPEAKERS'
        self.assertFalse(_assigned_route_is_still_safe(self.manager, {123:44.0}, [], SimpleNamespace(id='VB-CABLE')))

    def test_pid_reuse_cannot_inherit_route_safety(self):
        self.assertFalse(_assigned_route_is_still_safe(self.manager, {123:99.0}, [], SimpleNamespace(id='VB-CABLE')))

    def test_lost_process_cannot_inherit_route_safety(self):
        self.assertFalse(_assigned_route_is_still_safe(self.manager, {}, [], SimpleNamespace(id='VB-CABLE')))

    def _simulate_route_worker(self, lose_endpoint=False, restore_session=False):
        backend = MockBackend()
        backend.resolve = lambda unused: SimpleNamespace(id='VB-CABLE', name='VB-CABLE')
        manager = SimpleNamespace(
            _backend_factory=lambda: backend, _lock=RLock(), _generation=1, _running=True,
            _profile_path='owned', _process_finder=lambda unused: {123:44.0},
            _routes={}, _applied_gain={}, _state={'paused':False},
            _status='opening', _message='', _desired_gain=.7,
            _seq=0, _pending=[], _started=0)
        manager._record = lambda *args, **kw: None
        calls = [0]
        def discover(_backend, _owned):
            calls[0] += 1
            return [(123, 'VB-CABLE', None)] if calls[0] <= 2 or (restore_session and calls[0] in (5, 6)) else []
        manager._session_finder = discover
        ticks = [0]
        def tick(_seconds):
            ticks[0] += 1
            if ticks[0] == 1 and lose_endpoint:
                backend.endpoint = 'SPEAKERS'
            if ticks[0] == (3 if restore_session else 2):
                manager._running = False
        with patch.object(route.time, 'sleep', tick):
            route.run_route(manager, 1, 'sd:7')
        return manager, backend

    def test_real_route_worker_does_not_queue_pause_during_muted_gap(self):
        manager, backend = self._simulate_route_worker()
        self.assertEqual(manager._status, 'route-pending')
        self.assertEqual(manager._pending, [])
        self.assertEqual(manager._applied_gain, {}, 'stale session gain receipt must be cleared')
        self.assertIn('waiting for audio session', manager._message)

    def test_session_reappearing_under_same_pid_reapplies_gain(self):
        manager, backend = self._simulate_route_worker(restore_session=True)
        self.assertEqual(manager._pending, [])
        self.assertEqual(manager._status, 'cable-routed')
        self.assertEqual(backend.gains, [.7, .7])

    def test_real_route_worker_pauses_on_actual_endpoint_mismatch(self):
        manager, backend = self._simulate_route_worker(lose_endpoint=True)
        self.assertEqual(manager._status, 'route-pending')
        self.assertEqual([cmd['action'] for cmd in manager._pending], ['pause'])


if __name__ == '__main__':
    unittest.main()
