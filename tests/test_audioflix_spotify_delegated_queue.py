"""Hermetic broker lease probes: background engine keeps advancing with zero page callbacks."""
import threading
import time
import unittest
from unittest.mock import patch

from server_modules import audioflix_spotify_queue_lease as queue_mod

IDS = ['4cOdK2wGLETKBW3PvgPWqT', '5cOdK2wGLETKBW3PvgPWqT', '6cOdK2wGLETKBW3PvgPWqT']


def plan():
    return [{'spotifyUri': f'spotify:track:{spotify_id}', 'mediaType': 'track',
             'spotifyId': spotify_id, 'itemId': f'music-{i}', 'title': f'Song {i}',
             'duration': 25, 'effectiveVolume': 0.75} for i, spotify_id in enumerate(IDS)]


class FakeEngine:
    def __init__(self):
        self.state = {'spotifyUri': f'spotify:track:{IDS[0]}', 'generation': 17,
                      'status': 'playing', 'ended': False, 'completionId': ''}
        self.reachable = True
        self.calls = 0

    def status(self):
        return {'helperReachable': self.reachable, 'transport': dict(self.state)}

    def end(self):
        self.state.update(status='ended', ended=True,
                          completionId=f"{self.state['generation']}:{self.calls + 1}")


class FakeBroker:
    def __init__(self, engine):
        self._lock = threading.RLock()
        self._transport_lock = threading.RLock()
        self._clients = {'owner': {'clientId': 'owner', 'connectionId': 'conn-1',
                                    'detached': False, 'lastSeen': time.monotonic()}}
        self._owner_client_id = 'owner'
        self._engine_epoch = 4
        self._latest_intent = ('owner', 7)
        self._running_intent = None
        self._transport_busy = False
        self.engine = engine
        self.play_count = 0
        self.fail_next = False

    def _sync_engine_epoch_locked(self, status):
        if status.get('epochChanged'):
            self._engine_epoch += 1

    def _execute_transport(self, client_id, action, args, server_origin, connection_id):
        assert client_id == 'owner' and action == 'play' and connection_id == 'conn-1'
        self.play_count += 1
        if self.fail_next:
            return {'ok': False, 'timeout': True, 'reason': 'Unconfirmed helper transport.'}
        self.engine.state = {'spotifyUri': args['spotifyUri'],
                             'generation': self.engine.state['generation'] + 1,
                             'status': 'playing', 'ended': False, 'completionId': ''}
        return {'ok': True, 'engine': dict(self.engine.state)}


def until(predicate, seconds=2):
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(.01)
    return predicate()


class DelegationTests(unittest.TestCase):
    def setUp(self):
        self.engine = FakeEngine()
        self.broker = FakeBroker(self.engine)
        self.tick = patch.object(queue_mod, 'POLL_S', .01)
        self.tick.start()
        self.addCleanup(self.tick.stop)
        self.owner = queue_mod.DelegatedQueue(self.broker, self.engine)

    def arm(self, **extras):
        return self.owner.arm('owner', {'entries': plan(), 'index': 0, 'runId': 8, **extras}, 'conn-1')

    def test_three_natural_ends_advance_without_any_frontend_timer(self):
        self.assertTrue(self.arm()['ok'])
        self.engine.end()
        self.assertTrue(until(lambda: self.broker.play_count == 1))
        self.assertEqual(self.owner.projection('owner')['index'], 1)
        self.engine.end()
        self.assertTrue(until(lambda: self.broker.play_count == 2))
        self.assertEqual(self.owner.projection('owner')['index'], 2)
        self.engine.end()
        self.assertTrue(until(lambda: self.owner.projection('owner')['state'] == 'finished'))
        self.assertEqual(self.broker.play_count, 2)
        self.assertEqual(self.owner.projection('owner')['itemId'], 'music-2')

    def test_single_engine_completion_can_never_spawn_two_play_requests(self):
        self.assertTrue(self.arm()['ok'])
        self.engine.end()
        self.assertTrue(until(lambda: self.broker.play_count == 1))
        time.sleep(.08)
        self.assertEqual(self.broker.play_count, 1)

    def test_explicit_override_revokes_lease_and_never_replays_completion(self):
        self.assertTrue(self.arm()['ok'])
        self.owner.invalidate('owner', 'pause')
        self.engine.end()
        time.sleep(.06)
        self.assertEqual(self.broker.play_count, 0)
        self.assertEqual(self.owner.projection('owner')['state'], 'released')

    def test_helper_generation_change_fails_closed_without_play(self):
        self.assertTrue(self.arm()['ok'])
        self.engine.state['generation'] += 1
        self.engine.end()
        self.assertTrue(until(lambda: self.owner.projection('owner')['state'] == 'uncertain'))
        self.assertEqual(self.broker.play_count, 0)

    def test_unconfirmed_play_retains_uncertainty_and_does_not_retry(self):
        self.assertTrue(self.arm()['ok'])
        self.broker.fail_next = True
        self.engine.end()
        self.assertTrue(until(lambda: self.owner.projection('owner')['state'] == 'uncertain'))
        time.sleep(.05)
        self.assertEqual(self.broker.play_count, 1)

    def test_wrong_owner_grant_and_mixed_media_plan_refuse_delegation(self):
        self.broker._owner_client_id = 'other'
        self.assertFalse(self.arm()['ok'])
        self.broker._owner_client_id = 'owner'
        bad = plan()
        bad[1]['spotifyUri'] = 'https://example.net/music'
        self.assertFalse(self.arm(entries=bad)['ok'])
        self.assertIsNone(self.owner.projection('owner'))

    def test_fenced_new_intent_retires_lease(self):
        self.assertTrue(self.arm()['ok'])
        self.broker._latest_intent = ('owner', 12)
        self.engine.end()
        self.assertTrue(until(lambda: self.owner.projection('owner')['state'] == 'uncertain'))
        self.assertEqual(self.broker.play_count, 0)


if __name__ == '__main__':
    unittest.main()
