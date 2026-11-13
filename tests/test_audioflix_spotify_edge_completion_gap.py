"""No-device regression: Official Embed Ended after verified Windows session gap."""
import time
import unittest
from threading import RLock
from types import SimpleNamespace
from unittest.mock import patch
from server_modules.audioflix_spotify_edge import EdgeSpotifyManager
from server_modules import audioflix_spotify_edge_route as route
from server_modules import audioflix_spotify_edge_session as session

URI = 'spotify:track:' + 'A' * 22
OTHER = 'spotify:track:' + 'B' * 22
NONCE = 'fixture-end-of-track-session'


def completed_manager(status='route-pending', safe=True):
    m = EdgeSpotifyManager(process_finder=lambda _: {123: 44.0})
    m._running, m._nonce, m._uri = True, NONCE, URI
    m._media_revision, m._status, m._route_completion_safe = 7, status, safe
    m._near_end_seen = True
    m._near_end_at = time.monotonic() - 0.4
    m._end_played_progress = 2.5
    m._state = {'paused': True, 'currentTime': 184., 'duration': 184., 'ended': False}
    m._manual_pause_revision = -1
    return m


def ended(m, **extra):
    data = {'session': NONCE, 'revision': 7, 'kind': 'ended', 'playingURI': URI}
    data.update(extra)
    return m.event(data)


class EndedTests(unittest.TestCase):
    def test_routed_still_completes(self):
        m = completed_manager('cable-routed', safe=False)
        self.assertTrue(ended(m)['ok'])
        self.assertEqual(m.status()['endedRevision'], 7)
    def test_safe_muted_gap_completes_exactly_once(self):
        m = completed_manager()
        self.assertTrue(ended(m)['ok'])
        self.assertTrue(m.status()['state']['ended'])
        self.assertTrue(ended(m)['duplicate'])
    def test_unverified_gap_rejected(self):
        self.assertFalse(ended(completed_manager(safe=False))['ok'])
    def test_never_routed_rejected(self):
        self.assertFalse(ended(completed_manager('opening'))['ok'])
    def test_route_error_rejected(self):
        self.assertFalse(ended(completed_manager('route-error'))['ok'])
    def test_manual_pause_rejected(self):
        m = completed_manager(); m._manual_pause_revision = 7
        self.assertFalse(ended(m)['ok'])
    def test_stale_near_end_rejected(self):
        m = completed_manager(); m._near_end_at = time.monotonic() - 13
        self.assertFalse(ended(m)['ok'])
    def test_insufficient_progress_rejected(self):
        m = completed_manager(); m._end_played_progress = 0.5
        self.assertFalse(ended(m)['ok'])
    def test_identity_and_generation_rejected(self):
        m = completed_manager()
        for reply in (ended(m, playingURI=OTHER), ended(m, revision=6), ended(m, playingURI='')):
            self.assertFalse(reply['ok'])
        self.assertEqual(m.status()['endedRevision'], -1)
    def test_reset_revokes_witness(self):
        m = completed_manager(); session.reset_progress(m)
        self.assertFalse(m._route_completion_safe)
        self.assertFalse(m._near_end_seen)
        self.assertFalse(ended(m)['ok'])


class Backend:
    def __init__(self): self.endpoint = 'VB-CABLE'
    def resolve(self, value): return SimpleNamespace(id='VB-CABLE', name='VB-CABLE')
    def get(self, pid): return self.endpoint
    def set(self, pid, endpoint): self.endpoint = endpoint
    def volume(self, pid, gain, endpoint): return 1


def route_gap(unsafe):
    b = Backend()
    m = SimpleNamespace(_backend_factory=lambda: b, _lock=RLock(), _generation=1,
        _running=True, _profile_path='owned-fixture', _process_finder=lambda _: {123: 44.},
        _routes={}, _applied_gain={}, _route_completion_safe=False,
        _status='opening', _message='', _desired_gain=.7, _seq=0, _pending=[],
        _started=time.time(), _state={'paused': True})
    m._record = lambda *args, **kwargs: None
    calls = [0]
    def sessions(_backend, _owned):
        calls[0] += 1
        return [(123, 'VB-CABLE', None)] if calls[0] <= 2 else []
    m._session_finder = sessions
    ticks = [0]
    def tick(_seconds):
        ticks[0] += 1
        if ticks[0] == 1 and unsafe: b.endpoint = 'SPEAKERS'
        if ticks[0] == 2: m._running = False
    with patch.object(route.time, 'sleep', tick):
        route.run_route(m, 1, 'sd:7')
    return m


class RoutingTests(unittest.TestCase):
    def test_muted_gap_retains_exact_owned_endpoint(self):
        m = route_gap(False)
        self.assertEqual(m._status, 'route-pending')
        self.assertTrue(m._route_completion_safe)
        self.assertEqual(m._pending, [])
    def test_endpoint_mismatch_clears_route_safety(self):
        m = route_gap(True)
        self.assertEqual(m._status, 'route-pending')
        self.assertFalse(m._route_completion_safe)

if __name__ == '__main__': unittest.main()
