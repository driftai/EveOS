"""Temporary Windows taskbar and bottom-edge cover for immersive Matrix."""

from __future__ import annotations

import ctypes
import os
import subprocess
import sys
import threading
from ctypes import wintypes
from pathlib import Path

from . import matrix_immersive_frame


ABM_GETSTATE = 0x00000004
ABM_SETSTATE = 0x0000000A
ABS_AUTOHIDE = 0x00000001
WS_EX_TOPMOST = 0x00000008
WS_EX_TRANSPARENT = 0x00000020
WS_EX_TOOLWINDOW = 0x00000080
WS_EX_LAYERED = 0x00080000
WS_EX_NOACTIVATE = 0x08000000
LWA_ALPHA = 0x00000002
WS_POPUP = 0x80000000
SS_BLACKRECT = 0x00000004
SW_HIDE = 0
SW_SHOWNOACTIVATE = 4
SWP_NOSIZE = 0x0001
SWP_NOMOVE = 0x0002
SWP_NOACTIVATE = 0x0010
SWP_SHOWWINDOW = 0x0040
SWP_NOOWNERZORDER = 0x0200
HWND_TOPMOST = -1
HWND_NOTOPMOST = -2
PM_REMOVE = 0x0001
_SESSION = {}
_GUARD = threading.RLock()


class APPBARDATA(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("hWnd", wintypes.HWND),
        ("uCallbackMessage", wintypes.UINT),
        ("uEdge", wintypes.UINT),
        ("rc", wintypes.RECT),
        ("lParam", wintypes.LPARAM),
    ]


def _taskbar_state() -> int:
    data = APPBARDATA()
    data.cbSize = ctypes.sizeof(APPBARDATA)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    shell32.SHAppBarMessage.argtypes = [wintypes.DWORD, ctypes.POINTER(APPBARDATA)]
    shell32.SHAppBarMessage.restype = ctypes.c_size_t
    return int(shell32.SHAppBarMessage(ABM_GETSTATE, ctypes.byref(data)))


def _write_taskbar_state(state: int) -> int:
    data = APPBARDATA()
    data.cbSize = ctypes.sizeof(APPBARDATA)
    data.lParam = int(state)
    shell32 = ctypes.WinDLL("shell32", use_last_error=True)
    shell32.SHAppBarMessage.argtypes = [wintypes.DWORD, ctypes.POINTER(APPBARDATA)]
    shell32.SHAppBarMessage.restype = ctypes.c_size_t
    shell32.SHAppBarMessage(ABM_SETSTATE, ctypes.byref(data))
    return _taskbar_state()


def _tray_revealed(user32, width: int, height: int) -> bool:
    """The hidden bottom taskbar leaves a 2px reveal strip; do not hide for a cursor alone."""
    tray = user32.FindWindowW("Shell_TrayWnd", None)
    rect = wintypes.RECT()
    return bool(
        tray and user32.IsWindowVisible(tray)
        and user32.GetWindowRect(tray, ctypes.byref(rect))
        and rect.left < width and rect.right > 0
        and rect.top < height - 3 and rect.bottom >= height - 2
    )


def _pointer_at_bottom_edge(user32, width: int, height: int) -> bool:
    point = wintypes.POINT()
    return bool(user32.GetCursorPos(ctypes.byref(point))
                and 0 <= point.x < width and height - 2 <= point.y < height)


def _next_edge_taskbar_z_order(*, taskbar_promoted: bool, at_edge: bool,
                               near_edge: bool, in_open_tray: bool):
    """Promote the auto-hidden tray without changing the Windows work area."""
    wants_overlay = bool(at_edge or near_edge or in_open_tray)
    if wants_overlay and not taskbar_promoted:
        return True, True
    if taskbar_promoted and not wants_overlay:
        return False, False
    return None, taskbar_promoted


