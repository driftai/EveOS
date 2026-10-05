"""Sidecar bridge from Nexus into the active EveOS Gemini Link workspace.

Nexus is a projection of the already-running interactive Gemini Live session. It must
never create a second Gemini personality, replace the owner session, or route user chat
through Text Brain / Mode 2 as an independent conversational model.
"""

import asyncio
import json

from main_server_files.media_processing.realtime_input_processor import process_realtime_input
from main_server_files.session_management.session_manager import active_sessions

_REQUEST_LOCK = asyncio.Lock()
_SUBSCRIBERS = {}


class NexusWorkspaceUnavailable(RuntimeError):
    """Raised when Nexus cannot bind unambiguously to the active Gemini Link workspace."""


def _workspace_candidates():
    candidates = []
    for connection_id, entry in list(active_sessions.items()):
        if not isinstance(entry, dict):
            continue
        if str(entry.get("session_role") or "interactive").strip().lower() != "interactive":
            continue
        if entry.get("session") is None:
            continue

        connection_monitor = entry.get("connection_monitor")
        if connection_monitor is not None:
            try:
                if not connection_monitor.is_websocket_open():
                    continue
            except Exception:
                continue

        candidates.append((connection_id, entry))
    return candidates


def _interactive_workspace(required_connection_id=None):
    """Return one exact interactive workspace, never an arbitrary Gemini session."""
    candidates = _workspace_candidates()

    if required_connection_id not in (None, ""):
        required = str(required_connection_id)
        for connection_id, entry in candidates:
            if str(connection_id) == required:
                return connection_id, entry
        raise NexusWorkspaceUnavailable(
            "The Gemini Link workspace Nexus was bound to is no longer active. "
            "Reconnect Gemini Link and select the refreshed workspace."
        )

    if not candidates:
        raise NexusWorkspaceUnavailable(
            "Gemini Link has no active interactive Live workspace to bind. "
            "Open/connect Gemini Link in EveOS first."
        )
    if len(candidates) > 1:
        raise NexusWorkspaceUnavailable(
            "More than one interactive Gemini Link workspace is registered. "
            "Nexus will not guess which workspace owns this turn; reconnect Gemini Link first."
        )
    return candidates[0]


def workspace_snapshot(required_connection_id=None):
    try:
        connection_id, entry = _interactive_workspace(required_connection_id)
    except NexusWorkspaceUnavailable as error:
        return {
            "bound": False,
            "state": "unavailable",
            "message": str(error),
        }

    return {
        "bound": True,
        "state": "ready",
        "connectionId": str(connection_id),
        "model": str(entry.get("model") or ""),
        "voiceName": str(entry.get("voice_name") or ""),
        "connectedAt": str(entry.get("connected_at") or ""),
        "sessionRole": "interactive",
        "provider": "gemini_link",
    }


def _subscribe(connection_id):
    queue = asyncio.Queue()
    _SUBSCRIBERS.setdefault(connection_id, set()).add(queue)
    return queue


def _unsubscribe(connection_id, queue):
    listeners = _SUBSCRIBERS.get(connection_id)
    if not listeners:
        return
    listeners.discard(queue)
    if not listeners:
        _SUBSCRIBERS.pop(connection_id, None)


def nexus_owns_audio(connection_id):
    """True only while an exact Nexus-origin workspace turn owns this Live reply."""
    return bool(_SUBSCRIBERS.get(connection_id))


def _publish(connection_id, event):
    for queue in list(_SUBSCRIBERS.get(connection_id, ())):
        try:
            queue.put_nowait(dict(event))
        except Exception:
            pass


async def publish_text(connection_id, text):
    value = str(text or "")
    if value:
        _publish(connection_id, {"type": "text", "text": value})


async def publish_transcription(connection_id, text):
    value = str(text or "").strip()
    if value:
        _publish(connection_id, {"type": "transcription", "text": value})


async def publish_audio(connection_id, audio_data, sample_rate=24000):
    if audio_data:
        _publish(connection_id, {
            "type": "audio",
            "audio": bytes(audio_data),
            "sampleRate": int(sample_rate or 24000),
            "encoding": "pcm_s16le",
            "channels": 1,
        })


async def publish_turn_complete(connection_id):
    _publish(connection_id, {"type": "turn_complete"})


async def publish_interrupted(connection_id, reason="provider_barge_in"):
    _publish(connection_id, {"type": "interrupted", "reason": str(reason or "provider_barge_in")})


async def _echo_nexus_user_message(entry, prompt, request_id):
    """Mirror a Nexus-originated user turn into Gemini Link's existing UI only.

    This event is deliberately sent only to the already-connected EveOS browser. It is
    never routed back through the provider input path, so rendering it cannot create a
    second Gemini turn or a shadow conversation.
    """
    connection_monitor = entry.get("connection_monitor")
    if connection_monitor is None:
        return
    try:
        await connection_monitor.safe_send(json.dumps({
            "type": "nexus_workspace_user_message",
            "requestId": str(request_id or ""),
            "text": str(prompt or "").strip(),
            "source": "nexus_browser",
            "is_system_message": False,
        }))
    except Exception as error:
        # The UI echo is presentation-only. Never make a healthy provider turn fail just
        # because the browser stopped accepting UI messages between workspace validation
        # and dispatch.
        print(f"Gemini Link Nexus UI echo failed: {error}")


async def _send_text_turn(entry, prompt, request_id=None):
    """Route a Nexus turn through the exact EveOS input pipeline used by Gemini Link."""
    session = entry.get("session")
    connection_monitor = entry.get("connection_monitor")
    audio_processor = entry.get("audio_processor")

    if session is None:
        raise NexusWorkspaceUnavailable("The active Gemini Link Live session is no longer available.")
    if connection_monitor is None:
        raise NexusWorkspaceUnavailable(
            "The active Gemini Link workspace predates Nexus bridge registration. "
            "Reconnect Gemini Link once so Nexus can attach to its normal EveOS input pipeline."
        )

    await _echo_nexus_user_message(entry, prompt, request_id)

    # Deliberately reuse the production realtime_input route. This keeps chat history,
    # pending Mode-2 context, screen/data-stream state, and the authoritative Gemini Live
    # session identical whether the user types in Gemini Link or in Nexus.
    await process_realtime_input(
        {
            "source": "nexus_workspace_request",
            "realtime_input": {
                "media_chunks": [
                    {
                        "mime_type": "text/plain",
                        "data": str(prompt or "").strip(),
                    }
                ]
            },
        },
        session,
        connection_monitor,
        audio_processor,
    )


async def stream_workspace_turn(
    prompt,
    request_id,
    timeout_seconds=180,
    workspace_connection_id=None,
):
    """Yield the exact active workspace's next provider turn, including PCM audio, to Nexus."""
    text = str(prompt or "").strip()
    if not text:
        raise ValueError("Gemini Link prompt is empty.")

    async with _REQUEST_LOCK:
        connection_id, entry = _interactive_workspace(workspace_connection_id)
        queue = _subscribe(connection_id)
        try:
            yield {
                "type": "bound",
                "requestId": str(request_id or ""),
                "workspace": workspace_snapshot(connection_id),
            }
            await _send_text_turn(entry, text, request_id)

            while True:
                try:
                    event = await asyncio.wait_for(queue.get(), timeout=float(timeout_seconds))
                except asyncio.TimeoutError as error:
                    raise RuntimeError("Gemini Link workspace timed out before completing the turn.") from error
                yield event
                if event.get("type") in ("turn_complete", "interrupted"):
                    return
        finally:
            _unsubscribe(connection_id, queue)