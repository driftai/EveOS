"""System-wide soundboard hotkeys (Windows).

The browser only gets key events while focused, so for hotkeys that fire while EveOS is
UNFOCUSED — you're on another website, another app, or in a game — the detection has to live
here in the long-running bridge process.

We use the official Win32 RegisterHotKey API rather than a low-level keyboard hook because it
is the recommended approach for background/global hotkeys: it is system-wide, only intercepts
the specific combos that are bound (it does NOT observe every keystroke like a hook), and is
markedly more stable for long-running use (low-level hooks can introduce system-wide input lag
over time). The OS posts WM_HOTKEY to our message-loop thread, which then plays the pre-decoded
clip through the soundboard mixer out to the selected bypass device (CABLE).

The client registers the selected Frontend group's bindings. Registration remains armed when
Audioflix closes, while changing the visible group deliberately replaces the active key set.
"""

import base64
import ctypes
from ctypes import wintypes
import queue
import threading
import time

from server_modules import audioflix_bridge_playback

try:
    import numpy as np
except Exception:  # pragma: no cover - numpy ships with the bridge's optional deps
    np = None

WM_HOTKEY = 0x0312
MOD_ALT, MOD_CONTROL, MOD_SHIFT, MOD_WIN, MOD_NOREPEAT = 0x0001, 0x0002, 0x0004, 0x0008, 0x4000


def _build_vk():
    vk = {}
    for c in range(ord('a'), ord('z') + 1):
        vk[chr(c)] = c - 32  # 'a' -> 0x41 (VK is the uppercase ascii code)
    for d in range(10):
        vk[str(d)] = 0x30 + d
    for f in range(1, 25):
        vk['f%d' % f] = 0x70 + (f - 1)
    vk.update({
        'space': 0x20, 'enter': 0x0D, 'return': 0x0D, 'tab': 0x09, 'esc': 0x1B, 'escape': 0x1B,
        'backspace': 0x08, 'delete': 0x2E, 'insert': 0x2D, 'home': 0x24, 'end': 0x23,
        'pageup': 0x21, 'pagedown': 0x22, 'up': 0x26, 'down': 0x28, 'left': 0x25, 'right': 0x27,
        ';': 0xBA, '=': 0xBB, ',': 0xBC, '-': 0xBD, '.': 0xBE, '/': 0xBF, '`': 0xC0,
        '[': 0xDB, '\\': 0xDC, ']': 0xDD, "'": 0xDE,
    })
    return vk


_VK = _build_vk()
_MODS = {'ctrl': MOD_CONTROL, 'control': MOD_CONTROL, 'shift': MOD_SHIFT,
         'alt': MOD_ALT, 'win': MOD_WIN, 'meta': MOD_WIN, 'super': MOD_WIN, 'cmd': MOD_WIN}

_lock = threading.Lock()
_configure_lock = threading.Lock()
_bindings = {}        # hk_id -> {samples, rate, device, vol, combo, ok}
_next_id = [1]
_cmd_q = queue.Queue()
_started = False
_ready = threading.Event()      # set once the message-loop thread is up
_loop_tid = [0]                 # native id of the loop thread (for PostThreadMessage wakeups)
_triggers = [0]                 # diagnostic: how many times any hotkey has fired
_last_fired = {}                # {vid, combo, at} of the most recent hotkey -> on-site flash feedback
_last_error = {}                # latest playback failure, exposed without requiring console access
# Bypass toggle: a user-set combo that suspends/re-arms ALL sound hotkeys so the keys pass
# through for typing/use mid-game, then toggles them back on. Lives server-side so it works
# while EveOS is unfocused. The bypass key itself stays registered while suspended.
_bypass_id = [0]                # hk_id of the bypass toggle combo (0 = none)
_bypass_combo = [None]          # the bypass combo string (for status/UI)
_bypassed = [False]             # True = sound hotkeys currently suspended (typing mode)
_bypass_ok = [None]             # RegisterHotKey result for the bypass combo


def available():
    return np is not None and hasattr(ctypes, 'windll')


def _wake():
    # Nudge the blocking GetMessage loop so it processes newly queued register/unregister cmds.
    if _loop_tid[0]:
        try:
            ctypes.windll.user32.PostThreadMessageW(_loop_tid[0], 0x0000, 0, 0)  # WM_NULL
        except Exception:
            pass


def _parse_combo(combo):
    """'ctrl+y' / 'shift+t' / 'f5' / 'y' -> (modifier_flags, vk), else None.

    RegisterHotKey allows modifiers + exactly ONE non-modifier key. Two plain keys like 'y+t'
    aren't expressible, so reject them (return None -> reported in 'skipped') instead of
    silently registering just the last key."""
    parts = [p.strip().lower() for p in str(combo or '').split('+') if p.strip()]
    mods, vk, mainkeys = 0, None, 0
    for p in parts:
        if p in _MODS:
            mods |= _MODS[p]
        else:
            mainkeys += 1
            vk = _VK.get(p)
    if vk is None or mainkeys != 1:
        return None
    return mods, vk


