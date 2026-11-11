#!/usr/bin/env python3
"""Server-owned Piano owner, long-song staging and exact-route regressions."""
from __future__ import annotations
import base64
import sys
import tempfile
import time
from pathlib import Path
from unittest.mock import patch

import numpy as np
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
from server_modules import audioflix_piano_native as native
from server_modules import audioflix_piano_native_synth as synth

class Stream:
    active = True

class Player:
    def __init__(self):
        self.stream, self.sample_rate, self.voices = Stream(), 24000, {}
    def add_voice(self, samples, vid, vol, rate):
        self.voices[vid] = {'audio': samples, 'pos': 0, 'paused': False, 'volume': vol}
    def clear_voices(self, vid=None):
        found = vid in self.voices
        if vid is None: self.voices.clear()
        else: self.voices.pop(vid, None)
        return int(found)
    def voice_status(self, vid):
        v = self.voices.get(vid)
        if v is None: return None
        return {'currentTime': v['pos'] / self.sample_rate,
                'duration': len(v['audio']) / self.sample_rate, 'paused': v['paused']}
    def seek_voice(self, vid, seconds):
        if vid not in self.voices: return 0
        self.voices[vid]['pos'] = round(float(seconds) * self.sample_rate)
        return 1
    def set_voice_paused(self, vid, paused):
        if vid not in self.voices: return 0
        self.voices[vid]['paused'] = paused
        return 1
    def set_voice_volume(self, vid, vol):
        if vid not in self.voices: return 0
        self.voices[vid]['volume'] = vol
        return 1

def wait(receipt):
    auth = {key: receipt[key] for key in ('sessionId','sessionToken','ownerId','generation')}
    for _ in range(100):
        status = native.status(auth)
        if status['state'] != 'rendering': return auth, status
        time.sleep(.004)
    raise AssertionError('native render did not finish')

def run():
    # Reuse the same WebAudioFont embedded samples, not an invented replacement bank.
    audio = base64.b64encode((np.arange(200, dtype='<i2') - 100).tobytes()).decode()
    zones = synth._zones_from_source("var piano={zones:[{keyRangeLow:0,keyRangeHigh:127,originalPitch:6000,sampleRate:24000,sample:'" + audio + "'}]};")
    assert len(zones)==1 and zones[0].encoding=='sample'
    song = {'duration_ms': 950, 'events': [{'at_ms': 0, 'duration_ms': 80, 'midi_notes':[60]},
                                             {'at_ms': 500, 'duration_ms': 60, 'midi_notes':[64]}]}
    player = Player()
    native._SESSIONS.clear(); native._ACTIVE_ID = ''
    base = {'ownerId': 'isolated-authorized-owner-123', 'generation': 1, 'deviceId': 'sd:7',
            'soundId':'acoustic_grand','sampleRate':24000,'volumePercent':0,'timeline':song}
    with patch.object(native, '_player_for', return_value=player), patch.object(native, 'render_timeline', return_value=np.zeros(24000,dtype='float32')) as render:
        receipt = native.start(base)
        auth, state = wait(receipt)
        assert state['state']=='playing' and state['deviceId']=='sd:7'
        assert render.call_args[0][2] == 0, 'zero volume was changed to 100'
        assert state['currentIndex']==1
        player.voices[receipt['sessionId']]['pos'] = 13000
        assert native.status(auth)['currentIndex']==2
        native.pause({**auth,'paused':True}); assert native.status(auth)['paused']
        native.pause({**auth,'paused':False}); assert not native.status(auth)['paused']
        native.seek({**auth,'seconds':.5}); assert native.status(auth)['currentTime'] == .5
        native.volume({**auth,'volume':.25}); assert player.voices[receipt['sessionId']]['volume']==.25
        try: native.status({**auth,'generation':2}); assert False
        except RuntimeError: pass
        try: native.start({**base,'ownerId':'different-owner-123'}); assert False
        except RuntimeError: pass
        receipt2=native.start({**base,'generation':2}); auth2,_=wait(receipt2)
        assert receipt['sessionId'] not in player.voices
        player.stream.active=False
        assert native.status(auth2)['state']=='error', 'device loss must fence Piano instead of rerouting'
        player.stream.active=True
        assert native.stop(auth2)['stopped']
    # A long song uses disk-backed PCM but keeps the entire timeline independent of Chromium.
    with tempfile.TemporaryDirectory() as folder:
        with patch.object(synth,'_CACHE',Path(folder)):
            long_song={'duration_ms':180000, 'events':[{'at_ms':0,'duration_ms':100,'midi_notes':[60]}]}
            result=synth.render_timeline(long_song,'legacy_synth',100,48000)
            assert isinstance(result,np.memmap), 'long song must use disk-backed PCM'
            assert len(result)>8_000_000 and np.max(np.abs(result[:10000]))>0
            path=Path(result.filename)
            del result
            path.unlink()
    print('AUDIOFLIX_PIANO_NATIVE_CONTINUATION_OK route=sd:7 owner=true memmap=true')
if __name__=='__main__': run()
