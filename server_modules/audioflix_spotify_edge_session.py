"""Session-scoped Spotify Edge state and media identity fencing.

The official iframe owns playback and entitlement. These callbacks only report
state, control the dedicated host, and trigger the existing EveOS queue owner.
"""
import re
import threading
import time

URI = re.compile(r"^spotify:(track|episode):([A-Za-z0-9]{22})$")
SD = re.compile(r"^sd:\d+$")
HIDE_AFTER_PROGRESS_SECONDS = 38.0


def status(self):
    with self._lock:
        state = dict(self._state)
        return {"ok": True, "running": self._running, "status": self._status,
                "message": self._message, "identity": self._uri,
                "mediaRevision": self._media_revision, "endedRevision": self._ended_revision,
                "deviceName": self._target_name, "routeConfirmed": self._status == "cable-routed",
                "pids": sorted(self._routes), "state": state,
                "nativeControl": self._running,
                "manualPlayRequired": state.get("paused") is not False,
                "autoPlayStatus": self._autoplay_status, "windowHidden": self._hidden,
                "failure": {"revision": self._failure_revision, "kind": self._failure_kind,
                            "reason": self._failure_reason, "terminal": self._failure_terminal},
                "manualShow": self._manual_show,
                "hideGate": {"requiredProgressSeconds": HIDE_AFTER_PROGRESS_SECONDS,
                             "confirmedProgressSeconds": round(self._confirmed_progress, 2),
                             "pending": self._hide_pending,
                             "reason": ("shown-by-user" if self._manual_show else
                                        "hidden" if self._hidden else
                                        "waiting-for-cable" if self._status != "cable-routed" else
                                        "waiting-for-playback" if state.get("paused") is not False else
                                        "waiting-for-progress" if self._confirmed_progress < HIDE_AFTER_PROGRESS_SECONDS else
                                        "hide-attempt-eligible"),
                             "secondsSinceUpdate": round(time.monotonic() - self._last_position_at, 1)
                                  if self._last_position_at else None}}


def reset_progress(self):
    self._state = {"paused": True, "currentTime": 0, "duration": 0, "ended": False}
    self._last_position_at = 0.0
    self._last_progress_position = None
    self._confirmed_progress = 0.0
    self._hide_progress_tick = -1
    self._hide_pending = False
    self._last_hide_attempt_at = -999.0
    self._ended_revision = -1
    self._near_end_seen = False
    self._near_end_at = 0.0
    self._end_played_progress = 0.0
    self._route_completion_safe = False
    self._failure_revision = -1
    self._failure_kind = ""
    self._failure_reason = ""
    self._failure_terminal = False


def switch_track(self, payload):
    from server_modules.audioflix_spotify_edge import URI, SD
    uri = str(payload.get("spotifyUri") or "")
    match = URI.fullmatch(uri)
    if not match: raise ValueError("Use a valid Spotify track or episode URI.")
    requested = str(payload.get("deviceId") or "")
    if requested and not SD.fullmatch(requested):
        raise ValueError("The chosen output must be a native sd:N endpoint.")
    if not self._running or self._status in {"close-required", "route-error", "stopped"}:
        return {"ok": False, "reason": "No healthy Spotify Edge host to reuse."}
    if requested != self._requested_device_id:
        return {"ok": False, "reason": "Output endpoint changed; Stop and reopen Spotify Edge explicitly."}
    try: requested_gain = float(payload.get("gain", self._desired_gain))
    except (ValueError, TypeError): raise ValueError("Invalid Spotify Edge gain.")
    if not 0 <= requested_gain <= 1:
        raise ValueError("Invalid Spotify Edge gain.")
    # The same URI may occur twice in the queue. Every explicit Play means
    # a *new* media revision; Resume does not change this revision.
    self._media_revision += 1
    self._autoplay_attempted_revision = -1
    self._manual_pause_revision = -1
    self._track_id = match.group(2)
    self._uri = uri
    self._desired_gain = requested_gain
    self._applied_gain.clear()  # route worker reapplies gain to exact active session
    reset_progress(self)
    self._autoplay_status = "waiting-for-new-card"
    self._seq += 1
    self._pending = [{"seq": self._seq, "action": "load", "uri": uri,
                      "revision": self._media_revision}]
    self._message = "Updating song in existing Spotify Edge window."
    self._record("track-switched", revision=self._media_revision, mediaType=match.group(1),
                 retainedWindow=True, hidden=self._hidden)
    from server_modules.audioflix_spotify_edge_lifecycle import watch_playback_start
    threading.Thread(target=watch_playback_start,
                     args=(self, self._generation, self._media_revision), daemon=True,
                     name="eveos-spotify-edge-switch-watchdog").start()
    return self.status()


