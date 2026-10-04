"""Native frame suppression and client-area alignment for detached Matrix fullscreen."""

from __future__ import annotations

import ctypes
import threading
from ctypes import wintypes


GWL_STYLE = -16
WS_BORDER = 0x00800000
WS_DLGFRAME = 0x00400000
WS_CAPTION = WS_BORDER | WS_DLGFRAME
WS_THICKFRAME = 0x00040000
IMMERSIVE_FRAME_STYLE_MASK = WS_CAPTION | WS_THICKFRAME
DWMWA_BORDER_COLOR = 34
DWMWA_COLOR_NONE = 0xFFFFFFFE
SWP_NOACTIVATE = 0x0010
SWP_FRAMECHANGED = 0x0020
SWP_NOOWNERZORDER = 0x0200
MONITOR_DEFAULTTONEAREST = 0x00000002
FRAME_GUARD_INTERVAL_SECONDS = 0.05


class MONITORINFO(ctypes.Structure):
    _fields_ = [
        ("cbSize", wintypes.DWORD),
        ("rcMonitor", wintypes.RECT),
        ("rcWork", wintypes.RECT),
        ("dwFlags", wintypes.DWORD),
    ]


def _api():
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    user32.IsWindow.argtypes = [wintypes.HWND]
    user32.IsWindow.restype = wintypes.BOOL
    user32.GetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int]
    user32.GetWindowLongW.restype = ctypes.c_long
    user32.SetWindowLongW.argtypes = [wintypes.HWND, ctypes.c_int, ctypes.c_long]
    user32.SetWindowLongW.restype = ctypes.c_long
    user32.SetWindowPos.argtypes = [
        wintypes.HWND, wintypes.HWND, ctypes.c_int, ctypes.c_int,
        ctypes.c_int, ctypes.c_int, wintypes.UINT,
    ]
    user32.SetWindowPos.restype = wintypes.BOOL
    user32.GetWindowRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetWindowRect.restype = wintypes.BOOL
    user32.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    user32.GetClientRect.restype = wintypes.BOOL
    user32.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    user32.ClientToScreen.restype = wintypes.BOOL
    user32.MonitorFromWindow.argtypes = [wintypes.HWND, wintypes.DWORD]
    user32.MonitorFromWindow.restype = wintypes.HANDLE
    user32.GetMonitorInfoW.argtypes = [wintypes.HANDLE, ctypes.POINTER(MONITORINFO)]
    user32.GetMonitorInfoW.restype = wintypes.BOOL
    return user32


def _read_style(user32, hwnd) -> int:
    ctypes.set_last_error(0)
    raw = user32.GetWindowLongW(hwnd, GWL_STYLE)
    error = ctypes.get_last_error()
    if raw == 0 and error:
        raise OSError(error, "GetWindowLongW failed")
    return int(raw) & 0xFFFFFFFF


def _write_style(user32, hwnd, style: int) -> None:
    ctypes.set_last_error(0)
    previous = user32.SetWindowLongW(hwnd, GWL_STYLE, ctypes.c_long(style).value)
    error = ctypes.get_last_error()
    if previous == 0 and error:
        raise OSError(error, "SetWindowLongW failed")
    flags = SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_NOOWNERZORDER
    if not user32.SetWindowPos(hwnd, None, 0, 0, 0, 0, flags):
        raise OSError(ctypes.get_last_error(), "SetWindowPos frame refresh failed")


def _dwm_api():
    try:
        dwmapi = ctypes.WinDLL("dwmapi", use_last_error=True)
    except OSError:
        return None
    dwmapi.DwmGetWindowAttribute.argtypes = [
        wintypes.HWND, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD,
    ]
    dwmapi.DwmGetWindowAttribute.restype = ctypes.c_long
    dwmapi.DwmSetWindowAttribute.argtypes = [
        wintypes.HWND, wintypes.DWORD, wintypes.LPCVOID, wintypes.DWORD,
    ]
    dwmapi.DwmSetWindowAttribute.restype = ctypes.c_long
    return dwmapi


def _read_border(hwnd):
    dwmapi = _dwm_api()
    if dwmapi is None:
        return None
    value = wintypes.DWORD()
    result = int(dwmapi.DwmGetWindowAttribute(
        hwnd, DWMWA_BORDER_COLOR, ctypes.byref(value), ctypes.sizeof(value)
    ))
    return int(value.value) if result == 0 else None


def _write_border(hwnd, color: int) -> bool:
    dwmapi = _dwm_api()
    if dwmapi is None:
        return False
    value = wintypes.DWORD(int(color) & 0xFFFFFFFF)
    result = int(dwmapi.DwmSetWindowAttribute(
        hwnd, DWMWA_BORDER_COLOR, ctypes.byref(value), ctypes.sizeof(value)
    ))
    return result == 0


def _rect_tuple(rect):
    return (int(rect.left), int(rect.top), int(rect.right), int(rect.bottom))


def target_outer_rect(window_rect, client_rect, monitor_rect):
    """Return the outer window rect that makes the client rect exactly cover the monitor."""
    wl, wt, wr, wb = map(int, window_rect)
    cl, ct, cr, cb = map(int, client_rect)
    ml, mt, mr, mb = map(int, monitor_rect)
    left_inset = cl - wl
    top_inset = ct - wt
    right_inset = wr - cr
    bottom_inset = wb - cb
    return (
        ml - left_inset,
        mt - top_inset,
        mr + right_inset,
        mb + bottom_inset,
    )


