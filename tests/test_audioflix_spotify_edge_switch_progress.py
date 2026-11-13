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
        self._failure_revision = -1
        self._failure_kind = ''
        self._failure_reason = ''
        self._failure_terminal = False
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
        self.assertEqual(m._failure_revision, 1)
        self.assertEqual(m._failure_kind, 'provider-playback-unconfirmed')
        self.assertFalse(m._failure_terminal)
        self.assertEqual(m.records[-1][1]['retryUsed'], True)
    def test_initial_card_receives_the_same_bounded_retry(self):
        m = Session(); m._media_revision = 0
        response = {'ok': True, 'reason': 'EVE_UIA_INVOKED', 'playbackConfirmed': False}
        with patch('server_modules.audioflix_spotify_edge_window.try_card_play', return_value=response) as uia, \
             patch.object(lifecycle.time, 'sleep', lambda _: None):
            lifecycle.attempt_card_play(m, 4, None, 0)
        self.assertEqual(uia.call_count, 2)
        self.assertEqual(m._failure_revision, 0)
        self.assertFalse(m._failure_terminal)
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
        self.assertEqual(m._failure_kind, 'host-control-unavailable')
        self.assertFalse(m._failure_terminal)
    def test_manual_pause_before_first_attempt_is_not_invoked(self):
        m = Session(); m._manual_pause_revision = 1
        with patch('server_modules.audioflix_spotify_edge_window.try_card_play') as uia:
            lifecycle.attempt_card_play(m, 4, 1, 0)
        uia.assert_not_called()


class StartupWatchdog(unittest.TestCase):
    def test_hidden_callback_deadlock_claims_one_exact_attempt(self):
        m = Session(); m._autoplay_attempted_revision = -1
        with patch.object(lifecycle, 'attempt_card_play') as attempt, \
             patch.object(lifecycle.time, 'sleep', lambda _: None):
            lifecycle.watch_playback_start(m, 4, 1, 0, 0)
        attempt.assert_called_once_with(m, 4, 1)
        self.assertTrue(any(row[0][0] == 'startup-watchdog-claimed' for row in m.records))

    def test_user_pause_and_superseded_revision_never_retry(self):
        for paused, revision in ((1, 1), (-1, 2)):
            m = Session(); m._manual_pause_revision = paused
            with patch.object(lifecycle, 'attempt_card_play') as attempt, \
                 patch.object(lifecycle.time, 'sleep', lambda _: None):
                lifecycle.watch_playback_start(m, 4, revision, 0, 0)
            attempt.assert_not_called()

    def test_callback_failure_is_nonterminal_until_watchdog(self):
        from server_modules import audioflix_spotify_edge_session as session
        m = Session(); m._nonce = 'owned-test'; m._uri = 'spotify:track:' + 'A' * 22
        with m._lock:
            result = session.event(m, {'session': 'owned-test', 'kind': 'play-failed',
                                       'revision': 1})
        self.assertTrue(result['ok'])
        self.assertEqual(m._failure_kind, 'provider-play-failed')
        self.assertFalse(m._failure_terminal)

    def test_false_playing_at_zero_never_marks_startup_confirmed(self):
        from server_modules import audioflix_spotify_edge_session as session
        m = Session(); m._nonce = 'owned-test'; m._uri = 'spotify:track:' + 'A' * 22
        m._last_progress_position = None; m._end_played_progress = 0
        m._hide_progress_tick = -1; m._hide_pending = False
        m._last_hide_attempt_at = -999
        result = session.event(m, {'session': 'owned-test', 'kind': 'position',
                                   'revision': 1, 'playingURI': m._uri,
                                   'currentTime': 0, 'duration': 180, 'paused': False})
        self.assertTrue(result['ok'])
        self.assertNotEqual(m._autoplay_status, 'confirmed')
        self.assertEqual(m._confirmed_progress, 0)

    def test_routed_advancing_progress_confirms_and_clears_failure(self):
        from server_modules import audioflix_spotify_edge_session as session
        m = Session(); m._nonce = 'owned-test'; m._uri = 'spotify:track:' + 'A' * 22
        m._last_progress_position = 0.5; m._end_played_progress = 0
        m._hide_progress_tick = -1; m._hide_pending = False
        m._last_hide_attempt_at = -999
        m._failure_revision = 1; m._failure_kind = 'provider-play-failed'
        m._failure_terminal = False
        for i in range(3):
            m._last_position_at = time.monotonic() - 1.0
            result = session.event(m, {'session': 'owned-test', 'kind': 'position',
                                       'revision': 1, 'playingURI': m._uri,
                                       'currentTime': 1.5 + i, 'duration': 180, 'paused': False})
            self.assertTrue(result['ok'])
        self.assertEqual(m._autoplay_status, 'confirmed')
        self.assertEqual(m._failure_revision, -1)
        self.assertEqual(m._failure_kind, '')

    def test_background_resumed_position_uses_current_callback_freshness(self):
        from server_modules import audioflix_spotify_edge_session as session
        m = Session(); m._nonce = 'owned-test'; m._uri = 'spotify:track:' + 'A' * 22
        m._last_progress_position = 2.0
        m._confirmed_progress = 1.9
        m._last_position_at = time.monotonic() - 4.0  # previous callback was throttled
        m._end_played_progress = 0
        m._hide_progress_tick = -1; m._hide_pending = False
        m._last_hide_attempt_at = -999
        result = session.event(m, {'session': 'owned-test', 'kind': 'position',
                                   'revision': 1, 'playingURI': m._uri,
                                   'currentTime': 3.0, 'duration': 180, 'paused': False})
        self.assertTrue(result['ok'])
        self.assertEqual(m._autoplay_status, 'confirmed',
                         'current valid routed progress must not be judged by the stale prior timestamp')
        self.assertLess(time.monotonic() - m._last_position_at, 2.0)

    def test_confirmed_playback_survives_later_watchdog_checks(self):
        m = Session(); m._autoplay_attempted_revision = 1
        m._autoplay_status = 'confirmed'
        with patch.object(lifecycle, 'attempt_card_play') as attempt, \
             patch.object(lifecycle.time, 'sleep', lambda _: None):
            lifecycle.watch_playback_start(m, 4, 1, 0, 0)
        attempt.assert_not_called()
        self.assertFalse(m._failure_terminal)

    def test_unclaimed_stall_becomes_exact_non_unavailable_terminal(self):
        m = Session(); m._autoplay_attempted_revision = 1
        with patch.object(lifecycle.time, 'sleep', lambda _: None):
            lifecycle.watch_playback_start(m, 4, 1, 0, 0)
        self.assertEqual(m._failure_revision, 1)
        self.assertEqual(m._failure_kind, 'provider-start-timeout')
        self.assertTrue(m._failure_terminal)