def _trigger(hk_id):
    with _lock:
        b = _bindings.get(hk_id)
    if not b:
        return
    _triggers[0] += 1
    try:
        # Deterministic voice id (the client sends 'hk:<soundId>') so the soundboard Stop
        # button can clear a hotkey-triggered instance; falls back to the hotkey numeric id.
        vid = b.get('vid') or ('hotkey-%d' % hk_id)
        used_device = b['device']
        try:
            player = audioflix_bridge_playback._player_for(used_device, b['rate'], 1)
        except Exception:
            if used_device == 'default':
                raise
            used_device = 'default'
            player = audioflix_bridge_playback._player_for(used_device, b['rate'], 1)
        player.clear_voices(vid)            # replace a still-playing instance of this key
        player.add_voice(b['samples'], vid, b['vol'])
        _last_fired.update({'vid': vid, 'combo': b.get('combo'), 'deviceId': used_device, 'at': time.time()})
        _last_error.clear()
    except Exception as e:
        _last_error.update({'vid': b.get('vid'), 'combo': b.get('combo'), 'message': str(e), 'at': time.time()})
        print(f"[Hotkey Engine] playback error for id={hk_id}: {e}", flush=True)


def _set_bypass_state(desired):
    """Idempotently apply bypass through the one native registration owner."""
    with _lock:
        desired = bool(desired)
        if _bypassed[0] == desired:
            return False
        _bypassed[0] = desired
        items = list(_bindings.items())
    if _bypassed[0]:
        for hk_id, _b in items:
            _cmd_q.put(('unregister', hk_id))
    else:
        for hk_id, b in items:
            if b.get('vk') is not None:
                _cmd_q.put(('register', hk_id, b.get('mods', 0), b['vk']))
    _wake()
    print(f"[Hotkey Engine] bypass set -> {_bypassed[0]}", flush=True)
    return True


def _toggle_bypass():
    """Toggle bypass from WM_HOTKEY while retaining the same registration owner."""
    _set_bypass_state(not _bypassed[0])


def _apply(user32, cmd):
    kind = cmd[0]
    if kind == 'register':
        _, hk_id, mods, vk = cmd
        # MOD_NOREPEAT so holding the combo fires once, not on every auto-repeat.
        ok = bool(user32.RegisterHotKey(None, hk_id, mods | MOD_NOREPEAT, vk))
        with _lock:
            if hk_id == _bypass_id[0]:
                _bypass_ok[0] = ok
            elif hk_id in _bindings:
                _bindings[hk_id]['ok'] = ok
        print(f"[Hotkey Engine] RegisterHotKey id={hk_id} mods={mods} vk={vk} -> {ok}", flush=True)
    elif kind == 'unregister':
        _, hk_id = cmd
        try:
            user32.UnregisterHotKey(None, hk_id)
        except Exception:
            pass


def _loop():
    user32 = ctypes.windll.user32
    _loop_tid[0] = ctypes.windll.kernel32.GetCurrentThreadId()
    user32.RegisterHotKey.argtypes = [ctypes.c_void_p, ctypes.c_int, wintypes.UINT, wintypes.UINT]
    user32.RegisterHotKey.restype = wintypes.BOOL
    user32.UnregisterHotKey.argtypes = [ctypes.c_void_p, ctypes.c_int]
    user32.UnregisterHotKey.restype = wintypes.BOOL
    user32.GetMessageW.argtypes = [ctypes.c_void_p, ctypes.c_void_p, wintypes.UINT, wintypes.UINT]
    user32.GetMessageW.restype = ctypes.c_int
    user32.PostThreadMessageW.argtypes = [wintypes.DWORD, wintypes.UINT, ctypes.c_void_p, ctypes.c_void_p]
    user32.PostThreadMessageW.restype = wintypes.BOOL
    msg = wintypes.MSG()
    user32.PeekMessageW(ctypes.byref(msg), 0, 0, 0, 0)  # force-create this thread's message queue
    _ready.set()
    print("[Hotkey Engine] RegisterHotKey message loop started", flush=True)
    while True:
        try:
            while True:
                _apply(user32, _cmd_q.get_nowait())
        except queue.Empty:
            pass
        # Blocking GetMessage; RegisterHotKey posts WM_HOTKEY here. Woken by _wake() on new cmds.
        r = user32.GetMessageW(ctypes.byref(msg), 0, 0, 0)
        if r in (0, -1):
            continue
        if msg.message == WM_HOTKEY:
            hk = int(msg.wParam)
            if hk and hk == _bypass_id[0]:
                _toggle_bypass()
            else:
                _trigger(hk)
        else:
            user32.TranslateMessage(ctypes.byref(msg))
            user32.DispatchMessageW(ctypes.byref(msg))


def _ensure_thread():
    global _started
    if _started:
        return
    _started = True
    threading.Thread(target=_loop, daemon=True, name='audioflix-hotkeys').start()