def _geometry(user32, hwnd) -> dict:
    window_rect = wintypes.RECT()
    client_local = wintypes.RECT()
    origin = wintypes.POINT(0, 0)
    if not user32.GetWindowRect(hwnd, ctypes.byref(window_rect)):
        raise OSError(ctypes.get_last_error(), "GetWindowRect failed")
    if not user32.GetClientRect(hwnd, ctypes.byref(client_local)):
        raise OSError(ctypes.get_last_error(), "GetClientRect failed")
    if not user32.ClientToScreen(hwnd, ctypes.byref(origin)):
        raise OSError(ctypes.get_last_error(), "ClientToScreen failed")

    monitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)
    if not monitor:
        raise OSError("MonitorFromWindow failed")
    info = MONITORINFO()
    info.cbSize = ctypes.sizeof(MONITORINFO)
    if not user32.GetMonitorInfoW(monitor, ctypes.byref(info)):
        raise OSError(ctypes.get_last_error(), "GetMonitorInfoW failed")

    client_width = int(client_local.right - client_local.left)
    client_height = int(client_local.bottom - client_local.top)
    client_rect = (
        int(origin.x), int(origin.y),
        int(origin.x + client_width), int(origin.y + client_height),
    )
    window_tuple = _rect_tuple(window_rect)
    monitor_tuple = _rect_tuple(info.rcMonitor)
    return {
        "windowRect": window_tuple,
        "clientRect": client_rect,
        "monitorRect": monitor_tuple,
        "clientAligned": client_rect == monitor_tuple,
        "targetOuterRect": target_outer_rect(window_tuple, client_rect, monitor_tuple),
    }


def _align_client(user32, hwnd) -> dict:
    measured = _geometry(user32, hwnd)
    if measured["clientAligned"]:
        return measured
    left, top, right, bottom = measured["targetOuterRect"]
    flags = SWP_NOACTIVATE | SWP_NOOWNERZORDER
    if not user32.SetWindowPos(
        hwnd, None, left, top, right - left, bottom - top, flags
    ):
        raise OSError(ctypes.get_last_error(), "SetWindowPos client alignment failed")
    return _geometry(user32, hwnd)


def reassert(state) -> dict:
    """Re-strip Chromium frame bits and keep its client area flush with the monitor."""
    frame_state = state if isinstance(state, dict) else {}
    hwnd = int(frame_state.get("hwnd") or 0)
    if not hwnd:
        raise OSError("Detached Matrix window handle is unavailable")
    user32 = _api()
    if not user32.IsWindow(hwnd):
        raise OSError("Detached Matrix window is no longer available")

    current = _read_style(user32, hwnd)
    updated = current & ~IMMERSIVE_FRAME_STYLE_MASK
    if updated != current:
        _write_style(user32, hwnd, updated)
    if _read_style(user32, hwnd) & IMMERSIVE_FRAME_STYLE_MASK:
        raise OSError("Detached Matrix non-client frame suppression verification mismatch")

    border = _read_border(hwnd)
    if border is not None and border != DWMWA_COLOR_NONE:
        _write_border(hwnd, DWMWA_COLOR_NONE)

    geometry = _align_client(user32, hwnd)
    frame_state["lastGeometry"] = geometry
    frame_state["clientAligned"] = bool(geometry.get("clientAligned"))
    return geometry


def capture_and_suppress(hwnd) -> dict:
    """Capture restorable frame state, suppress it, and align the client to the monitor."""
    hwnd_value = int(getattr(hwnd, "value", hwnd) or 0)
    if not hwnd_value:
        raise OSError("Detached Matrix window handle is unavailable")
    user32 = _api()
    if not user32.IsWindow(hwnd_value):
        raise OSError("Detached Matrix window is no longer available")
    current = _read_style(user32, hwnd_value)
    border = _read_border(hwnd_value)
    state = {
        "hwnd": hwnd_value,
        "frameStyleBits": current & IMMERSIVE_FRAME_STYLE_MASK,
        "dwmBorderColor": border,
        "dwmBorderSuppressed": border is not None,
    }
    reassert(state)
    return state


def guard_loop(stop_event: threading.Event, state) -> None:
    """Chromium can restore its frame after fullscreenchange; keep correcting it until exit."""
    while not stop_event.wait(FRAME_GUARD_INTERVAL_SECONDS):
        try:
            reassert(state)
        except OSError:
            return


def restore(state) -> bool:
    """Restore only the native frame bits and DWM border captured before immersive mode."""
    frame_state = state if isinstance(state, dict) else {}
    hwnd = int(frame_state.get("hwnd") or 0)
    if not hwnd:
        return False
    user32 = _api()
    if not user32.IsWindow(hwnd):
        return False
    current = _read_style(user32, hwnd)
    saved = int(frame_state.get("frameStyleBits") or 0) & IMMERSIVE_FRAME_STYLE_MASK
    updated = (current & ~IMMERSIVE_FRAME_STYLE_MASK) | saved
    if updated != current:
        _write_style(user32, hwnd, updated)
    if frame_state.get("dwmBorderSuppressed") and frame_state.get("dwmBorderColor") is not None:
        _write_border(hwnd, int(frame_state["dwmBorderColor"]))
    return True
