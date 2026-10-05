"""Nexus sidecar role bound to the active EveOS Gemini Link workspace."""

import base64
import json

import websockets

from .nexus_workspace_bridge import stream_workspace_turn, workspace_snapshot


def _normalize_correlation(message, request_id):
    value = message.get("correlation")
    if not isinstance(value, dict):
        value = {}
    return {
        "roomId": str(value.get("roomId") or value.get("room_id") or "").strip(),
        "turnId": str(value.get("turnId") or value.get("turn_id") or request_id or "").strip(),
        "requestId": str(value.get("requestId") or value.get("request_id") or request_id or "").strip(),
        "sourceMessageId": str(value.get("sourceMessageId") or value.get("source_message_id") or "").strip(),
    }


def _timeout_seconds(message):
    try:
        requested = float(message.get("timeoutMs") or 182500) / 1000.0
    except (TypeError, ValueError):
        requested = 182.5
    return max(1.0, min(requested, 190.0))


async def _send_event(connection_monitor, request_id, correlation, event):
    event_type = str(event.get("type") or "")
    common = {
        "requestId": request_id,
        "correlation": correlation,
    }
    if event_type == "bound":
        await connection_monitor.safe_send(json.dumps({
            "type": "nexus_workspace_bound",
            **common,
            "workspace": event.get("workspace") or {},
        }))
        return
    if event_type == "text":
        await connection_monitor.safe_send(json.dumps({
            "type": "nexus_workspace_text",
            **common,
            "text": str(event.get("text") or ""),
        }))
        return
    if event_type == "transcription":
        await connection_monitor.safe_send(json.dumps({
            "type": "nexus_workspace_transcription",
            **common,
            "text": str(event.get("text") or ""),
        }))
        return
    if event_type == "audio":
        audio_data = event.get("audio") or b""
        await connection_monitor.safe_send(json.dumps({
            "type": "nexus_workspace_audio",
            **common,
            "audio": base64.b64encode(audio_data).decode("ascii"),
            "encoding": event.get("encoding") or "pcm_s16le",
            "sampleRate": int(event.get("sampleRate") or 24000),
            "channels": int(event.get("channels") or 1),
            "audioOwner": "nexus-browser",
        }))
        return
    if event_type == "interrupted":
        await connection_monitor.safe_send(json.dumps({
            "type": "nexus_workspace_interrupted",
            **common,
            "reason": str(event.get("reason") or "provider_barge_in"),
        }))
        return
    if event_type == "turn_complete":
        await connection_monitor.safe_send(json.dumps({
            "type": "nexus_workspace_turn_complete",
            **common,
        }))


def _requested_workspace_connection_id(message):
    direct = str(message.get("workspaceConnectionId") or "").strip()
    if direct:
        return direct
    workspace = message.get("workspace")
    if isinstance(workspace, dict):
        nested = str(workspace.get("connectionId") or "").strip()
        if nested:
            return nested
    return None


async def execute_nexus_chat_session(
    websocket,
    client,
    connection_monitor,
    audio_processor,
    connection_id,
):
    """Port Nexus messages into the already-running interactive Gemini Link session.

    This role never opens a second model session and never calls Text Brain / Mode 2 as a
    conversational backend. The active EveOS Gemini workspace remains the source of truth.
    """
    del client, audio_processor, connection_id
    await connection_monitor.safe_send(json.dumps({
        "type": "session_ready",
        "text": "Gemini Link Nexus connector is ready",
        "is_system_message": True,
        "sessionRole": "nexus_chat",
        "workspace": workspace_snapshot(),
    }))

    try:
        async for raw in websocket:
            try:
                message = json.loads(raw)
            except json.JSONDecodeError:
                await connection_monitor.safe_send(json.dumps({
                    "type": "nexus_workspace_error",
                    "error": "Gemini Link connector received malformed JSON.",
                }))
                continue

            message_type = str(message.get("type") or "")
            if message_type in ("application_ping", "ping", "keepalive", "heartbeat"):
                await connection_monitor.safe_send(json.dumps({"type": "application_pong"}))
                continue
            if message_type != "nexus_workspace_request":
                await connection_monitor.safe_send(json.dumps({
                    "type": "nexus_workspace_error",
                    "requestId": str(message.get("requestId") or ""),
                    "error": "Gemini Link Nexus connector only accepts nexus_workspace_request messages.",
                }))
                continue

            request_id = str(message.get("requestId") or "").strip()
            text = str(message.get("text") or "").strip()
            correlation = _normalize_correlation(message, request_id)
            workspace_connection_id = _requested_workspace_connection_id(message)
            if not request_id or not text:
                await connection_monitor.safe_send(json.dumps({
                    "type": "nexus_workspace_error",
                    "requestId": request_id,
                    "correlation": correlation,
                    "error": "Gemini Link Nexus request requires requestId and text.",
                }))
                continue

            try:
                async for event in stream_workspace_turn(
                    text,
                    request_id,
                    timeout_seconds=_timeout_seconds(message),
                    workspace_connection_id=workspace_connection_id,
                ):
                    await _send_event(connection_monitor, request_id, correlation, event)
            except Exception as error:
                await connection_monitor.safe_send(json.dumps({
                    "type": "nexus_workspace_error",
                    "requestId": request_id,
                    "correlation": correlation,
                    "error": str(error),
                }))
    except websockets.exceptions.ConnectionClosed:
        return