def _edge_guard_loop(stop_event: threading.Event, original_state: int,
                     target_state: int) -> None:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.CreateWindowExW.argtypes = [
        wintypes.DWORD, wintypes.LPCWSTR, wintypes.LPCWSTR, wintypes.DWORD,
        ctypes.c_int, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        wintypes.HWND, wintypes.HMENU, wintypes.HINSTANCE, wintypes.LPVOID,
    ]
    user32.CreateWindowExW.restype = wintypes.HWND
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.FindWindowW.restype = wintypes.HWND
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.IsWindowVisible.restype = wintypes.BOOL
    user32.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    user32.GetCursorPos.restype = wintypes.BOOL
    user32.SetLayeredWindowAttributes.argtypes = [
        wintypes.HWND, wintypes.COLORREF, wintypes.BYTE, wintypes.DWORD,
    ]
    user32.SetLayeredWindowAttributes.restype = wintypes.BOOL
    user32.SetWindowPos.argtypes = [
        wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_int, wintypes.UINT,
    ]
    user32.PeekMessageW.argtypes = [
        ctypes.POINTER(wintypes.MSG), wintypes.HWND, wintypes.UINT,
        wintypes.UINT, wintypes.UINT,
    ]
    width = int(user32.GetSystemMetrics(0))
    height = int(user32.GetSystemMetrics(1))
    if width <= 0 or height <= 2:
        return
    # Layered + transparent is the Win32 mouse pass-through combination. Without
    # layered, this topmost cover can steal the taskbar's edge-hover hit test.
    styles = (WS_EX_TOPMOST | WS_EX_TRANSPARENT | WS_EX_LAYERED
              | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE)
    hwnd = user32.CreateWindowExW(
        styles, "STATIC", "EveOS Matrix Edge Guard", WS_POPUP | SS_BLACKRECT,
        0, height - 2, width, 2, None, None, None, None,
    )
    if not hwnd:
        return
    if not user32.SetLayeredWindowAttributes(hwnd, 0, 255, LWA_ALPHA):
        user32.DestroyWindow(hwnd)
        return
    message = wintypes.MSG()
    shown = False
    taskbar_promoted = False
    try:
        while not stop_event.wait(0.05):
            while user32.PeekMessageW(ctypes.byref(message), hwnd, 0, 0, PM_REMOVE):
                user32.TranslateMessage(ctypes.byref(message))
                user32.DispatchMessageW(ctypes.byref(message))
            current_width = int(user32.GetSystemMetrics(0))
            current_height = int(user32.GetSystemMetrics(1))
            if (current_width, current_height) != (width, height):
                width, height = current_width, current_height
                user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, height - 2, width, 2,
                                    SWP_NOACTIVATE)
            at_edge = _pointer_at_bottom_edge(user32, width, height)
            point = wintypes.POINT()
            user32.GetCursorPos(ctypes.byref(point))
            near_edge = 0 <= point.x < width and height - 12 <= point.y < height
            tray = user32.FindWindowW("Shell_TrayWnd", None)
            tray_rect = wintypes.RECT()
            in_open_tray = bool(tray and user32.GetWindowRect(tray, ctypes.byref(tray_rect))
                                and tray_rect.top < height - 3
                                and tray_rect.left <= point.x < tray_rect.right
                                and tray_rect.top <= point.y < tray_rect.bottom)
            z_action, next_promoted = _next_edge_taskbar_z_order(
                taskbar_promoted=taskbar_promoted,
                at_edge=at_edge,
                near_edge=near_edge,
                in_open_tray=in_open_tray,
            )
            if z_action is not None and tray:
                # Keep ABS_AUTOHIDE enabled for the whole immersive session. Flipping it off
                # changes the Windows work area and can resize a maximized foreground app.
                # Instead, temporarily raise Explorer's tray above fullscreen/topmost windows.
                insert_after = HWND_TOPMOST if z_action else HWND_NOTOPMOST
                flags = SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER
                user32.SetWindowPos(tray, insert_after, 0, 0, 0, 0, flags)
                taskbar_promoted = next_promoted
            should_show = not _tray_revealed(user32, width, height) and not near_edge
            if should_show != shown:
                if should_show:
                    # The Windows taskbar raises its own z-order while revealed.
                    # Reassert topmost when it retracts or the guard can remain
                    # hidden behind the focused fullscreen browser for a while.
                    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, height - 2, width, 2,
                                        SWP_NOACTIVATE | SWP_SHOWWINDOW)
                    user32.UpdateWindow(hwnd)
                else:
                    user32.ShowWindow(hwnd, SW_HIDE)
                shown = should_show
    finally:
        if taskbar_promoted:
            tray = user32.FindWindowW("Shell_TrayWnd", None)
            if tray:
                user32.SetWindowPos(
                    tray, HWND_NOTOPMOST, 0, 0, 0, 0,
                    SWP_NOSIZE | SWP_NOMOVE | SWP_NOACTIVATE | SWP_NOOWNERZORDER,
                )
        user32.DestroyWindow(hwnd)


def _watch_window(token: str, hwnd_value: int, stop_event: threading.Event) -> None:
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
    while not stop_event.wait(0.2):
        if not user32.IsWindow(hwnd_value):
            restore_taskbar_session(token)
            return


