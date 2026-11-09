"""Dedicated Edge Beta Spotify Engine -> native Windows endpoint.

A short-lived, helper-owned, fail-closed routing worker. Never captures PCM or
handles Spotify credentials. All events on stdout are redacted status receipts.
"""
from __future__ import annotations

import json
import os
import re
import sys
import threading
import time
from pathlib import Path

# Launched by Node using an absolute script path from server_modules/.
# In this invocation Python puts server_modules (not its parent) on sys.path.
# Importing server_modules.audioflix_spotify_windows_output therefore fails
# unless the EveOS package root is made explicit.
_ROOT = Path(__file__).resolve().parent.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))


def write(kind: str, **value):
    sys.stdout.write(json.dumps({'kind': kind, **value}, separators=(',', ':')) + '\n')
    sys.stdout.flush()


def normalized(value):
    return os.path.normcase(os.path.normpath(str(value).strip('"')))


def process_profile(args):
    for i, arg in enumerate(args):
        if arg.lower().startswith('--user-data-dir='):
            return arg.split('=', 1)[1].strip('"')
        if arg.lower() == '--user-data-dir' and i + 1 < len(args):
            return args[i + 1].strip('"')
    return ''


def find_beta(profile: Path, executable: Path):
    import psutil
    expected_exe = normalized(executable)
    expected_profile = normalized(profile)
    owned, other_beta = {}, {}
    for item in psutil.process_iter(attrs=['pid', 'name', 'exe', 'cmdline', 'create_time']):
        try:
            info = item.info
            if str(info.get('name') or '').lower() != 'msedge.exe':
                continue
            if normalized(info.get('exe') or '') != expected_exe:
                continue
            user_data = normalized(process_profile(info.get('cmdline') or []))
            pid = int(info['pid'])
            created = float(info['create_time'])
            if user_data == expected_profile:
                owned[pid] = created
            else:
                other_beta[pid] = created
        except (psutil.NoSuchProcess, psutil.AccessDenied, TypeError, ValueError, KeyError):
            continue
    return owned, other_beta


def active_sessions(backend, pids):
    if not pids:
        return []
    # Reuse the *enumeration* method from the official embed; never share
    # its routing manager or its process ownership.
    from server_modules.audioflix_spotify_edge import _active_sessions
    return _active_sessions(backend, pids)


def restored_route(backend, routed, target):
    restored, uncertain = [], []
    for pid, (created, prior) in list(routed.items()):
        try:
            import psutil
            proc = psutil.Process(pid)
            if abs(proc.create_time() - created) > 1:
                uncertain.append(pid)
                continue
            if backend.get(pid) == target:
                backend.set(pid, prior)
                if backend.get(pid) == prior:
                    restored.append(pid)
                else:
                    uncertain.append(pid)
        except Exception:
            uncertain.append(pid)
    return restored, uncertain


def main():
    # Read-only CLI check: imports the package but never initializes a Windows
    # audio session, browser, COM policy, or any route.
    if sys.argv[1:] == ['--verify-import']:
        try:
            from server_modules import audioflix_spotify_windows_output  # noqa: F401
        except Exception as exc:
            write('import-failed', errorType=type(exc).__name__)
            return 11
        write('import-ok', module='server_modules.audioflix_spotify_windows_output')
        return 0
    if os.name != 'nt' or len(sys.argv) != 4:
        write('error', code='unsupported-platform-or-arguments')
        return 2
    profile, beta, device_id = Path(sys.argv[1]), Path(sys.argv[2]), sys.argv[3]
    if not re.fullmatch(r'sd:\d+', device_id):
        write('error', code='invalid-device-id')
        return 3
    allowed = ['Microsoft', 'Edge Beta', 'Application', 'msedge.exe']
    if [s.casefold() for s in beta.parts[-4:]] != [s.casefold() for s in allowed]:
        write('error', code='not-edge-beta-executable')
        return 3
    if not beta.is_file() or not profile.is_dir():
        write('error', code='required-process-or-profile-missing')
        return 4
    try:
        from server_modules.audioflix_spotify_windows_output import NativeWindowsBackend
        backend = NativeWindowsBackend()
        target = backend.resolve(device_id)
    except Exception as exc:
        write('error', code='native-output-unavailable', detail=str(exc)[:120])
        return 5
    stop = threading.Event()
    def reader():
        try:
            for line in sys.stdin:
                if line.strip() == 'STOP':
                    break
        finally:
            stop.set()
    threading.Thread(target=reader, name='spotify-route-stop', daemon=True).start()
    routed = {}
    last_state = ''
    last_seen = 0
    write('ready', deviceId=device_id, endpoint=target.name, status='awaiting-audio')
    try:
        while not stop.wait(0.45):
            owned, others = find_beta(profile, beta)
            if not owned:
                if last_state != 'awaiting-browser':
                    write('pending', reason='awaiting-owned-beta-browser')
                    last_state = 'awaiting-browser'
                continue
            # A second Beta profile with an *active audio session* could share
            # the same Windows application route. Refuse the overlap.
            if active_sessions(backend, others):
                write('error', code='another-edge-beta-audio-session-active')
                return 9
            audible = active_sessions(backend, owned)
            for pid, _, _ in audible:
                if pid not in owned:
                    continue
                if pid in routed and abs(owned[pid] - routed[pid][0]) > 1:
                    routed.pop(pid, None)  # PID reuse; never restore wrong process
                before = backend.get(pid)
                if pid not in routed:
                    routed[pid] = (owned[pid], before)
                if before != target.id:
                    backend.set(pid, target.id)
                    if backend.get(pid) != target.id:
                        raise RuntimeError('readback-failed')
            refreshed = active_sessions(backend, owned)
            good = sorted({pid for pid, output, _ in refreshed
                           if output == target.id and pid in routed
                           and abs(owned.get(pid, -1) - routed[pid][0]) <= 1})
            if good:
                last_seen = time.monotonic()
                if last_state != 'confirmed' or len(good) != len([p for p in routed if p in owned]):
                    write('routed', deviceId=device_id, endpoint=target.name,
                          sessionCount=len(good), pids=good)
                last_state = 'confirmed'
            elif last_state != 'awaiting-audio':
                write('pending', reason='no-confirmed-audio-session')
                last_state = 'awaiting-audio'
            # Do not announce success based on persisted endpoint preference only.
    except Exception as exc:
        write('error', code='native-route-failed', detail=str(exc)[:120])
        return 8
    finally:
        restored, uncertain = restored_route(backend, routed, target.id)
        write('restored', count=len(restored), uncertainPids=uncertain)
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
