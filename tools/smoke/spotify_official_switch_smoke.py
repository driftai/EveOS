"""Read-only fake-owner switch/queue regression for Official Spotify Embed.
No Windows browser, login, audio or backend state is touched.
"""
from __future__ import annotations
import threading
import time
from pathlib import Path
import sys
sys.path.insert(0,str(Path(__file__).resolve().parents[2]))
from server_modules import audioflix_spotify_edge_session as session
from server_modules import audioflix_spotify_edge_lifecycle as lifecycle

checks = 0

def check(value, message):
    global checks
    assert value, message
    checks += 1

class Fake:
    def __init__(self):
        self._lock=threading.RLock();self._running=True
        self._status='cable-routed';self._uri='spotify:track:'+'A'*22
        self._media_revision=0;self._track_id='A'*22;self._nonce='test-session'
        self._requested_device_id='sd:7';self._desired_gain=1.0;self._applied_gain={}
        self._ended_revision=-1;self._near_end_seen=False;self._near_end_at=0.0
        self._end_played_progress=0;self._state={'paused':False,'currentTime':49,'duration':90,'ended':False}
        self._last_position_at=0.0;self._last_progress_position=49
        self._confirmed_progress=42.0;self._hide_progress_tick=8;self._hide_pending=False
        self._last_hide_attempt_at=-999;self._seq=0;self._pending=[]
        self._manual_pause_revision=-1;self._autoplay_attempted_revision=-1
        self._autoplay_status='confirmed';self._manual_show=False;self._hidden=False
        self._target_name='CABLE Input';self._routes={35568:(1.0,None)}
        self._last_position_at=0.0;self._generation=5
        self._started=time.time();self._autoplay_attempted=False
        self._window_id='B'*22;self._report=None
        self._record=lambda *a,**kw:None
    def _hide_threshold(self):return 38.0
    def status(self):return session.status(self)

obj=Fake()
b='spotify:track:'+'B'*22
c='spotify:track:'+'C'*22
x=session.switch_track(obj,{'spotifyUri':b,'deviceId':'sd:7','gain':0.4})
check(x['identity']==b and x['mediaRevision']==1,'switch identity and revision')
check(x['state']['paused'] is True and x['state']['currentTime']==0,'switch resets old playback progress')
check(x['state']['ended'] is False and x['endedRevision']==-1,'switch clears completion state')
check(len(obj._pending)==1 and obj._pending[0]['action']=='load','new song queued without Stop')
check(obj._autoplay_status=='waiting-for-new-card','autoplay state updated')
x=session.switch_track(obj,{'spotifyUri':c,'deviceId':'sd:7'})
check(x['mediaRevision']==2 and len(obj._pending)==1 and obj._pending[0]['uri']==c,'rapid second Play replaces previous load')
check(obj._routes.get(35568) is not None,'route survives switch')
x=session.switch_track(obj,{'spotifyUri':c,'deviceId':'sd:7'})
check(x['mediaRevision']==3 and x['identity']==c,'repeated URL still gets unique queue revision')
check(session.event(obj,{'session':'test-session','kind':'position','revision':2,
    'playingURI':b,'currentTime':9,'duration':120,'paused':False})['ok'] is False,
    'stale song event rejected')
started=[]
old=lifecycle.attempt_card_play
try:
    def attempt(*a,**kw):started.append((a,kw))
    lifecycle.attempt_card_play=attempt
    x=session.event(obj,{'session':'test-session','kind':'media-loaded','revision':3,'playingURI':c})
    check(x['ok'],'new song ready acknowledged')
    x=session.event(obj,{'session':'test-session','kind':'media-loaded','revision':3,'playingURI':c})
    check(x['ok'],'duplicate ready is idempotent')
    deadline=time.monotonic()+1
    while time.monotonic()<deadline and not started:time.sleep(.02)
    check(len(started)==1,'exactly one autoplay worker per revision')
finally:
    lifecycle.attempt_card_play=old
check(session.event(obj,{'session':'test-session','kind':'ended','revision':3,'playingURI':c})['ok'] is False,
      'no false queue advance without near-end progress')
refused = session.switch_track(obj, {'spotifyUri':b, 'deviceId':'sd:9'})
check(refused.get('ok') is False and 'Output endpoint changed' in refused.get('reason', ''),
      'wrong output explicitly refuses switch without Stop')
check(obj._uri == c and obj._media_revision == 3 and obj._pending[0]['uri'] == c,
      'wrong output preserves current song, pending load, and queue revision')
check(obj.status()['routeConfirmed'] is True,'existing native route remains confirmed')
source=Path('server/spotify-embed-edge.html').read_text(encoding='utf-8')
check(
    'for (let retry = 0; retry < 4 && expected === revision && requested === selectedUri; retry++)' in source
    and 'void acknowledgeLoadedMedia(awaiting)' in source
    and 'awaiting.uri === info.playingURI' in source
    and 'info.isBuffering !== true' in source,
    'new song acknowledgment retries require matching revision, URI, and nonbuffering media state')
check('completedRevision === revision' in source,'queue-end receipt revision fencing remains')
print(f'SPOTIFY_OFFICIAL_SWITCH_SMOKE_PASS {checks}')