def _start_watchdog(original: int, target: int):
    # The pipe carries an explicit cancel on normal restoration. EOF without cancel means
    # Local Control died abruptly; the independent helper restores only our exact state.
    return subprocess.Popen(
        [sys.executable, "-m", "server_modules.matrix_taskbar_control",
         "--watchdog", str(original), str(target)],
        cwd=str(Path(__file__).resolve().parents[1]),
        stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        close_fds=True,
    )


def _cancel_watchdog(process) -> None:
    pipe = getattr(process, "stdin", None)
    if pipe:
        try:
            pipe.write(b"cancel\n")
            pipe.flush()
        except (BrokenPipeError, OSError):
            pass
        finally:
            try:
                pipe.close()
            except OSError:
                pass


def restore_taskbar_session(token: str | None = None) -> bool:
    with _GUARD:
        if not _SESSION or (token and _SESSION.get("token") != token):
            return False
        state = dict(_SESSION)
        _SESSION.clear()
        # Stop native guards before restoring the user's taskbar/frame state.
        state["stop"].set()
        original = int(state["originalState"])
        current = _taskbar_state()
        if current != original:
            if _write_taskbar_state(original) != original:
                raise OSError("Windows taskbar restoration verification mismatch")

    frame_thread = state.get("frameThread")
    if frame_thread and frame_thread is not threading.current_thread():
        frame_thread.join(timeout=0.35)
    try:
        matrix_immersive_frame.restore(state.get("frame"))
    finally:
        _cancel_watchdog(state["watchdog"])
    return True


def set_taskbar_autohide(token: str, hwnd, enabled: bool) -> dict:
    if not enabled:
        restored = restore_taskbar_session(token)
        current = _taskbar_state()
        return {"ok": True, "supported": True, "taskbarAutoHide": bool(current & ABS_AUTOHIDE),
                "taskbarRestored": restored, "taskbarState": current}

    with _GUARD:
        if _SESSION and _SESSION["token"] != token:
            restore_taskbar_session()
        if _SESSION:
            current = _taskbar_state()
            frame_state = _SESSION.get("frame") or {}
            return {"ok": True, "supported": True, "taskbarAutoHide": bool(current & ABS_AUTOHIDE),
                    "taskbarRestored": False, "taskbarState": current, "edgeGuard": True,
                    "clientFrameSuppressed": True,
                    "clientAligned": bool(frame_state.get("clientAligned"))}

        original = _taskbar_state()
        target = original | ABS_AUTOHIDE
        frame_state = matrix_immersive_frame.capture_and_suppress(hwnd)
        watchdog = None
        try:
            watchdog = _start_watchdog(original, target)
            current = _write_taskbar_state(target)
            if current != target:
                raise OSError("Windows taskbar auto-hide verification mismatch")
        except BaseException:
            try:
                if _taskbar_state() != original:
                    _write_taskbar_state(original)
            finally:
                matrix_immersive_frame.restore(frame_state)
                if watchdog is not None:
                    _cancel_watchdog(watchdog)
            raise
        stop_event = threading.Event()
        hwnd_value = int(getattr(hwnd, "value", hwnd) or 0)
        frame_thread = threading.Thread(
            target=matrix_immersive_frame.guard_loop,
            args=(stop_event, frame_state),
            name=f"EveMatrixFrame:{token[:10]}", daemon=True,
        )
        _SESSION.update({"token": token, "originalState": original,
                         "stop": stop_event, "watchdog": watchdog,
                         "frame": frame_state, "frameThread": frame_thread})
        frame_thread.start()
        threading.Thread(target=_watch_window, args=(token, hwnd_value, stop_event),
                         name=f"EveMatrixTaskbar:{token[:10]}", daemon=True).start()
        threading.Thread(target=_edge_guard_loop, args=(stop_event, original, target),
                         name=f"EveMatrixTaskbarEdge:{token[:10]}", daemon=True).start()
    return {"ok": True, "supported": True, "taskbarAutoHide": True,
            "taskbarRestored": False, "taskbarOriginalState": original,
            "taskbarState": current, "edgeGuard": True, "clientFrameSuppressed": True,
            "dwmBorderSuppressed": bool(frame_state.get("dwmBorderSuppressed")),
            "clientAligned": bool(frame_state.get("clientAligned"))}


def shutdown() -> None:
    restore_taskbar_session()


def _watchdog_main(original: int, target: int) -> None:
    if sys.stdin.buffer.readline() == b"cancel\n":
        return
    if os.name == "nt":
        current = _taskbar_state()
        if current in {target, target & ~ABS_AUTOHIDE}:
            _write_taskbar_state(original)


if __name__ == "__main__" and len(sys.argv) == 4 and sys.argv[1] == "--watchdog":
    _watchdog_main(int(sys.argv[2]), int(sys.argv[3]))
