"""Guarded retirement of a stale, exact-profile EveOS Official Spotify Embed host.

An EveOS server restart can lose its in-memory session while the dedicated Edge
app window survives and blocks a later explicit Play. This module never touches
ordinary Edge profiles or credentials. If evidence is ambiguous, fail closed.
"""
from __future__ import annotations

import math
import os
import time
from pathlib import Path

PROFILE_NAME = "SpotifyEmbedEdgeBetaProfile"


def _normalize(path):
    return os.path.normcase(os.path.normpath(str(path).strip('"')))


def _exact_profile_argument(args, profile):
    args = [str(arg) for arg in args]
    for index, arg in enumerate(args):
        low = arg.lower()
        if low.startswith("--user-data-dir="):
            value = arg.split("=", 1)[1]
        elif low == "--user-data-dir" and index + 1 < len(args):
            value = args[index + 1]
        else:
            continue
        if _normalize(value) == _normalize(profile):
            return True
    return False


def _live_profile_audio(owned):
    """Fail closed on incomplete device enumeration; check ALL output endpoints.

    Having a COM session in active state is conservative (it may be silent), but
    preventing destruction of another live playback owner matters more than
    automatically repairing every orphaned browser profile.
    """
    from pycaw.pycaw import AudioUtilities
    from pycaw.utils import AudioSession
    from pycaw.api.audiopolicy import IAudioSessionControl2
    from server_modules.audioflix_spotify_windows_output import NativeWindowsBackend

    backend = NativeWindowsBackend()
    outputs = list(backend.war.list_output_devices())
    if not outputs:
        raise RuntimeError("Cannot verify Spotify audio: no output endpoints were enumerated.")
    with backend.com_initialized():
        enumerator = AudioUtilities.GetDeviceEnumerator()
        for endpoint in outputs:
            # Deliberately no per-endpoint exception suppression: unavailable
            # endpoint telemetry does NOT establish an inactive Spotify session.
            device = AudioUtilities.CreateDevice(enumerator.GetDevice(endpoint.id))
            if device is None:
                raise RuntimeError("Cannot verify all Spotify audio endpoints.")
            sessions = device.AudioSessionManager.GetSessionEnumerator()
            for index in range(sessions.GetCount()):
                ctl = sessions.GetSession(index)
                if ctl is None or ctl.GetState() != 1:
                    continue
                session = AudioSession(ctl.QueryInterface(IAudioSessionControl2))
                if int(session.ProcessId or 0) in owned:
                    return True
    return False


def _snapshot(process_finder, profile):
    raw = dict(process_finder(profile) or {})
    if len(raw) > 64:
        raise RuntimeError("Unexpectedly many dedicated Spotify Edge processes; refusing retirement.")
    result = {}
    for pid, born in raw.items():
        pid, born = int(pid), float(born)
        if pid <= 0 or not math.isfinite(born) or born <= 0:
            raise RuntimeError("Invalid dedicated Spotify process identity.")
        result[pid] = born
    return result


def _unchanged_subset(previous, current):
    # A new PID or birth-time change after graceful closure is ambiguous.
    return all(pid in previous and abs(previous[pid] - born) < 0.02
               for pid, born in current.items())


def _verified_process(process_factory, pid, born, profile, executable, current):
    if pid not in current or abs(current[pid] - born) >= 0.02:
        raise RuntimeError("Dedicated Spotify PID was replaced during retirement.")
    proc = process_factory(pid)
    if abs(float(proc.create_time()) - born) >= 0.02:
        raise RuntimeError("Dedicated Spotify PID identity changed before termination.")
    if proc.name().lower() != "msedge.exe":
        raise RuntimeError("Spotify profile PID is not an Edge process.")
    if _normalize(proc.exe()) != _normalize(executable):
        raise RuntimeError("Spotify profile process is not the exact Edge Beta executable.")
    if not _exact_profile_argument(proc.cmdline(), profile):
        raise RuntimeError("Spotify PID no longer has the dedicated profile argument.")
    return proc


