"""Bounded, exact-window UI automation for the dedicated Spotify Edge embed.

No Playwright, CDP port, media interception, keyboard injection, global browser
shutdown or unrelated Edge windows. The underlying Spotify page owns playback.
"""
from __future__ import annotations

import ctypes
import os
import re
import subprocess
import time
from pathlib import Path

TITLE = "EveOS Spotify Embed"
TRACK = re.compile(r"^[A-Za-z0-9]{22}$")


def matching_windows(pids, track_id):
    """Find the exact marked Edge app window, including when it is hidden."""
    if os.name != "nt" or not TRACK.fullmatch(str(track_id or "")):
        return []
    owned = {int(pid) for pid in pids if int(pid) > 0}
    if not owned:
        return []
    user32 = ctypes.windll.user32
    callback_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    result = []
    expected = f"{TITLE} {track_id}"

    def visit(hwnd, _):
        pid = ctypes.c_ulong()
        user32.GetWindowThreadProcessId(hwnd, ctypes.byref(pid))
        if pid.value not in owned:
            return True
        count = user32.GetWindowTextLengthW(hwnd)
        if count < len(expected):
            return True
        buf = ctypes.create_unicode_buffer(count + 1)
        user32.GetWindowTextW(hwnd, buf, count + 1)
        if buf.value == expected or buf.value.startswith(expected + " - "):
            result.append(int(hwnd))
        return True

    callback = callback_type(visit)
    user32.EnumWindows(callback, 0)
    return result


def close_exact_window(pids, track_id):
    """Close only a window marked by both Edge profile PID and current track."""
    matches = matching_windows(pids, track_id)
    if os.name == "nt":
        for hwnd in matches:
            ctypes.windll.user32.PostMessageW(hwnd, 0x0010, 0, 0)  # WM_CLOSE
    return len(matches)


def hide_exact_window(pids, track_id):
    """Hide the window, never terminate the audio-producing browser process."""
    matches = matching_windows(pids, track_id)
    if len(matches) != 1 or os.name != "nt":
        return False
    ctypes.windll.user32.ShowWindow(matches[0], 0)  # SW_HIDE
    return not bool(ctypes.windll.user32.IsWindowVisible(matches[0]))


def show_exact_window(pids, track_id):
    matches = matching_windows(pids, track_id)
    if len(matches) != 1 or os.name != "nt":
        return False
    ctypes.windll.user32.ShowWindow(matches[0], 9)  # SW_RESTORE
    return bool(ctypes.windll.user32.IsWindowVisible(matches[0]))


def _is_windows():
    return os.name == "nt"


def _uia_once(hwnd, timeout):
    """Run the existing exact-window button helper; never send keys or click coordinates."""
    script = Path(__file__).with_name("audioflix_spotify_edge_click.ps1")
    if not script.is_file():
        return {"ok": False, "reason": "uia-helper-missing"}
    try:
        result = subprocess.run(
            ["powershell.exe", "-NoProfile", "-NonInteractive", "-STA",
             "-ExecutionPolicy", "Bypass", "-File", str(script),
             "-WindowHandle", str(hwnd)],
            capture_output=True, text=True, timeout=timeout, check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except (subprocess.TimeoutExpired, OSError):
        return {"ok": False, "reason": "uia-timeout-or-unavailable"}
    label = next((line.strip() for line in (result.stdout or "").splitlines()
                  if line.startswith("EVE_UIA_")), "EVE_UIA_UNAVAILABLE")
    return {"ok": result.returncode == 0 and label == "EVE_UIA_INVOKED",
            "reason": label[:80]}


class _Rect(ctypes.Structure):
    _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                ("right", ctypes.c_long), ("bottom", ctypes.c_long)]


