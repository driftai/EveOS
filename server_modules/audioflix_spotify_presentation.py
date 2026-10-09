"""Presentation and lifecycle policy for the managed Audioflix Spotify engine."""
from __future__ import annotations

import ctypes
import os
import subprocess
import threading
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from server_modules import audioflix_spotify_browser as browser

_ALLOWED = {"hidden", "background", "window", "headless"}
_DEFAULT = "hidden"

_lock = threading.RLock()
_mode = _DEFAULT
_window_handle = 0
_window_pid_cache = 0
_window_profile_cache = ""


def _normalize_mode(value) -> str:
    mode = str(value or "").strip().lower()
    return mode if mode in _ALLOWED else _DEFAULT


def _page_for_mode(page_url: str, mode: str) -> str:
    parsed = urlsplit(str(page_url or "http://127.0.0.1:8765/audioflix-spotify-engine.html"))
    query = [(key, value) for key, value in parse_qsl(parsed.query, keep_blank_values=True) if key != "playwright"]
    if mode == "headless":
        query.append(("playwright", "headless"))
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), parsed.fragment))


def _is_headless(status: dict) -> bool:
    return str(status.get("browserChannel") or "").endswith("-headless")


def _profile_key(profile_path: str) -> str:
    return os.path.normcase(os.path.normpath(str(profile_path or ""))).lower().replace("/", "\\")


def _managed_profile_process(pid: int, profile_path: str) -> bool:
    if os.name != "nt" or pid <= 0 or not profile_path:
        return False
    command = [
        "powershell", "-NoProfile", "-NonInteractive", "-Command",
        f"$p=Get-CimInstance Win32_Process -Filter 'ProcessId={int(pid)}' -ErrorAction SilentlyContinue; if($p){{$p.CommandLine}}",
    ]
    try:
        completed = subprocess.run(
            command, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=2,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    line = (completed.stdout or "").lower().replace("/", "\\")
    profile = _profile_key(profile_path)
    return bool(profile and profile in line and "--user-data-dir" in line)


def _window_pid(user32, hwnd) -> int:
    pid = ctypes.c_ulong(0)
    user32.GetWindowThreadProcessId(ctypes.c_void_p(hwnd), ctypes.byref(pid))
    return int(pid.value)


def _remember_window(hwnd: int, pid: int, profile_path: str) -> int:
    global _window_handle, _window_pid_cache, _window_profile_cache
    _window_handle = int(hwnd or 0)
    _window_pid_cache = int(pid or 0)
    _window_profile_cache = _profile_key(profile_path)
    return _window_handle


def _forget_window() -> None:
    global _window_handle, _window_pid_cache, _window_profile_cache
    _window_handle = 0
    _window_pid_cache = 0
    _window_profile_cache = ""


def _find_engine_window() -> int:
    if os.name != "nt":
        return 0
    status = browser.status()
    profile_path = str(status.get("profilePath") or "")
    profile_key = _profile_key(profile_path)
    if not profile_key:
        return 0
    user32 = ctypes.windll.user32
    if _window_handle and user32.IsWindow(ctypes.c_void_p(_window_handle)):
        pid = _window_pid(user32, _window_handle)
        if pid == _window_pid_cache and profile_key == _window_profile_cache:
            return _window_handle
        if _managed_profile_process(pid, profile_path):
            return _remember_window(_window_handle, pid, profile_path)
        _forget_window()

    found = []
    EnumWindowsProc = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)

    def visit(hwnd, _lparam):
        length = user32.GetWindowTextLengthW(hwnd)
        if length <= 0:
            return True
        buffer = ctypes.create_unicode_buffer(length + 1)
        user32.GetWindowTextW(hwnd, buffer, length + 1)
        if "EveOS Spotify Engine" not in buffer.value:
            return True
        pid = _window_pid(user32, hwnd)
        if _managed_profile_process(pid, profile_path):
            found.append((int(hwnd), pid))
            return False
        return True

    user32.EnumWindows(EnumWindowsProc(visit), 0)
    if not found:
        _forget_window()
        return 0
    hwnd, pid = found[0]
    return _remember_window(hwnd, pid, profile_path)


def _apply_window_mode(mode: str) -> dict:
    if mode == "headless" or os.name != "nt":
        return {"ok": True, "presentation": mode, "windowFound": False}
    hwnd = _find_engine_window()
    if not hwnd:
        return {
            "ok": True,
            "presentation": mode,
            "windowFound": False,
            "warning": "Managed Spotify engine window for the dedicated profile was not found yet.",
        }
    command = {"hidden": 0, "background": 6, "window": 9}[mode]
    ctypes.windll.user32.ShowWindowAsync(ctypes.c_void_p(hwnd), command)
    return {"ok": True, "presentation": mode, "windowFound": True}


def status() -> dict:
    with _lock:
        result = browser.status()
        result["presentation"] = _mode
        return result


def ensure_engine(page_url: str) -> dict:
    """Start/reuse the engine in the saved presentation mode; hidden is the default."""
    with _lock:
        current = browser.status()
        want_headless = _mode == "headless"
        have_headless = _is_headless(current)
        if current.get("browserRunning") and want_headless != have_headless:
            browser.stop({})
            _forget_window()
            current = browser.status()
        result = browser.start({"pageUrl": _page_for_mode(page_url, _mode)})
        applied = _apply_window_mode(_mode) if result.get("helperReachable") else {"presentation": _mode}
        result.update({key: value for key, value in applied.items() if key != "ok"})
        result["presentation"] = _mode
        return result


def set_presentation(payload: dict | None = None) -> dict:
    global _mode
    payload = payload if isinstance(payload, dict) else {}
    requested = str(payload.get("mode") or payload.get("presentation") or "").strip().lower()
    if requested not in _ALLOWED:
        return {"ok": False, "reason": "Presentation must be hidden, background, window, or headless."}
    page_url = str(payload.get("pageUrl") or browser.status().get("pageUrl") or "http://127.0.0.1:8765/audioflix-spotify-engine.html")
    with _lock:
        old_mode = _mode
        _mode = requested
        current = browser.status()
        want_headless = _mode == "headless"
        have_headless = _is_headless(current)
        if current.get("browserRunning") and want_headless != have_headless:
            browser.stop({})
            _forget_window()
        result = ensure_engine(page_url)
        result["previousPresentation"] = old_mode
        result["presentation"] = _mode
        return result


def stop_engine(payload: dict | None = None) -> dict:
    del payload
    with _lock:
        result = browser.stop({})
        _forget_window()
        result["presentation"] = _mode
        return result


def restore_for_auth(page_url: str = "") -> dict:
    target = page_url or browser.status().get("pageUrl") or "http://127.0.0.1:8765/audioflix-spotify-engine.html"
    return set_presentation({"mode": "window", "pageUrl": target})
