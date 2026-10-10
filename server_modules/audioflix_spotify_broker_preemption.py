"""Control-plane preemption for the Spotify broker.

Ordinary transport stays serialized by the broker ``_transport_lock`` and the manager ``_lock``.
A newer *accepted* playback intent must not be trapped behind an older start, so once a command
has passed authentication, connection, ``commandId`` and ``clientCommandSeq`` acceptance, and
before it waits on ``_transport_lock``, it may send the helper one bounded, cancellation-only
interrupt. Commands queued behind the lock are fenced by the existing accepted client command
order: an older playback intent that later obtains the lock does no browser transport work.

No queue identity is created here: ``playbackRunId`` remains Audioflix's queue authority,
``_track_generation`` the engine-track identity and ``clientCommandSeq`` command ordering.
"""
from __future__ import annotations

from server_modules import audioflix_spotify_browser_rpc as engine

PREEMPTING = {"play": "superseded", "resume": "superseded", "restart": "superseded",
              "pause": "paused", "stop": "stopped"}

SUPERSEDED_RESULT = {
    "ok": False, "superseded": True, "lifecycle": "superseded",
    "reason": "A newer accepted Spotify command superseded this one before it ran.",
}


def _may_preempt_locked(broker, client_id: str, action: str) -> bool:
    # Mirror _execute_transport's ownership rules so an observer can never interrupt the owner.
    owner = broker._owner_client_id
    if action == "play":
        return True
    if action in {"pause", "stop"}:
        if owner:
            return owner == client_id
        # Ownerless first-launch window: Play acquires ownership only after _start_engine(), so
        # the initiating client may cancel its own pending start. It loses that authority as soon
        # as another client's newer intent is the latest, and an observer never has it.
        latest = getattr(broker, "_latest_intent", None)
        running = getattr(broker, "_running_intent", None)
        return bool(getattr(broker, "_transport_busy", False) and latest and running
                    and latest[0] == client_id and running[0] == client_id)
    return not owner or owner == client_id


def accept_locked(broker, client: dict, action: str, seq: int) -> tuple[str, tuple | None]:
    """Record the newest accepted playback intent as ``(clientId, clientCommandSeq)``.

    Called under ``broker._lock`` immediately after ``clientCommandSeq`` was accepted. Returns
    the helper interrupt reason (empty when nothing is in flight) and this command's fence token
    (None for non-intent or unauthorized commands, which _execute_transport rejects as before).
    """
    if action not in PREEMPTING or not _may_preempt_locked(broker, client["clientId"], action):
        return "", None
    token = (client["clientId"], seq)
    broker._latest_intent = token
    # Only work already holding _transport_lock can be preempted; otherwise the fence suffices.
    return (PREEMPTING[action] if getattr(broker, "_transport_busy", False) else ""), token


def send_interrupt(reason: str) -> dict:
    """Bounded best-effort helper interrupt sent outside every broker/manager lock."""
    if not reason:
        return {"ok": True, "skipped": True}
    try:
        return engine.interrupt(reason)
    except Exception as exc:  # A dead/stale helper must stay harmless.
        return {"ok": False, "reason": str(exc)[:200]}


def run_fenced(broker, token, execute):
    """Run ``execute`` under the already-held ``_transport_lock`` unless a newer intent won."""
    with broker._lock:
        if token is not None and getattr(broker, "_latest_intent", None) != token:
            return dict(SUPERSEDED_RESULT)
        broker._transport_busy = True
        broker._running_intent = token
    try:
        return execute()
    finally:
        with broker._lock:
            broker._transport_busy = False
            broker._running_intent = None


def still_current_locked(broker) -> bool:
    """Mid-execution fence (under ``broker._lock``): the executing intent is still the latest.

    Long pre-browser phases (first engine launch, up to its 135s budget) can outlive a newer
    accepted intent; the helper interrupt is best-effort while the helper is still launching,
    so this broker check is the authoritative guard before ownership/generation/Load/Play.
    """
    token = getattr(broker, "_running_intent", None)
    return token is None or getattr(broker, "_latest_intent", None) == token
