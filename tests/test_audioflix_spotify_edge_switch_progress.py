"""No-device regressions: same-window Spotify switch progress and bounded UIA retry."""
import time
import unittest
from threading import RLock
from types import SimpleNamespace
from unittest.mock import patch
from server_modules import audioflix_spotify_edge_lifecycle as lifecycle


class Session:
    def __init__(self):
        self._lock = RLock()
        self._running = True
        self._generation = 4
        self._media_revision = 1
        self._manual_pause_revision = -1
        self._state = {'paused': False, 'currentTime': 0., 'duration': 187., 'ended': False}
        self._status = 'cable-routed'
        self._confirmed_progress = 0.
        self._last_position_at = time.monotonic()
        self._hidden = True
        self._manual_show = False
        self._profile_path = 'owned-profile'
        self._window_id = 'W' * 22
        self._track_id = 'A' * 22
        self._process_finder = lambda _: {444: 1.0}
        self._autoplay_status = ''
        self._message = ''
        self.records = []
        self._record = lambda *args, **kwargs: self.records.append((args, kwargs))


def ready(m):
    m._state.update(paused=False, currentTime=2.9)
    m._confirmed_progress = 2.4
    m._last_position_at = time.monotonic()


class PlaybackProof(unittest.TestCase):
    def test_false_playing_flag_at_zero_is_not_proof(self):
        self.assertFalse(lifecycle._verified_progress(Session(), 1))
    def test_progress_and_correct_routing_are_proof(self):
        m = Session(); ready(m)
        self.assertTrue(lifecycle._verified_progress(m, 1))
    def test_wrong_revision_not_proof(self):
        m = Session(); ready(m)
        self.assertFalse(lifecycle._verified_progress(m, 0))
    def test_ended_or_route_pending_not_proof(self):
        m = Session(); ready(m); m._status = 'route-pending'
        self.assertFalse(lifecycle._verified_progress(m, 1))
        m._status = 'cable-routed'; m._state['paused'] = True
        self.assertFalse(lifecycle._verified_progress(m, 1))
    def test_stale_position_not_proof(self):
        m = Session(); ready(m); m._last_position_at -= 4.5
        self.assertFalse(lifecycle._verified_progress(m, 1))
    def test_progress_not_enough_at_one_second(self):
        m = Session(); m._confirmed_progress = 1.8; m._state['currentTime'] = 2.2
        self.assertFalse(lifecycle._verified_progress(m, 1))


class RetrySafety(unittest.TestCase):
    def test_stuck_position_attempts_at_most_two_exact_owned_UIA_invocations(self):
        m = Session()
        response = {'ok': True, 'reason': 'EVE_UIA_INVOKED', 'playbackConfirmed': False}
        with patch('server_modules.audioflix_spotify_edge_window.try_card_play', return_value=response) as uia, \
             patch.object(lifecycle.time, 'sleep', lambda _: None):
            lifecycle.attempt_card_play(m, 4, 1, 0)
        self.assertEqual(uia.call_count, 2)
        self.assertEqual(m._autoplay_status, 'invoked-unconfirmed')
        self.assertEqual(m.records[-1][1]['retryUsed'], True)
    def test_verified_progress_skips_UIA(self):
        m = Session(); ready(m)
        with patch('server_modules.audioflix_spotify_edge_window.try_card_play') as uia:
            lifecycle.attempt_card_play(m, 4, 1, 0)
        uia.assert_not_called()
    def test_manual_pause_blocks_retry(self):
        m = Session()
        def first(_pids, _track, **kw):
            m._manual_pause_revision = 1
            return {'ok': True, 'reason': 'EVE_UIA_INVOKED', 'playbackConfirmed': False}
        with patch('server_modules.audioflix_spotify_edge_window.try_card_play', side_effect=first) as uia, \
             patch.object(lifecycle.time, 'sleep', lambda _: None):
            lifecycle.attempt_card_play(m, 4, 1, 0)
        self.assertEqual(uia.call_count, 1)
    def test_superseded_revision_blocks_retry(self):
        m = Session()
        def first(_pids, _track, **kw):
            m._media_revision = 2
            return {'ok': True, 'reason': 'EVE_UIA_INVOKED', 'playbackConfirmed': False}
        with patch('server_modules.audioflix_spotify_edge_window.try_card_play', side_effect=first) as uia, \
             patch.object(lifecycle.time, 'sleep', lambda _: None):
            lifecycle.attempt_card_play(m, 4, 1, 0)
        self.assertEqual(uia.call_count, 1)
        self.assertEqual(m._autoplay_status, '')
    def test_window_unavailable_is_not_retried(self):
        m = Session()
        with patch('server_modules.audioflix_spotify_edge_window.try_card_play', return_value={'ok': False, 'reason':'exact-edge-window-unavailable'}) as uia:
            lifecycle.attempt_card_play(m, 4, 1, 0)
        self.assertEqual(uia.call_count, 1)
        self.assertEqual(m._autoplay_status, 'manual-fallback')
    def test_manual_pause_before_first_attempt_is_not_invoked(self):
        m = Session(); m._manual_pause_revision = 1
        with patch('server_modules.audioflix_spotify_edge_window.try_card_play') as uia:
            lifecycle.attempt_card_play(m, 4, 1, 0)
        uia.assert_not_called()


if __name__ == '__main__': unittest.main()
