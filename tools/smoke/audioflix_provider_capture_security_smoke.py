"""Provider capture size/channel/stop-vs-PCM regression, no physical device needed."""
import base64
import importlib
import pathlib
import sys
import threading
import time

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
p = importlib.import_module('server_modules.audioflix_provider_capture')
old = p._player_for, p.play_pcm, p.stop_stream
stops, plays = [], []
entered, release = threading.Event(), threading.Event()

class FakePlayer:
    class Stream:
        active = True
    stream = Stream()

try:
    p._SESSIONS.clear()
    p._player_for = lambda device, rate, channels, lane: FakePlayer()
    p.stop_stream = lambda payload: stops.append(payload) or {'ok': True}

    def playback(payload):
        entered.set()
        assert release.wait(5), 'PCM test gate timed out'
        plays.append(payload)
        return {'ok': True, 'deviceId': payload['deviceId'], 'queued': 4}

    p.play_pcm = playback
    session = p.start({'deviceId': 'sd:3', 'sampleRate': 48000, 'channels': 1})
    cred = {'sessionId': session['sessionId'], 'captureToken': session['captureToken']}
    audio = base64.b64encode(b'\x01\x00\x02\x00\x03\x00\x04\x00').decode('ascii')

    for payload, expected in [
        ({**cred, 'audio': audio, 'channels': 2}, 'channels'),
        ({**cred, 'audio': base64.b64encode(b'\x01' * 65538).decode(), 'channels': 1}, 'size'),
        ({**cred, 'audio': base64.b64encode(b'\x01\x00\x02').decode(), 'channels': 1}, 'alignment'),
    ]:
        try:
            p.chunk(payload)
            raise AssertionError(f'{expected} invalid payload accepted')
        except RuntimeError as err:
            assert 'PCM' in str(err), (expected, err)
    assert not plays, 'Invalid payload reached native output'

    chunk_result, stop_result = [], []
    chunk_thread = threading.Thread(target=lambda: chunk_result.append(p.chunk({**cred, 'audio': audio, 'channels': 1})))
    chunk_thread.start()
    assert entered.wait(3), 'PCM was not entered'
    stop_thread = threading.Thread(target=lambda: stop_result.append(p.stop(cred)))
    stop_thread.start()
    time.sleep(0.08)
    assert stop_thread.is_alive() and not stops, 'Stop did not wait for the in-flight PCM'
    release.set()
    chunk_thread.join(3)
    stop_thread.join(3)
    assert not chunk_thread.is_alive() and not stop_thread.is_alive(), 'Concurrent requests hung'
    assert len(plays) == 1 and len(stops) == 1 and stop_result[0]['stopped']
    assert chunk_result[0]['ok'] is True
    try:
        p.chunk({**cred, 'audio': audio})
        raise AssertionError('Chunk accepted after stop')
    except RuntimeError:
        pass
    print('AUDIOFLIX_PROVIDER_CAPTURE_SECURITY_OK bound=true frame_check=true stop_fence=true')
finally:
    release.set()
    p._SESSIONS.clear()
    p._player_for, p.play_pcm, p.stop_stream = old