class NativeVolumeOwner(unittest.TestCase):
    def test_timestamp_is_defined_for_spotify_diagnostics(self):
        from datetime import datetime
        from server_modules.audioflix_spotify_edge import _timestamp
        self.assertTrue(datetime.fromisoformat(_timestamp()))

    def test_native_gain_dispatch_preserves_revision_and_owner(self):
        from server_modules.audioflix_spotify_edge import EdgeSpotifyManager
        updates = []
        backend = SimpleNamespace(volume=lambda pid, gain, endpoint: updates.append((pid, gain, endpoint)) or 1)
        owner = EdgeSpotifyManager(process_finder=lambda _: {444: 10.0})
        owner._running = True
        owner._uri = 'spotify:track:' + 'A' * 22
        owner._media_revision = 3
        owner._profile_path = 'owned-profile'
        owner._routes = {444: (10.0, 'default')}
        owner._backend = backend
        owner._target = 'sd:7'
        self.assertFalse(owner.command({'action':'volume','payload':{
            'spotifyUri': owner._uri, 'revision': 2, 'gain': 0.4}}, 8765)['ok'])
        self.assertFalse(owner.command({'action':'volume','payload':{
            'spotifyUri': 'spotify:track:' + 'B'*22, 'revision': 3, 'gain':0.4}}, 8765)['ok'])
        self.assertEqual(updates, [])
        result = owner.command({'action':'volume','payload':{
            'spotifyUri': owner._uri, 'revision': 3, 'gain': 0.4}}, 8765)
        self.assertTrue(result['ok'])
        self.assertEqual(result['status'],'applied')
        self.assertEqual(updates, [(444, 0.4, 'sd:7')])
        self.assertEqual(owner._applied_gain[444], 0.4)
        self.assertEqual(owner._desired_gain, 0.4)

    def test_missing_running_owner_rejects_gain(self):
        from server_modules.audioflix_spotify_edge_session import volume_command
        self.assertFalse(volume_command(SimpleNamespace(_running=False), {'gain':0.5})['ok'])


if __name__ == '__main__': unittest.main()
