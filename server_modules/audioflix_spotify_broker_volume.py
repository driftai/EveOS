"""Run-scoped managed volume mutation; unmarked clients retain the legacy contract."""
from __future__ import annotations

from server_modules import audioflix_spotify_browser_rpc as engine
from server_modules import audioflix_spotify_broker_preemption as preemption

_MARKERS = ("ownerEpoch", "engineEpoch", "trackGeneration")


def _rejected(reason: str) -> dict:
    return {**preemption.SUPERSEDED_RESULT, "resyncRequired": True, "reason": reason}


def execute(broker, client_id: str, args: dict, spotify_id) -> dict:
    fenced = any(key in args for key in _MARKERS)
    expected_started_at = None
    if fenced:
        if not all(key in args and isinstance(args[key], int) and not isinstance(args[key], bool)
                   and args[key] >= 0 for key in _MARKERS):
            return _rejected("Spotify volume requires the complete valid playback marker tuple.")
        # Refresh identity before validation: the post-mutation state read is too late to fence a restart.
        managed = engine.status()
        expected_started_at = int(managed.get("engineStartedAt") or 0)
        transport = managed.get("transport")
        helper_generation = transport.get("generation") if isinstance(transport, dict) else None
        with broker._lock:
            broker._sync_engine_epoch_locked(managed)
            if not isinstance(helper_generation, int) or isinstance(helper_generation, bool) or helper_generation < 0:
                return _rejected("Spotify volume cannot prove the current helper playback generation.")
            broker._track_generation = max(broker._track_generation, helper_generation)
            current = (broker._owner_epoch, broker._engine_epoch, broker._track_generation)
            if (not managed.get("helperReachable") or expected_started_at <= 0
                    or broker._owner_client_id != client_id
                    or args["trackGeneration"] != helper_generation
                    or tuple(args[key] for key in _MARKERS) != current):
                return _rejected("Spotify volume belongs to an obsolete playback or ownership generation.")
    else:
        # Explicit compatibility: older clients may still acquire an ownerless engine through volume.
        with broker._lock:
            owner = broker._owner_client_id
            client = broker._clients.get(client_id)
            if not owner and client:
                broker._acquire_locked(client)
                owner = client_id
        if owner and owner != client_id:
            return {**broker._state(client_id), "ok": False, "observer": True,
                    "reason": "Another EveOS tab owns Spotify playback. Use Take control or Play to transfer it."}

    gain = max(0.0, min(1.0, float(args.get("effectiveVolume") if args.get("effectiveVolume") is not None else 1)))
    track_id = spotify_id(args.get("spotifyId") or "")
    volume = (engine.set_effective_volume(gain, track_id, expected_started_at=expected_started_at,
                                        expected_generation=args["trackGeneration"])
              if fenced else engine.set_effective_volume(gain, track_id))
    outcome = {key: volume[key] for key in ("superseded", "lifecycle", "resyncRequired", "reason") if key in volume}
    return {**broker._state(client_id), **outcome, "volumeResult": volume, "ok": bool(volume.get("ok"))}
