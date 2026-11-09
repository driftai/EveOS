"""Dedicated Edge-hosted official Spotify embed with native Windows app-session routing.

The embedded page performs licensed playback; this module never reads media or cookies.
No default-device, browser-extension, DRM or capture changes. One provider owner at a time.
"""
from __future__ import annotations

import json
import os
import re
import secrets
import subprocess
import threading
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlencode

URI = re.compile(r"^spotify:(track|episode):([A-Za-z0-9]{22})$")
SD = re.compile(r"^sd:\d+$")
PROFILE_NAME = "SpotifyEmbedEdgeBetaProfile"
TITLE = "EveOS Spotify Embed"
HIDE_AFTER_PROGRESS_SECONDS = 38.0


def _timestamp():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def _edge_executable():
    # Strict Edge Beta lookup; never fall back to Stable or the managed Spotify Engine.
    roots = [os.environ.get("PROGRAMFILES(X86)"), os.environ.get("PROGRAMFILES"),
             os.environ.get("LOCALAPPDATA")]
    for root in roots:
        if root:
            exe = Path(root) / "Microsoft" / "Edge Beta" / "Application" / "msedge.exe"
            if exe.is_file():
                return str(exe)
    raise RuntimeError("Microsoft Edge Beta executable not found; no fallback to Edge Stable or Electron.")


def _profile():
    root = os.environ.get("LOCALAPPDATA")
    if not root:
        raise RuntimeError("Windows LocalAppData is unavailable.")
    return Path(root) / "EveOS" / PROFILE_NAME


def _owned_processes(profile):
    import psutil
    normalized = os.path.normcase(os.path.normpath(str(profile)))
    found = {}
    for process in psutil.process_iter(attrs=["name", "cmdline", "create_time", "pid"]):
        try:
            d = process.info
            if str(d.get("name") or "").lower() != "msedge.exe":
                continue
            args = [str(v) for v in d.get("cmdline") or []]
            for index, arg in enumerate(args):
                lower = arg.lower()
                if lower.startswith("--user-data-dir="):
                    value = arg.split("=", 1)[1].strip('"')
                elif lower == "--user-data-dir" and index + 1 < len(args):
                    value = args[index + 1].strip('"')
                else:
                    continue
                if os.path.normcase(os.path.normpath(value)) == normalized:
                    found[d["pid"]] = float(d["create_time"])
                    break
        except (psutil.NoSuchProcess, psutil.AccessDenied, KeyError, TypeError):
            continue
    return found


def _active_sessions(backend, owned):
    # Pycaw.GetAllSessions() only scans the system default, not VB-CABLE.
    from pycaw.pycaw import AudioUtilities
    from pycaw.utils import AudioSession
    from pycaw.api.audiopolicy import IAudioSessionControl2
    answer = []
    with backend.com_initialized():
        enumerator = AudioUtilities.GetDeviceEnumerator()
        for endpoint in backend.war.list_output_devices():
            try:
                device = AudioUtilities.CreateDevice(enumerator.GetDevice(endpoint.id))
                if device is None:
                    continue
                sessions = device.AudioSessionManager.GetSessionEnumerator()
                for index in range(sessions.GetCount()):
                    ctl = sessions.GetSession(index)
                    if ctl is None or ctl.GetState() != 1:
                        continue
                    session = AudioSession(ctl.QueryInterface(IAudioSessionControl2))
                    pid = int(session.ProcessId or 0)
                    if pid in owned:
                        answer.append((pid, endpoint.id, session))
            except Exception:
                # Endpoint enumeration is best effort; a failed output is never treated
                # as positive evidence of successful routing.
                continue
    return answer


def _unique_cable(backend):
    candidates = [d for d in backend.war.list_output_devices()
                  if re.search(r"\bCABLE Input\b", str(d.name), re.I)
                  and re.search(r"VB[- ]?Audio|Virtual Cable", str(d.name), re.I)]
    if len(candidates) != 1:
        raise RuntimeError(f"Exactly one VB-CABLE Input playback endpoint is required; found {len(candidates)}")
    return candidates[0]


