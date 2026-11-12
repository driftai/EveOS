"""Lifecycle workers for a single exact-owner Spotify Edge embed window."""
from __future__ import annotations

import time

def _verified_progress(self, revision):
    """Only revision-owned, advancing, recently routed audio proves playback.

    paused=False at position zero is NOT proof, and neither is a UIA Invoke
    receipt. Called with the session's lock held.
    """
    return (self._running and revision == self._media_revision
            and self._status == 'cable-routed'
            and self._state.get('paused') is False
            and self._confirmed_progress >= 2.0
            and float(self._state.get('currentTime') or 0) >= 2.0
            and self._last_position_at > 0
            and 0 <= time.monotonic() - self._last_position_at <= 3.0)

def attempt_card_play(self, generation, revision=None, delay=0):
    """Attempt the actual Spotify Play button for this exact media revision.

    The first host launch invokes UIA from `ready`. A queue switch sends
    `media-loaded` for its own revision and schedules this bounded follow-up.
    Never click a stale song, a manually paused song, or a player that is
    already confirmed playing. Never reveal a hidden window without consent.
    """
    from server_modules import audioflix_spotify_edge_window as window
    if delay:
        time.sleep(min(float(delay), 2.0))
    with self._lock:
        if generation != self._generation or not self._running:
            return
        if revision is not None and revision != self._media_revision:
            return
        if _verified_progress(self, self._media_revision):
            self._record("auto-play-not-needed", revision=self._media_revision)
            return
        if self._manual_pause_revision == self._media_revision:
            self._record("auto-play-suppressed-user-pause", revision=self._media_revision)
            return
        captured_revision = self._media_revision
        pids = self._process_finder(self._profile_path)
        track = self._window_id or self._track_id
    # The exact revision is captured before invoking a potentially slow UIA
    # helper. A superseding Play, Stop, or user Pause invalidates the attempt.
    def still_current():
        with self._lock:
            return (self._running and generation == self._generation and
                    captured_revision == self._media_revision and
                    self._manual_pause_revision != captured_revision and
                    not _verified_progress(self, captured_revision))
    def rehide_allowed():
        with self._lock:
            return (self._running and generation == self._generation and
                    self._hidden and not self._manual_show)
    def playback_confirmed():
        with self._lock:
            return (self._running and generation == self._generation and
                    captured_revision == self._media_revision and
                    _verified_progress(self, captured_revision))
    result = window.try_card_play(pids, track, should_attempt=still_current,
                                  should_rehide=rehide_allowed,
                                  playback_confirmed=playback_confirmed)
    # One bounded same-window retry for both the first card and later queue
    # revisions. Never retry a manual Pause, a superseded revision, or an
    # unowned window.
    retry_used = False
    if not playback_confirmed() and (
            result.get("ok") or result.get("reason") == "EVE_UIA_PLAY_CONTROL_UNAVAILABLE"):
        time.sleep(1.0)
        if still_current() and not playback_confirmed():
            retry_used = True
            result = window.try_card_play(pids, track, should_attempt=still_current,
                                          should_rehide=rehide_allowed,
                                          playback_confirmed=playback_confirmed)
    # A verified progress receipt may arrive just after UIA exits.
    if playback_confirmed():
        result = {**result, "playbackConfirmed": True}
    with self._lock:
        if generation != self._generation or not self._running or captured_revision != self._media_revision:
            return
        routed = self._status == "cable-routed"
        confirmed = result.get("playbackConfirmed") is True
        invoked = result.get("ok") is True
        self._autoplay_status = ("confirmed" if result.get("playbackConfirmed") else
                                 "invoked-unconfirmed" if result.get("ok") else "manual-fallback")
        self._record("auto-play", revision=captured_revision, hidden=self._hidden,
                     outcome=self._autoplay_status, offscreenAssist=result.get("offscreenAssist", False),
                     playbackConfirmed=result.get("playbackConfirmed", False),
                     retryUsed=retry_used, reason=result.get("reason", "")[:80])
        if confirmed:
            self._failure_revision = -1
            self._failure_kind = ""
            self._failure_reason = ""
            self._failure_terminal = False
        elif invoked and routed and self._manual_pause_revision != captured_revision:
            # Invoked is NOT played. Leave the revision pending until the
            # backend-owned startup deadline has witnessed actual progress (or
            # expires). An inaccessible hidden window is not proof of a bad URL.
            self._failure_revision = captured_revision
            self._failure_kind = "provider-playback-unconfirmed"
            self._failure_reason = "Spotify Play was invoked but playback is not yet verified."
            self._failure_terminal = False
        else:
            self._failure_revision = captured_revision
            self._failure_kind = "host-control-unavailable" if not invoked else "route-not-ready"
            self._failure_reason = str(result.get("reason") or "Spotify playback is not yet confirmed.")[:180]
            self._failure_terminal = False
        if result.get("ok"):
            self._message = ("Spotify Play was confirmed on CABLE." if result.get("playbackConfirmed")
                             else "Spotify Play was invoked but has not been confirmed on CABLE; use Show Spotify if paused.")
        else:
            self._message = ("Automatic Play could not invoke the current Spotify card while "
                             "hidden. Use Show Spotify if the SDK does not start playback."
                             if self._hidden else "Automatic Play unavailable. Press Play on the Spotify card.")