def retire_stale_host(profile, process_finder, *, expected_executable,
                      process_factory=None, wait_procs=None, window_probe=None,
                      close_windows=None, audio_probe=None, sleep=time.sleep):
    """Retire an orphaned app window only when every ownership witness matches.

    Explicit Play calls this only when the local manager reports stopped. No
    broad taskkill, profile deletion, global audio switch, or forced process kill.
    A failure leaves any surviving profile process for owner inspection.
    """
    profile = Path(profile)
    if profile.name != PROFILE_NAME or profile.parent.name != "EveOS":
        raise RuntimeError("Refusing to retire a non-EveOS Spotify profile.")
    if not expected_executable:
        raise RuntimeError("Exact Edge Beta executable is required for recovery.")
    snapshot = _snapshot(process_finder, profile)
    if not snapshot:
        return {"closedWindows": 0, "retiredPids": []}

    if process_factory is None or wait_procs is None:
        import psutil
        process_factory = process_factory or psutil.Process
        wait_procs = wait_procs or psutil.wait_procs
    if window_probe is None or close_windows is None:
        from server_modules.audioflix_spotify_edge_window import (
            profile_window_inventory, close_profile_windows)
        window_probe = window_probe or profile_window_inventory
        close_windows = close_windows or close_profile_windows
    audio_probe = audio_probe or _live_profile_audio

    def require_silent(owned):
        try:
            active = audio_probe(owned)
        except Exception as error:
            raise RuntimeError("Could not prove dedicated Spotify audio is inactive.") from error
        if active is not False:
            raise RuntimeError("Dedicated Spotify profile has active or unverified audio; stop it manually.")

    def require_only_marked_window(owned):
        evidence = window_probe(owned)
        if not isinstance(evidence, dict) or set(evidence) != {"owned", "other"}:
            raise RuntimeError("Cannot inspect dedicated Spotify windows safely.")
        counts = (evidence["owned"], evidence["other"])
        if any(type(n) is not int or n < 0 for n in counts):
            raise RuntimeError("Cannot inspect dedicated Spotify windows safely.")
        return counts

    # Refuse a profile that has no exact EveOS app window to prove ownership,
    # or any other Edge window using the same profile.
    owned, other = require_only_marked_window(snapshot)
    if owned != 1 or other:
        raise RuntimeError("Spotify profile is not one exact EveOS app window; close it manually.")
    require_silent(snapshot)
    # Identity and media state must be rechecked immediately before WM_CLOSE.
    before_close = _snapshot(process_finder, profile)
    if before_close != snapshot:
        raise RuntimeError("Spotify profile process set changed before window closure.")
    if require_only_marked_window(snapshot) != (1, 0):
        raise RuntimeError("Spotify window identity changed before closure.")
    require_silent(snapshot)
    posted = int(close_windows(snapshot) or 0)
    if posted != 1:
        raise RuntimeError("Could not request exact Spotify window closure safely.")

    # Give Edge time to close normally before considering orphaned subprocesses.
    for _ in range(12):
        sleep(0.25)
        remaining = _snapshot(process_finder, profile)
        if not remaining:
            return {"closedWindows": 1, "retiredPids": []}
        if not _unchanged_subset(snapshot, remaining):
            raise RuntimeError("Spotify profile changed while closing; refusing process retirement.")
        if require_only_marked_window(remaining) == (0, 0):
            break
    else:
        raise RuntimeError("Spotify app window did not close; use Show Spotify and stop it manually.")

    remaining = _snapshot(process_finder, profile)
    if not remaining:
        return {"closedWindows": 1, "retiredPids": []}
    if not _unchanged_subset(snapshot, remaining):
        raise RuntimeError("Spotify profile process set changed after window closure.")
    if require_only_marked_window(remaining) != (0, 0):
        raise RuntimeError("Spotify profile still has windows; refusing process termination.")
    require_silent(remaining)

    targets = []
    for pid, born in sorted(remaining.items()):
        current = _snapshot(process_finder, profile)
        if current != remaining:
            raise RuntimeError("Spotify profile changed while checking process identities.")
        targets.append(_verified_process(process_factory, pid, born, profile,
                                         expected_executable, current))
    # A final safety check precedes any signal. terminate() is graceful; no kill().
    if _snapshot(process_finder, profile) != remaining:
        raise RuntimeError("Spotify process identities changed before termination.")
    if require_only_marked_window(remaining) != (0, 0):
        raise RuntimeError("Spotify windows reappeared; refusing termination.")
    require_silent(remaining)
    for process in targets:
        # Recheck just before each signal to narrow PID-reuse exposure.
        current = _snapshot(process_finder, profile)
        if not _unchanged_subset(remaining, current):
            raise RuntimeError("Spotify process identity changed during retirement.")
        if process.pid not in current:
            continue  # It already exited normally.
        _verified_process(process_factory, process.pid, remaining[process.pid],
                          profile, expected_executable, current).terminate()
    if targets:
        wait_procs(targets, timeout=3)
    residual = _snapshot(process_finder, profile)
    if residual:
        raise RuntimeError("Spotify profile did not exit gracefully; close its old process manually.")
    return {"closedWindows": 1, "retiredPids": sorted(remaining)}