def _temporarily_expose_offscreen(hwnd):
    """Make a hidden owned window UIA-visible without stealing foreground focus.

    No clicks, keystrokes, CDP, arbitrary Edge windows or new output devices.
    If we cannot guarantee relocation outside the virtual desktop, fail closed.
    """
    if not _is_windows():
        return None
    u32 = ctypes.windll.user32
    handle = ctypes.c_void_p(hwnd)  # preserve the full 64-bit HWND
    if not u32.IsWindow(handle) or u32.IsWindowVisible(handle):
        return None
    rect = _Rect()
    if not u32.GetWindowRect(handle, ctypes.byref(rect)):
        return None
    width, height = rect.right - rect.left, rect.bottom - rect.top
    if not 100 <= width <= 10000 or not 100 <= height <= 10000:
        return None
    left, top = u32.GetSystemMetrics(76), u32.GetSystemMetrics(77)  # virtual screen origin
    off_x, off_y = left - width - 256, top - height - 256
    flags = 0x0001 | 0x0004 | 0x0010  # NOSIZE, NOZORDER, NOACTIVATE
    if not u32.SetWindowPos(handle, 0, off_x, off_y, 0, 0, flags):
        return None
    u32.ShowWindow(handle, 8)  # SW_SHOWNA; do not activate or focus the window
    if not u32.IsWindowVisible(handle):
        u32.SetWindowPos(handle, 0, rect.left, rect.top, 0, 0, flags)
        return None
    return rect


def _restore_after_ui(hwnd, rect, should_rehide):
    if not _is_windows() or rect is None:
        return
    u32 = ctypes.windll.user32
    handle = ctypes.c_void_p(hwnd)
    if not u32.IsWindow(handle):
        return
    flags = 0x0001 | 0x0004 | 0x0010
    # Always restore original position even if the user explicitly requested Show.
    u32.SetWindowPos(handle, 0, rect.left, rect.top, 0, 0, flags)
    if should_rehide is None or should_rehide():
        u32.ShowWindow(handle, 0)


def try_card_play(pids, track_id, timeout=18, should_attempt=None, should_rehide=None,
                  playback_confirmed=None):
    """Invoke only the verified Spotify window's official Play accessibility button.

    SW_HIDE removes descendant controls from some Edge UIA trees. For an already
    hidden window, briefly expose that *one* owned window outside the virtual
    desktop with SW_SHOWNA, invoke UIA, then restore its position and hidden
    state. The invocation is NOT proof that playback actually started.
    """
    matches = matching_windows(pids, track_id)
    if len(matches) != 1:
        return {"ok": False, "reason": "exact-edge-window-unavailable", "count": len(matches)}
    if should_attempt is not None and not should_attempt():
        return {"ok": False, "reason": "superseded-before-uia"}
    hwnd = matches[0]
    if not _is_windows():
        return {"ok": False, "reason": "windows-only"}
    hidden = not bool(ctypes.windll.user32.IsWindowVisible(ctypes.c_void_p(hwnd)))
    rect = None
    if hidden:
        rect = _temporarily_expose_offscreen(hwnd)
        if rect is None:
            return {"ok": False, "reason": "hidden-window-exposure-refused"}
    try:
        if should_attempt is not None and not should_attempt():
            return {"ok": False, "reason": "superseded-before-uia"}
        answer = _uia_once(hwnd, timeout)
        confirmed = False
        # Do not re-hide the source immediately after pressing Play: Spotify's
        # player may need time to begin decoding. Keep the offscreen, unfocused
        # window alive until its own SDK confirms playback, or a bounded deadline.
        if answer.get("ok") and hidden and playback_confirmed is not None:
            for _ in range(14):
                if playback_confirmed():
                    confirmed = True
                    break
                if ((should_attempt is not None and not should_attempt()) or
                        (should_rehide is not None and not should_rehide())):
                    break
                time.sleep(0.5)
        return {**answer, "offscreenAssist": hidden, "playbackConfirmed": confirmed}
    finally:
        if rect is not None:
            _restore_after_ui(hwnd, rect, should_rehide)
