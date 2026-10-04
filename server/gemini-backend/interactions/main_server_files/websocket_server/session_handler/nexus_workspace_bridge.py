"""Sidecar bridge from Nexus into the active EveOS Gemini Link workspace.

Nexus is a projection of the already-running interactive Gemini Live session. It must
never create a second Gemini personality, replace the owner session, or route user chat
through Text Brain / Mode 2 as an independent conversational model.
"""

import asyncio

from main_server_files.session_management.session_manager import active_sessions

_REQUEST_LOCK = asyncio.Lock()
_SUBSCRIBERS = {}


def _interactive_workspace():
    candidates = []
    for connection_id, entry in list(active_sessions.items()):
        if not isinstance(entry, dict):
            continue
        if str(entry.get("session_role") or "interactive").strip().lower() != "interactive":
            continue
        session = entry.get("session")
        if session is None:
            continue
        candidates.append((str(entry.get("connected_at") or ""), connection_id, entry))
    if not candidates:
        return None
    candidates.sort(key=lambda item: item[0])
    _, connection_id, entry = candidates[-1]
    return connection_id, entry


def workspace_snapshot():
    selected = _interactive_workspace()
    if not selected:
        return {
            "bound": False,
            "state": "unavailable",
            "message": "Gemini Link has no active interactive Live workspace to bind.",
        }
    connection_id, entry = selected
    return {
        "bound": True,
        "state": "ready",
        "connectionId": str(connection_id),
        "model": str(entry.get("model") or ""),
        "voiceName": str(entry.get("voice_name") or ""),
        "connectedAt": str(entry.get("connected_at") or ""),
        "sessionRole": "interactive",
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


async def _send_text_turn(session, prompt):
    """Send one typed user turn into the existing Live session without recreating it."""
    send_client_content = getattr(session, "send_client_content", None)
    if callable(send_client_content):
        await send_client_content(
            turns={"role": "user", "parts": [{"text": prompt}]},
            turn_complete=True,
        )
        return
    # Compatibility with older google-genai versions still used by some EveOS installs.
    send = getattr(session, "send", None)
    if not callable(send):
        raise RuntimeError("The active Gemini Live session cannot accept typed client content.")
    await send(input=prompt, end_of_turn=True)


async def stream_workspace_turn(prompt, request_id, timeout_seconds=180):
    """Yield the active workspace's real next turn, including PCM audio, to Nexus."""
    text = str(prompt or "").strip()
    if not text:
        raise ValueError("Gemini Link prompt is empty.")

    async with _REQUEST_LOCK:
        selected = _interactive_workspace()
        if not selected:
            raise RuntimeError(
                "Gemini Link is not connected to an active interactive Live workspace. "
                "Open/connect Gemini Link in EveOS first."
            )
        connection_id, entry = selected
        session = entry.get("session")
        queue = _subscribe(connection_id)
        try:
            yield {
                "type": "bound",
                "requestId": str(request_id or ""),
                "workspace": workspace_snapshot(),
            }
            await _send_text_turn(session, text)

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