def event(self, body):
    import secrets
    from server_modules.audioflix_spotify_edge_lifecycle import hide_when_playing, _verified_progress
    with self._lock:
        if not self._running or not secrets.compare_digest(str(body.get("session") or ""), self._nonce):
            return {"ok": False, "reason": "Unknown Edge playback session."}
        kind = str(body.get("kind") or "")
        try: revision = int(body.get("revision", 0))
        except (ValueError, TypeError): return {"ok": False, "reason": "Invalid media revision."}
        if revision != self._media_revision:
            return {"ok": False, "reason": "Stale Spotify media event."}
        playing_uri = str(body.get("playingURI") or "")
        if playing_uri and playing_uri != self._uri:
            return {"ok": False, "reason": "Spotify event does not match selected song."}
        if revision > 0 and kind in {"started", "position", "ended"} and not playing_uri:
            return {"ok": False, "reason": "Spotify event is missing its media identity."}
        if kind == "ended":
            if self._ended_revision == revision:
                return {"ok": True, "duplicate": True}
            # A finished song can drop its active Windows audio session
            # before the SDK delivers Ended. Route-pending is acceptable
            # only while the route worker has verified the same owned
            # endpoint is still assigned; all near-end fences remain.
            route_ready = self._status == 'cable-routed' or (
                self._status == 'route-pending' and self._route_completion_safe)
            if (not route_ready or not self._near_end_seen
                    or time.monotonic() - self._near_end_at > 12
                    or self._end_played_progress < 1.5 or self._state.get("duration", 0) <= 0
                    or self._manual_pause_revision == revision):
                self._record("completion-rejected", revision=revision,
                             reason=("route-not-verified" if not route_ready
                                     else "recent-near-end-progress-missing"))
                return {"ok": False, "reason": "No recent verified near-end playback evidence."}
            self._ended_revision = revision
            self._state["ended"] = True
            self._state["paused"] = True
            self._record("track-ended", revision=revision)
            return {"ok": True}
        if kind == "position":
            try: seconds = float(body.get("currentTime", 0)); duration = float(body.get("duration", 0))
            except (ValueError, TypeError): return {"ok": False, "reason": "Invalid position."}
            if not 0 <= seconds <= 43200 or not 0 <= duration <= 43200:
                return {"ok": False, "reason": "Invalid position."}
            now = time.monotonic()
            playing = body.get("paused") is False and self._status == "cable-routed"
            previous = self._last_progress_position
            elapsed = now - self._last_position_at if self._last_position_at else 0.0
            progressed = seconds - previous if previous is not None else 0.0
            if not playing or not 0 < elapsed <= 5 or not 0 < progressed <= elapsed * 1.5 + 1:
                self._confirmed_progress = 0.0
            else:
                self._confirmed_progress += min(progressed, elapsed)
            self._state.update(currentTime=seconds, duration=duration,
                               paused=body.get("paused") is not False)
            # Timestamp this exact, validated position before checking freshness;
            # the prior timestamp was only for calculating progress/elapsed.
            self._last_position_at = now
            # A lone paused=False at position zero does not prove that Spotify
            # actually started. Confirm only from advancing, routed progress.
            if playing and _verified_progress(self, revision):
                if self._autoplay_status != "confirmed":
                    self._autoplay_status = "confirmed"
                    self._message = "Spotify playback and CABLE route confirmed."
                self._failure_revision = -1
                self._failure_kind = ""
                self._failure_reason = ""
                self._failure_terminal = False
            if playing and 0 < elapsed <= 5 and 0 < progressed <= elapsed * 1.5 + 1:
                self._end_played_progress += min(progressed, elapsed)
            # Witness from the last few seconds of actual, advancing playback.
            # Spotify may not report the final two seconds until it is paused.
            if (playing and self._end_played_progress >= 1.5 and duration > 0
                    and seconds >= max(0, duration - 8)):
                self._near_end_seen = True
                self._near_end_at = now
            self._last_progress_position = seconds
            tick = int(self._confirmed_progress // 5)
            if tick > self._hide_progress_tick and self._confirmed_progress > 0:
                self._hide_progress_tick = tick
                self._record("hide-progress", seconds=round(self._confirmed_progress, 2),
                             required=HIDE_AFTER_PROGRESS_SECONDS, route=self._status)
            if (self._confirmed_progress >= HIDE_AFTER_PROGRESS_SECONDS and playing
                    and not self._hidden and not self._manual_show and not self._hide_pending
                    and now - self._last_hide_attempt_at >= 10):
                self._last_hide_attempt_at = now; self._hide_pending = True
                threading.Thread(target=hide_when_playing, args=(self, self._generation),
                                 daemon=True, name="eveos-spotify-edge-hide").start()
            return {"ok": True}
        if kind == "ready":
            self._message = "Spotify card ready; attempting Windows UI Automation Play."
            if not self._autoplay_attempted:
                self._autoplay_attempted = True
                from server_modules.audioflix_spotify_edge_lifecycle import attempt_card_play
                threading.Thread(target=attempt_card_play, args=(self, self._generation),
                                 daemon=True, name="eveos-spotify-edge-autoplay").start()
        if kind == "media-loaded":
            # The SDK has finished switching identities. Initial-ready UIA is
            # not repeated for queue tracks unless the new loaded revision
            # explicitly reports itself; duplicates cannot start two workers.
            if revision > 0 and self._autoplay_attempted_revision != revision:
                self._autoplay_attempted_revision = revision
                self._record("media-loaded", revision=revision, hidden=self._hidden)
                from server_modules.audioflix_spotify_edge_lifecycle import attempt_card_play
                threading.Thread(target=attempt_card_play,
                                 args=(self, self._generation, revision, 1.0),
                                 daemon=True, name="eveos-spotify-edge-switch-play").start()
            return {"ok": True}
        if kind == "play-failed":
            # SDK autoplay failure may be temporary (hidden window / gesture
            # policy). The exact-window recovery and absolute startup watchdog
            # decide termination; this event alone must never skip a good URL.
            self._message = "Spotify reported an autoplay failure; exact-owner recovery pending."
            self._failure_revision = revision
            self._failure_kind = "provider-play-failed"
            self._failure_reason = "Spotify's official embed reported an autoplay failure."
            self._failure_terminal = False
            self._record("switch-autoplay-failed", revision=revision)
        return {"ok": True}


def volume_command(self, payload):
    """Apply revision-fenced native gain to the exact Spotify Edge session.

    Called by EdgeSpotifyManager.command() while the session lock is held;
    session ownership, applied-gain cache and retry-on-route remain unchanged.
    """
    if not self._running:
        return {"ok": False, "reason": "No active Official Embed owner."}
    if payload.get("spotifyUri") and payload["spotifyUri"] != self._uri:
        return {"ok": False, "reason": "Volume belongs to a different Spotify song."}
    if payload.get("revision") is not None:
        try: revision = int(payload["revision"])
        except (TypeError, ValueError): return {"ok": False, "reason": "Invalid volume revision."}
        if revision != self._media_revision:
            return {"ok": False, "reason": "Volume belongs to a stale Spotify revision."}
    try: value = float(payload.get("gain", 1))
    except (TypeError, ValueError): return {"ok": False, "reason": "Invalid Spotify volume."}
    if not 0 <= value <= 1:
        return {"ok": False, "reason": "Spotify volume must be between 0 and 1."}
    self._desired_gain = value
    changed = 0
    live = self._process_finder(self._profile_path)
    for pid, (born, _) in list(self._routes.items()):
        if pid not in live or abs(live[pid] - born) > 1 or not self._backend:
            continue
        try:
            count = self._backend.volume(pid, value, self._target)
        except Exception as exc:
            self._record("gain-pending", reason=type(exc).__name__)
            continue  # Route worker retries the latest requested gain.
        changed += count
        if count: self._applied_gain[pid] = value
    return {"ok": True, "status": "applied" if changed else "pending-session",
            "applied": bool(changed), "sessions": changed, "gain": value}