from server_modules.audioflix_spotify_edge_window import close_exact_window as _close_exact_window


class EdgeSpotifyManager:
    def __init__(self, backend_factory=None, process_finder=_owned_processes,
                 session_finder=_active_sessions, close_window=_close_exact_window,
                 launch=subprocess.Popen):
        self._lock = threading.RLock()
        self._backend_factory = backend_factory
        self._process_finder = process_finder
        self._session_finder = session_finder
        self._close_window = close_window
        self._launch = launch
        self._nonce = ""
        self._track_id = ""
        self._window_id = ""
        self._media_revision = 0
        self._ended_revision = -1
        self._near_end_seen = False
        self._near_end_at = 0.0
        self._end_played_progress = 0.0
        self._manual_show = False
        self._requested_device_id = ""
        self._uri = ""
        self._profile_path = None
        self._started = 0.0
        self._running = False
        self._status = "stopped"
        self._message = ""
        self._desired_gain = 1.0
        self._state = {"paused": True, "currentTime": 0, "duration": 0}
        self._seq = 0
        self._pending = []
        self._target = ""
        self._target_name = ""
        self._routes = {}
        self._generation = 0
        self._report = None
        self._backend = None
        self._autoplay_attempted = False
        self._autoplay_attempted_revision = -1
        self._manual_pause_revision = -1
        self._autoplay_status = "not-attempted"
        self._hide_pending = False
        self._hidden = False
        self._last_position_at = 0.0
        self._last_progress_position = None
        self._confirmed_progress = 0.0
        self._hide_progress_tick = -1
        self._last_hide_attempt_at = -999.0
        self._applied_gain = {}

    @staticmethod
    def _hide_threshold():
        return HIDE_AFTER_PROGRESS_SECONDS

    def _record(self, kind, **details):
        path = self._report
        if not path:
            return
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
            with path.open("a", encoding="utf-8") as f:
                f.write(json.dumps({"at": _timestamp(), "kind": kind, **details}) + "\n")
        except OSError:
            pass

    def status(self):
        from server_modules.audioflix_spotify_edge_session import status
        return status(self)

    def _restore_locked(self):
        backend = self._backend
        restored, uncertain = [], []
        if backend:
            live = self._process_finder(self._profile_path) if self._profile_path else {}
            for pid, (born, before) in self._routes.items():
                if not isinstance(live, dict) or abs(live.get(pid, -999) - born) > 1:
                    uncertain.append(pid)
                    continue
                try:
                    if backend.get(pid) == self._target:
                        backend.set(pid, before)
                        if backend.get(pid) == before:
                            restored.append(pid)
                        else:
                            uncertain.append(pid)
                except Exception:
                    uncertain.append(pid)
        self._record("restore", restored=restored, uncertain=uncertain)
        self._routes.clear()
        return uncertain

    def _stop_locked(self):
        if not self._running:
            return {"ok": True, "status": "already-stopped"}
        # Do not restore the previous speaker route on an unverified WM_CLOSE.
        # Posting WM_CLOSE only requests closure; it is not a completion receipt.
        self._seq += 1
        self._pending.append({"action": "pause", "seq": self._seq})
        live = self._process_finder(self._profile_path) if self._profile_path else {}
        closed = self._close_window(live, self._window_id or self._track_id)
        from server_modules.audioflix_spotify_edge_window import matching_windows
        if closed:
            for _ in range(15):
                if not matching_windows(self._process_finder(self._profile_path), self._window_id or self._track_id):
                    break
                time.sleep(0.1)
        remaining_windows = matching_windows(self._process_finder(self._profile_path), self._window_id or self._track_id)
        live = self._process_finder(self._profile_path) if self._profile_path else {}
        remaining_audio = self._session_finder(self._backend, live) if self._backend else []
        if remaining_windows or remaining_audio or (not closed and live):
            self._status = "close-required"
            self._message = "Spotify Edge closure not confirmed. Routing remains on CABLE; close its card manually."
            self._record("close-unconfirmed", windows=len(remaining_windows),
                         activeSessions=len(remaining_audio))
            return {"ok": False, "reason": self._message}
        self._generation += 1
        uncertain = self._restore_locked()
        self._running = False
        self._hidden = False
        self._window_id = ""
        self._status = "stopped"
        self._pending.clear()
        self._applied_gain.clear()
        self._record("stopped", closedWindows=closed)
        if self._report:
            try:
                from server_modules.audioflix_spotify_edge_diagnostics import archive_live_report
                archive_live_report(self._report)
            except OSError:
                self._record("archive-failed", reason="filesystem-error")
        return {"ok": True, "closedWindows": closed, "restoreUncertainPids": uncertain,
                "message": "Stopped after checking the owned app window and audio sessions."}

    def _run_route(self, generation, device_id):
        from server_modules.audioflix_spotify_edge_route import run_route
        return run_route(self, generation, device_id)

    def play(self, body, server_port):
        uri = str(body.get("spotifyUri") or "")
        match = URI.fullmatch(uri)
        if not match:
            raise ValueError("Use a valid Spotify track or episode URI.")
        device_id = str(body.get("deviceId") or "")
        if device_id and not SD.fullmatch(device_id):
            raise ValueError("The chosen output must be a native sd:N endpoint.")
        with self._lock:
            replaced = False
            if self._running:
                stopped = self._stop_locked()
                if not stopped.get("ok"):
                    raise RuntimeError(stopped.get("reason") or "Previous Edge card is still playing.")
                replaced = stopped.get("closedWindows", 0) > 0
            profile = _profile()
            preexisting = self._process_finder(profile)
            if preexisting and not replaced:
                raise RuntimeError("Dedicated Spotify Edge profile is in use. Close its old windows first; other Edge profiles are untouched.")
            # A managed Engine inside the same Edge Beta executable would share
            # Windows application output policy. Only one Beta provider may own it.
            from server_modules import audioflix_spotify_browser as managed_browser
            if managed_browser.status().get('browserRunning'):
                raise RuntimeError('Stop Spotify Engine before starting Official Embed (shared Edge Beta audio identity).')
            edge = _edge_executable()
            self._nonce = secrets.token_urlsafe(24)
            self._track_id = match.group(2)
            self._window_id = secrets.token_hex(11)
            self._uri = uri
            self._media_revision = 0
            self._ended_revision = -1
            self._near_end_seen = False
            self._near_end_at = 0.0
            self._end_played_progress = 0.0
            self._requested_device_id = device_id
            self._manual_show = False
            self._profile_path = profile
            self._started = time.time()
            self._running = True
            self._status = "opening"
            self._message = "EveOS will attempt the Spotify card Play button automatically."
            self._state = {"paused": True, "currentTime": 0, "duration": 0}
            self._desired_gain = max(0, min(1, float(body.get("gain", 1))))
            self._autoplay_attempted = False
            self._autoplay_attempted_revision = -1
            self._manual_pause_revision = -1
            self._autoplay_status = "waiting-for-card"
            self._hide_pending = False
            self._hidden = False
            self._last_position_at = 0.0
            self._last_progress_position = None
            self._confirmed_progress = 0.0
            self._hide_progress_tick = -1
            self._last_hide_attempt_at = -999.0
            self._applied_gain = {}
            self._generation += 1
            generation = self._generation
            stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
            self._report = Path.home() / "Downloads" / "EveOS-Diagnostics" / "Spotify-Edge-Integration" / f"embed-{stamp}.jsonl"
            query = urlencode({"uri": uri, "session": self._nonce, "windowId": self._window_id})
            page = f"http://127.0.0.1:{int(server_port)}/server/spotify-embed-edge.html?{query}"
            profile.mkdir(parents=True, exist_ok=True)
            try:
                self._launch([edge, f"--user-data-dir={profile}", "--no-first-run",
                              "--no-default-browser-check", "--window-size=780,470", f"--app={page}"],
                             stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                             stderr=subprocess.DEVNULL, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
            except Exception:
                self._running = False
                self._status = "error"
                raise
            self._record("launched", mediaType=match.group(1), endpoint=device_id or "CABLE Input")
            threading.Thread(target=self._run_route, args=(generation, device_id), daemon=True,
                             name="eveos-spotify-edge-route").start()
            return self.status()

    def event(self, body):
        from server_modules.audioflix_spotify_edge_session import event
        return event(self, body)

    def controls(self, token):
        with self._lock:
            if not self._running or not secrets.compare_digest(str(token), self._nonce):
                return {"ok": False, "commands": []}
            result, self._pending = self._pending, []
            return {"ok": True, "commands": result}

    def command(self, data, server_port):
        action = str(data.get("action") or "").strip().lower()
        payload = data.get("payload") if isinstance(data.get("payload"), dict) else {}
        with self._lock:
            if action == "play":
                return self.play(payload, server_port)
            if action == "status":
                return self.status()
            if action == "stop":
                return self._stop_locked()
            if action == "switch":
                from server_modules.audioflix_spotify_edge_session import switch_track
                return switch_track(self, payload)
            if action == "hide":
                from server_modules.audioflix_spotify_edge_window import hide_exact_window
                if self._status != "cable-routed" and self._state.get("paused") is not True:
                    return {"ok": False, "reason": "CABLE routing must be confirmed before hiding an audible song."}
                ok = hide_exact_window(self._process_finder(self._profile_path), self._window_id or self._track_id)
                if ok:
                    self._manual_show = False
                    self._hidden = True
                    self._record("window-hidden", success=True, requested=True)
                return {"ok": bool(ok), "status": "hidden" if ok else "exact-window-unavailable"}
            if action == "show":
                if not self._running:
                    return {"ok": False, "reason": "Spotify Edge is not active."}
                from server_modules.audioflix_spotify_edge_window import show_exact_window
                ok = show_exact_window(self._process_finder(self._profile_path), self._window_id or self._track_id)
                if ok:
                    self._hidden = False
                    self._manual_show = True
                    self._record("window-shown", requested=True)
                return {"ok": ok, "visible": ok}
            if action in {"pause", "resume", "seek"}:
                if not self._running:
                    return {"ok": False, "reason": "Spotify Edge player is not active."}
                if action == "pause":
                    self._manual_pause_revision = self._media_revision
                if action == "resume":
                    self._manual_pause_revision = -1
                    from server_modules.audioflix_spotify_edge_lifecycle import resume_if_stalled
                    generation, revision = self._generation, self._media_revision
                    threading.Thread(target=resume_if_stalled, args=(self, generation, revision),
                                     daemon=True, name="eveos-spotify-edge-resume-watch").start()
                self._seq += 1
                cmd = {"seq": self._seq, "action": action, "revision": self._media_revision}
                if action == "seek":
                    cmd["seconds"] = max(0, float(payload.get("seconds") or 0))
                self._pending.append(cmd)
                return {"ok": True, "status": "queued", "controlNotYetConfirmed": True}
            if action == "volume":
                if not self._running or not self._backend or not self._routes:
                    return {"ok": False, "reason": "No confirmed Edge audio route yet."}
                self._desired_gain = max(0, min(1, float(payload.get("gain", 1))))
                changed = 0
                live = self._process_finder(self._profile_path)
                for pid, (born, _) in self._routes.items():
                    if pid not in live or abs(live[pid] - born) > 1:
                        continue
                    count = self._backend.volume(pid, self._desired_gain, self._target)
                    changed += count
                    if count:
                        self._applied_gain[pid] = self._desired_gain
                if not changed:
                    return {"ok": False, "reason": "No verified Spotify session accepted volume."}
                return {"ok": True, "sessions": changed, "gain": self._desired_gain}
        return {"ok": False, "reason": "Unknown Spotify Edge command."}


_manager = EdgeSpotifyManager()
status = _manager.status
command = _manager.command
event = _manager.event
controls = _manager.controls