def _clear_registrations(reset_bypass=True):
    with _lock:
        ids = list(_bindings.keys())
        _bindings.clear()
    for hk_id in ids:
        _cmd_q.put(('unregister', hk_id))
    # Drop the bypass key too and reset to active so the next arm starts clean.
    if _bypass_id[0]:
        _cmd_q.put(('unregister', _bypass_id[0]))
        _bypass_id[0] = 0
    _bypass_combo[0] = None
    _bypass_ok[0] = None
    if reset_bypass:
        _bypassed[0] = False
    _wake()
    return {'ok': True, 'cleared': len(ids)}


def clear_all():
    with _configure_lock:
        return _clear_registrations(reset_bypass=True)


def _is_elevated():
    try:
        return ctypes.windll.shell32.IsUserAnAdmin() != 0
    except Exception:
        return False


def _set_bindings(payload):
    """Replace the live global hotkeys with the supplied set.

    payload = {deviceId, sampleRate, bindings: [{combo, audio(base64 int16 PCM), volume}]}
    """
    if not available():
        return {'ok': False, 'message': 'Global hotkeys require numpy and Windows.'}
    device = str(payload.get('deviceId') or '')
    if not device:
        device = 'default'
    rate = int(payload.get('sampleRate') or 48000)
    items = payload.get('bindings') or []
    _ensure_thread()
    _ready.wait(2.0)
    was_bypassed = _bypassed[0]
    _clear_registrations(reset_bypass=False)
    bypass_combo = str(payload.get('bypassCombo') or '').strip()
    parsed_b = _parse_combo(bypass_combo)
    # Manual bypass does not require a configured bypass combo. Preserve it when bindings refresh.
    _bypassed[0] = bool(was_bypassed)
    used = {parsed_b} if parsed_b else set()
    queued, skipped, duplicates = [], [], []
    for it in items:
        combo = str(it.get('combo') or '').strip()
        audio = it.get('audio')
        parsed = _parse_combo(combo)
        if not parsed or not audio:
            skipped.append(combo)
            continue
        if parsed in used:
            duplicates.append(combo)
            continue
        used.add(parsed)
        mods, vk = parsed
        try:
            samples = np.frombuffer(base64.b64decode(audio), dtype='<i2').astype('float32') / 32768.0
        except Exception:
            skipped.append(combo)
            continue
        with _lock:
            hk_id = _next_id[0]
            _next_id[0] += 1
            _bindings[hk_id] = {'samples': samples, 'rate': rate, 'device': device,
                                'vol': float(it.get('volume') or 1.0), 'combo': combo, 'ok': None,
                                'vid': str(it.get('voiceId') or '') or None,
                                'mods': mods, 'vk': vk}  # mods/vk kept so bypass can re-arm
        if not _bypassed[0]:
            _cmd_q.put(('register', hk_id, mods, vk))
        queued.append(hk_id)
    # Register the bypass toggle key (own id, not in _bindings so it never plays a sound).
    if parsed_b:
        mods_b, vk_b = parsed_b
        with _lock:
            bid = _next_id[0]
            _next_id[0] += 1
            _bypass_id[0] = bid
            _bypass_combo[0] = bypass_combo
        _cmd_q.put(('register', bid, mods_b, vk_b))
    _wake()
    # Wait briefly for the loop thread to actually RegisterHotKey each combo so we can report
    # real success/conflict (a combo already owned by another app fails to register).
    deadline = time.time() + 0.8
    while time.time() < deadline:
        with _lock:
            sounds_done = _bypassed[0] or all(_bindings[i]['ok'] is not None for i in queued if i in _bindings)
            bypass_done = not parsed_b or _bypass_ok[0] is not None
            if sounds_done and bypass_done:
                break
        time.sleep(0.02)
    with _lock:
        registered = [b['combo'] for b in _bindings.values() if b['ok']]
        conflicted = [b['combo'] for b in _bindings.values() if b['ok'] is False]
    return {'ok': True, 'configured': len(_bindings), 'registered': registered,
            'conflicted': conflicted, 'duplicates': duplicates, 'skipped': skipped,
            'bypassed': _bypassed[0], 'bypassCombo': _bypass_combo[0],
            'bypassRegistered': _bypass_ok[0] is True,
            'bypassConflict': bool(parsed_b and _bypass_ok[0] is False),
            'elevated': _is_elevated()}


def set_bindings(payload):
    with _configure_lock:
        return _set_bindings(payload)


def set_bypassed(payload):
    """Manually suspend/re-arm sound hotkeys without requiring a bypass key binding."""
    desired = bool((payload or {}).get('bypassed'))
    with _configure_lock:
        _set_bypass_state(desired)
        return status()


def status():
    with _lock:
        binds = [{'combo': b['combo'], 'registered': b['ok']} for b in _bindings.values()]
    return {'ok': True, 'bindings': binds, 'configured': len(binds), 'active': _started, 'triggers': _triggers[0],
            'elevated': _is_elevated(), 'lastFired': dict(_last_fired) if _last_fired else None,
            'lastError': dict(_last_error) if _last_error else None,
            'bypassed': _bypassed[0], 'bypassCombo': _bypass_combo[0],
            'bypassRegistered': _bypass_ok[0] is True,
            'bypassConflict': bool(_bypass_combo[0] and _bypass_ok[0] is False)}