def watch_playback_start(self, generation, revision, delay=6.0, deadline=30.0):
    """Break hidden-renderer deadlocks and terminate one exact stalled revision.

    The renderer normally claims autoplay from ready/media-loaded. If background
    throttling prevents that callback, this backend-owned deadline claims and
    invokes the same exact-window path. It never retries a user Pause or a
    superseded revision, and never labels an ambiguous timeout as unavailable.
    """
    # One absolute revision-owned deadline: UIA retries must not extend it
    # after a hidden callback has already stalled for several seconds.
    expires = time.monotonic() + max(float(delay), float(deadline))
    time.sleep(delay)
    claim = False
    with self._lock:
        if (not self._running or generation != self._generation
                or revision != self._media_revision
                or self._manual_pause_revision == revision
                or _verified_progress(self, revision)
                or self._autoplay_status == "confirmed"):
            return
        if revision == 0:
            claim = not self._autoplay_attempted
            self._autoplay_attempted = True
        else:
            claim = self._autoplay_attempted_revision != revision
            self._autoplay_attempted_revision = revision
        if claim:
            self._record("startup-watchdog-claimed", revision=revision, hidden=self._hidden)
    if claim:
        attempt_card_play(self, generation, revision)
    while time.monotonic() < expires:
        with self._lock:
            if (not self._running or generation != self._generation
                    or revision != self._media_revision
                    or self._manual_pause_revision == revision
                    or _verified_progress(self, revision)
                    or self._autoplay_status == "confirmed"
                    or (self._failure_revision == revision and self._failure_terminal)):
                return
        time.sleep(0.5)
    with self._lock:
        if (not self._running or generation != self._generation
                or revision != self._media_revision
                or self._manual_pause_revision == revision
                or _verified_progress(self, revision)
                or self._autoplay_status == "confirmed"):
            return
        self._failure_revision = revision
        self._failure_kind = "provider-start-timeout"
        self._failure_reason = "Spotify did not produce playback before the bounded startup deadline."
        self._failure_terminal = True
        self._autoplay_status = "failed-timeout"
        self._message = "Spotify playback failed after bounded exact-window retries; advancing safely."
        self._record("startup-watchdog-terminal", revision=revision, hidden=self._hidden)
    # A verified terminal failure may advance only its explicit native queue lease.
    from server_modules.audioflix_spotify_edge_queue import on_terminal
    on_terminal(self, revision)

def hide_when_playing(self, generation):
    from server_modules import audioflix_spotify_edge_window as window
    time.sleep(1.2)  # avoid hiding on a transient state change
    with self._lock:
        if generation != self._generation or not self._running:
            return
        if (self._state.get("paused") is not False or
                self._confirmed_progress < self._hide_threshold() or
                time.monotonic() - self._last_position_at > 3 or
                self._status != "cable-routed" or self._manual_show):
            self._hide_pending = False
            return
        pids = self._process_finder(self._profile_path)
        track = self._window_id or self._track_id
    matches = window.matching_windows(pids, track)
    hidden = window.hide_exact_window(pids, track) if len(matches) == 1 else False
    with self._lock:
        if generation != self._generation or not self._running:
            return
        self._hidden = bool(hidden)
        self._hide_pending = False
        self._record("window-hidden", success=bool(hidden),
                     exactWindowMatches=len(matches), ownedProcessCount=len(pids),
                     confirmedProgress=round(self._confirmed_progress, 2))
        if not hidden:
            self._message = ("Edge could not be hidden: exact owned window unavailable."
                             if len(matches) != 1 else "Windows refused to hide the Spotify Edge window.")
    # A hidden host is sticky for this session. Pauses, ended tracks, and queue
    # switches do not show it. The explicit AudioFlix Show control always can.
    return


def resume_card(self, generation):
    """Restore only this app window and try native card Play, never SDK resume."""
    from server_modules import audioflix_spotify_edge_window as window
    with self._lock:
        if generation != self._generation or not self._running:
            return
        if self._state.get("paused") is False:
            return
        pids = self._process_finder(self._profile_path)
        track = self._window_id or self._track_id
    if self._hidden:
        if not window.show_exact_window(pids, track):
            with self._lock:
                self._message = "Cannot show Spotify card; resume manually when available."
            return
        with self._lock:
            self._hidden = False
    attempt_card_play(self, generation)


def resume_if_stalled(self, generation, revision):
    """Try official SDK Resume in the hidden card; reveal for UIA only on real failure."""
    from server_modules import audioflix_spotify_edge_window as window
    time.sleep(4)
    with self._lock:
        if generation != self._generation or revision != self._media_revision or not self._running:
            return
        if self._state.get("paused") is False:
            return
        self._message = "Spotify did not resume automatically; use Show Spotify to press Play."
        self._record("resume-unconfirmed", revision=revision)
