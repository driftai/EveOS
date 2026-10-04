"""Lightweight Gemini text-chat role used by the local Nexus provider workspace."""

import json

from ..message_processor import send_to_gemini


async def execute_nexus_chat_session(
    websocket,
    client,
    connection_monitor,
    audio_processor,
    connection_id,
):
    """Serve text-brain requests without opening or replacing a Gemini Live session."""
    await connection_monitor.safe_send(json.dumps({
        "type": "session_ready",
        "text": "Gemini Link text chat is ready",
        "is_system_message": True,
        "sessionRole": "nexus_chat",
    }))
    await send_to_gemini(
        None,
        websocket,
        connection_monitor,
        connection_id,
        audio_processor,
        client,
    )
