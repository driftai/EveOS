"""Continuous, isolated Windows audio-session routing for the dedicated Edge card.

The Spotify host remains the player; this helper only assigns *owned* audio
sessions to the exact selected output, with verified initial gain.
"""
from __future__ import annotations
import time
from server_modules.audioflix_spotify_edge import _unique_cable


def run_route(manager, generation, device_id):
    """Keep just the owned, active Edge sessions routed while the host lives.

    The previous worker returned after first success. Edge may later replace its
    audio process or session, so success is not a permanent routing guarantee.
    """
    try:
        from server_modules.audioflix_spotify_windows_output import NativeWindowsBackend
        backend = manager._backend_factory() if manager._backend_factory else NativeWindowsBackend()
        target = backend.resolve(device_id) if device_id else _unique_cable(backend)
        with manager._lock:
            if generation != manager._generation or not manager._running:
                return
            manager._backend = backend
            manager._target = target.id
            manager._target_name = target.name
        deadline = time.monotonic() + 65
        had_route = False
        while True:
            with manager._lock:
                if generation != manager._generation or not manager._running:
                    return
                profile = manager._profile_path
            live = manager._process_finder(profile)
            sessions = manager._session_finder(backend, live)
            # Reassign only newly identified session owners. Revalidate any
            # previously routed PID because Windows can change its endpoint.
            for pid, _, _ in sessions:
                if pid not in live:
                    continue
                with manager._lock:
                    if generation != manager._generation or not manager._running:
                        return
                    saved = manager._routes.get(pid)
                    if saved and abs(saved[0] - live[pid]) > 1:
                        # The numeric PID was reused, not the same process.
                        manager._routes.pop(pid, None)
                        manager._applied_gain.pop(pid, None)
                        saved = None
                    current = backend.get(pid)
                    if not saved:
                        previous = current
                        manager._routes[pid] = (live[pid], previous)
                    if current != target.id:
                        backend.set(pid, target.id)
                        if backend.get(pid) != target.id:
                            raise RuntimeError(f"Windows audio route readback failed for PID {pid}")
                        manager._record("route-assigned", pid=pid, target=target.name)
                        manager._applied_gain.pop(pid, None)
            # Routing is only acknowledged after the OS reports an active
            # session on the selected exact endpoint and applies requested gain.
            active = manager._session_finder(backend, manager._process_finder(profile))
            routed = [pid for pid, endpoint, _ in active
                      if endpoint == target.id and pid in manager._routes and
                      pid in live and abs(manager._routes[pid][0] - live[pid]) <= 1]
            gain_verified = bool(routed)
            with manager._lock:
                if generation != manager._generation or not manager._running:
                    return
                # A failed close must not be misreported as healthy playback.
                if manager._status == "close-required":
                    gain_verified = False
                for pid in routed:
                    desired = manager._desired_gain
                    if manager._applied_gain.get(pid) == desired:
                        continue
                    changed = backend.volume(pid, desired, target.id)
                    if not changed:
                        gain_verified = False
                        manager._record("gain-unconfirmed", pid=pid, requested=desired)
                    else:
                        manager._applied_gain[pid] = desired
                if gain_verified and manager._status != "close-required":
                    if manager._status != "cable-routed":
                        manager._record("route-confirmed", activePids=routed, target=target.name,
                                     secondsSinceLaunch=round(time.time() - manager._started, 2))
                    manager._status = "cable-routed"
                    manager._message = f"Windows session routed to {target.name}"
                    had_route = True
                elif had_route and manager._status != "close-required":
                    # Paused/stopped media naturally has no active Windows audio
                    # session. Never queue an extra Pause during normal Resume.
                    if manager._state.get("paused") is False:
                        if manager._status != "route-pending":
                            manager._record("route-lost", reason="session-or-gain-unconfirmed")
                            manager._seq += 1
                            manager._pending.append({"seq": manager._seq, "action": "pause"})
                        manager._message = "Spotify output changed; paused pending verified CABLE routing."
                    else:
                        manager._message = "Spotify paused; waiting for its next CABLE audio session."
                    manager._status = "route-pending"
                elif time.monotonic() >= deadline and manager._status != "close-required":
                    manager._status = "route-pending"
                    manager._message = "Spotify audio session not detected; press Play in its card."
            # Remain available for delayed manual Play and later PID changes.
            time.sleep(1.0 if had_route else (0.4 if time.monotonic() < deadline else 2.0))
    except Exception as exc:
        with manager._lock:
            if generation == manager._generation:
                manager._status = "route-error"
                manager._message = str(exc)[:240]
                manager._record("route-error", message=manager._message)
