"""Deterministic Audioflix global-hotkey lifecycle contract."""

import base64
import pathlib
import queue
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[2]))
from server_modules import audioflix_hotkeys as hotkeys


class _Samples:
    def astype(self, _kind):
        return self

    def __truediv__(self, _value):
        return self


class _Numpy:
    @staticmethod
    def frombuffer(_data, dtype=None):
        assert dtype == '<i2'
        return _Samples()


class _User32:
    def __init__(self):
        self.registered = set()

    def RegisterHotKey(self, _window, hotkey_id, _mods, virtual_key):
        if virtual_key == hotkeys._VK['x']:
            return False
        self.registered.add(hotkey_id)
        return True

    def UnregisterHotKey(self, _window, hotkey_id):
        self.registered.discard(hotkey_id)
        return True


class _ImmediateQueue:
    def __init__(self, user32):
        self.user32 = user32

    def put(self, command):
        hotkeys._apply(self.user32, command)


class _Player:
    def __init__(self):
        self.cleared = []
        self.added = []

    def clear_voices(self, voice_id):
        self.cleared.append(voice_id)

    def add_voice(self, samples, voice_id, volume):
        self.added.append((samples, voice_id, volume))


def _payload(sound_combos, bypass='ctrl+shift+b'):
    pcm = base64.b64encode(b'\x00\x00').decode('ascii')
    return {'deviceId': 'default', 'sampleRate': 48000, 'bypassCombo': bypass,
            'bindings': [{'combo': combo, 'audio': pcm, 'voiceId': f'hk:{index}'}
                         for index, combo in enumerate(sound_combos)]}


def _reset():
    hotkeys._bindings.clear()
    hotkeys._next_id[0] = 1
    hotkeys._bypass_id[0] = 0
    hotkeys._bypass_combo[0] = None
    hotkeys._bypassed[0] = False
    hotkeys._bypass_ok[0] = None
    hotkeys._last_fired.clear()
    hotkeys._last_error.clear()
    hotkeys._ready.set()


def main():
    original = (hotkeys.np, hotkeys.available, hotkeys._ensure_thread, hotkeys._cmd_q,
                hotkeys._wake, hotkeys.audioflix_bridge_playback._player_for)
    user32 = _User32()
    player = _Player()
    try:
        _reset()
        hotkeys.print = lambda *_args, **_kwargs: None
        hotkeys.np = _Numpy()
        hotkeys.available = lambda: True
        hotkeys._ensure_thread = lambda: None
        hotkeys._cmd_q = _ImmediateQueue(user32)
        hotkeys._wake = lambda: None
        hotkeys.audioflix_bridge_playback._player_for = lambda *_args: player

        armed = hotkeys.set_bindings(_payload(['u', 'ctrl+y']))
        assert armed['registered'] == ['u', 'ctrl+y']
        assert armed['bypassRegistered'] is True and armed['configured'] == 2
        first_id = next(iter(hotkeys._bindings))
        hotkeys._trigger(first_id)
        assert player.added and hotkeys.status()['lastFired']['combo'] == 'u'
        assert hotkeys.status()['lastError'] is None

        manual = hotkeys.set_bypassed({'bypassed': True})
        assert manual['bypassed'] is True
        manual_refresh = hotkeys.set_bindings(_payload(['u'], bypass=''))
        assert manual_refresh['bypassed'] is True and manual_refresh['registered'] == []
        assert manual_refresh['bypassRegistered'] is False
        assert hotkeys.set_bypassed({'bypassed': False})['bypassed'] is False

        hotkeys.set_bindings(_payload(['u', 'ctrl+y']))
        hotkeys._toggle_bypass()
        assert hotkeys.status()['bypassed'] is True
        refreshed = hotkeys.set_bindings(_payload(['u', 'ctrl+y']))
        assert refreshed['bypassed'] is True and refreshed['registered'] == []
        assert refreshed['configured'] == 2 and refreshed['bypassRegistered'] is True
        hotkeys._toggle_bypass()
        assert len([entry for entry in hotkeys.status()['bindings'] if entry['registered']]) == 2

        duplicate = hotkeys.set_bindings(_payload(['u', 'ctrl+u'], bypass='u'))
        assert duplicate['duplicates'] == ['u']
        assert duplicate['registered'] == ['ctrl+u'] and duplicate['bypassRegistered'] is True

        conflict = hotkeys.set_bindings(_payload(['x'], bypass=''))
        assert conflict['registered'] == [] and conflict['conflicted'] == ['x']
        assert conflict['bypassRegistered'] is False

        hotkeys.clear_all()
        cleared = hotkeys.status()
        assert cleared['configured'] == 0 and cleared['bypassCombo'] is None
        assert cleared['bypassed'] is False and cleared['bypassRegistered'] is False
    finally:
        del hotkeys.print
        hotkeys.np, hotkeys.available, hotkeys._ensure_thread, hotkeys._cmd_q, hotkeys._wake, hotkeys.audioflix_bridge_playback._player_for = original
        hotkeys._cmd_q = queue.Queue()
        _reset()
    print('AUDIOFLIX_HOTKEY_ENGINE_OK playbackOwner=true manualBypass=true preserveBypass=true duplicateFence=true conflictStatus=true')


if __name__ == '__main__':
    main()
