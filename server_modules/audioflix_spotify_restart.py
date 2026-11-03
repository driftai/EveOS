"""Web-process-owned Spotify teardown for selective EveOS updates.

This module runs only inside the EveOS web process. It uses the existing broker and managed helper
objects that actually own playback, so Local Control never creates a second Spotify owner.
"""
from __future__ import annotations

from server_modules import audioflix_spotify_broker as broker
from server_modules import audioflix_spotify_broker_capture as capture_control
from server_modules import audioflix_spotify_browser_rpc as engine


def prepare_restart(payload: dict | None = None) -> dict:
    """Publish an explicit stopped state, release broker ownership, then stop the verified helper.

    The returned snapshot contains only restart-safe configuration. It never contains helper tokens,
    private session IDs, cookies, or profile contents.
    """
    del payload
    owned = broker._broker
    with owned._transport_lock:
        before = engine.status()
        helper_reachable = before.get("helperReachable") is True
        browser_running = before.get("browserRunning") is True
        should_restore = helper_reachable or browser_running
        page_url = str(before.get("pageUrl") or "")
        desired_volume = before.get("desiredVolume")
        auth_state = str(before.get("authState") or "unknown")
        presentation = str(before.get("presentation") or "hidden")
        transition = {"ok": True, "skipped": True, "reason": "Managed Spotify helper was not reachable."}

        # A reachable helper can outlive its Playwright page/context. In that exact terminal
        # state no playback or PCM source remains to stop. Do not forge a transport ACK: record
        # that the transition was skipped, retire broker ownership, and close the helper.
        # Any unknown/active media state must still attempt the normal stop and fail closed.
        capture_state = before.get("providerCapture")
        page_closed_idle = (
            helper_reachable and before.get("state") == "page-closed"
            and before.get("pageAttached") is False
            and before.get("playingCount") == 0
            and before.get("transport") is None
            and isinstance(capture_state, dict)
            and capture_state.get("active") is False
        )
        if page_closed_idle:
            transition = {
                "ok": False, "skipped": True, "lifecycle": "page-closed",
                "reason": "Closed Engine page has no transport to acknowledge stop.",
            }
        elif helper_reachable:
            # `stop` is a transport reset, not Ended. It leaves the queue scheduler with the
            # controller and provides one explicit terminal transition before helper teardown.
            transition = engine.transport({"action": "stop"})
            if transition.get("ok") is not True:
                return {
                    "ok": False,
                    "stage": "stop-transition",
                    "reason": transition.get("reason") or "Spotify helper did not acknowledge the stop/reset transition.",
                    "helperWasRunning": should_restore,
                    "helperReachable": helper_reachable,
                    "pageUrl": page_url,
                    "authState": auth_state,
                    "presentation": presentation,
                }

        # Retire managed PCM capture while the owner can still release it; a transport stop resets
        # playback only, and a stranded capture lease would block Direct Embed after the restart.
        capture_stop = (capture_control.retire_for_engine_stop() if helper_reachable
                        else {"ok": True, "skipped": True, "reason": "Managed Spotify helper was not reachable."})

        with owned._lock:
            previous_owner = owned._owner_client_id
            owned._owner_client_id = ""
            owned._owner_epoch += 1

        stopped = engine.stop_engine() if should_restore else {"ok": True, "state": "stopped", "alreadyStopped": True}
        if stopped.get("ok") is not True:
            return {
                "ok": False,
                "stage": "helper-stop",
                "reason": stopped.get("reason") or stopped.get("message") or "Managed Spotify helper did not stop cleanly.",
                "helperWasRunning": should_restore,
                "helperReachable": helper_reachable,
                "pageUrl": page_url,
                "authState": auth_state,
                "presentation": presentation,
                "previousOwner": bool(previous_owner),
                "stopTransition": transition,
                "captureStop": capture_stop,
            }

        return {
            "ok": True,
            "stage": "prepared",
            "helperWasRunning": should_restore,
            "helperReachable": helper_reachable,
            "pageUrl": page_url,
            "authState": auth_state,
            "presentation": presentation,
            "desiredVolume": desired_volume,
            "previousOwner": bool(previous_owner),
            "stopTransition": transition,
            "captureStop": capture_stop,
            "helperStop": stopped,
            "autoplayRequested": False,
            "endedManufactured": False,
        }
