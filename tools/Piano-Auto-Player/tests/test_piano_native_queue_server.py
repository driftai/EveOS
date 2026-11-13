"""Executable fake-native tests. They do not access the real audio device or user library."""
import importlib.util
import pathlib
import sys
import threading
import time
import types
import unittest
from unittest.mock import patch

ROOT = pathlib.Path(__file__).resolve().parents[3]
native = types.ModuleType('server_modules.audioflix_piano_native')
native._LOCK = threading.RLock()
native._ACTIVE_ID = 'first'
entry = {'sessionId':'first','token':'secret','ownerId':'piano-owner-1234567890',
         'generation':1,'deviceId':'sd:7','soundId':'acoustic_grand','sampleRate':48000}
native._require = lambda payload: ('first', entry)
native._public = lambda value: {'sessionId':'first', 'ownerId':entry['ownerId'],
    'generation':1,'state':'playing'}
plays = []
flags = {'state': 'playing', 'current':'first'}
def status(payload):
    return {'state': flags['state'], 'sessionId':flags['current']}
def start(payload, queue_internal=False):
    assert queue_internal
    name=f'next-{len(plays)}'
    plays.append(payload)
    flags['state']='playing';flags['current']=name
    return {'sessionId':name, 'sessionToken':f'token-{name}',
            'ownerId':payload['ownerId'],'generation':payload['generation']}
native.status=status
native.start=start
package=types.ModuleType('server_modules')
package.__path__=[]
package.audioflix_piano_native=native
sys.modules['server_modules']=package
sys.modules['server_modules.audioflix_piano_native']=native
spec=importlib.util.spec_from_file_location('server_modules.audioflix_piano_queue', ROOT/'server_modules/audioflix_piano_queue.py')
queue=importlib.util.module_from_spec(spec)
sys.modules[spec.name]=queue
spec.loader.exec_module(queue)

class NativeQueueTests(unittest.TestCase):
    def setUp(self):
        queue.invalidate()
        plays.clear();flags.update(state='playing', current='first')
        queue._songs=lambda: {'a':{'id':'a','performance':[1]},'b':{'id':'b','performance':[2]},'c':{'id':'c','performance':[3]}}
        queue._timeline=lambda song, options: {'events':[{'at_ms':0,'key':'a'}], 'duration_ms':10}

    def auth(self):
        return {'sessionId':'first','sessionToken':'secret', 'ownerId':entry['ownerId'],'generation':1}

    def payload(self):
        return {**self.auth(), 'currentQueueId':'A', 'mode':'ordered',
                'transitionMs':250, 'loop':False,
                'items':[{'queueId':'A','songId':'a'},{'queueId':'B','songId':'b'}]}

    def test_begins_next_without_any_browser_timer(self):
        receipt=queue.arm(self.payload())
        self.assertTrue(receipt['active'])
        flags['state']='complete'
        until=time.time()+3
        while len(plays)<1 and time.time()<until: time.sleep(.03)
        self.assertEqual(len(plays),1)
        self.assertEqual(queue.status(self.auth())['currentQueueId'],'B')
        self.assertEqual(plays[0]['generation'],2)
        flags['state']='complete'
        until=time.time()+2
        while queue.status(self.auth())['active'] and time.time()<until: time.sleep(.03)
        self.assertFalse(queue.status(self.auth())['active'])
        self.assertEqual(len(plays),1)

    def test_stop_does_not_start_next_song(self):
        queue.arm(self.payload())
        queue.stop(self.auth())
        flags['state']='complete'
        time.sleep(.4)
        self.assertEqual(plays,[])

    def test_wrong_credentials_rejected(self):
        queue.arm(self.payload())
        with self.assertRaisesRegex(RuntimeError,'authorization'):
            queue.status({**self.auth(),'sessionToken':'wrong'})

    def test_duplicate_queue_id_rejected(self):
        bad=self.payload();bad['items'][1]['queueId']='A'
        with self.assertRaisesRegex(RuntimeError,'duplicated'):
            queue.arm(bad)

    def test_loop_returns_to_first_and_shuffled_loop_avoids_last(self):
        payload=self.payload(); payload['loop']=True
        queue.arm(payload)
        q=queue._QUEUE
        self.assertEqual(queue._choose(q)['songId'],'b')
        self.assertEqual(queue._choose(q)['songId'],'a')
        self.assertEqual(q['cycle'],1)
        q['mode']='shuffle';q['cursor']=len(q['entries'])-1
        last=q['currentQueueId']
        nxt=queue._choose(q)
        self.assertNotEqual(nxt['queueId'],last)
        self.assertEqual(q['cycle'],2)

    def test_update_requires_preserving_current(self):
        queue.arm(self.payload())
        with self.assertRaisesRegex(RuntimeError,'playing item'):
            queue.update({**self.auth(),'items':[{'queueId':'B','songId':'b'}]})
        self.assertEqual(queue.status(self.auth())['currentQueueId'],'A')

if __name__=='__main__': unittest.main(verbosity=2)
