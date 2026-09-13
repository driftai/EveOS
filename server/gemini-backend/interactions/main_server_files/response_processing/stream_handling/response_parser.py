import logging
import asyncio
import websockets
import json
import time
from ...api_configuration.gemini_config import usage_monitor
from ...api_configuration.live_tools import forward_provider_tool_messages
from ...status_monitoring.api_usage_monitor import api_usage_tracker

# Configure logging for raw response data
response_logger = logging.getLogger('gemini_responses')


def _usage_value(metadata, *names):
    for name in names:
        value = getattr(metadata, name, None)
        if value is not None:
            return int(value or 0)
    return 0


def _usage_payload(metadata):
    prompt = _usage_value(metadata, "prompt_token_count")
    cached = _usage_value(metadata, "cached_content_token_count")
    output = _usage_value(metadata, "response_token_count", "candidates_token_count")
    tool = _usage_value(metadata, "tool_use_prompt_token_count")
    thoughts = _usage_value(metadata, "thoughts_token_count")
    total = _usage_value(metadata, "total_token_count") or (prompt + output + tool + thoughts)
    return {
        "prompt": prompt,
        "cached": cached,
        "output": output,
        "tool": tool,
        "thoughts": thoughts,
        "total": total,
    }


def _merge_transcript(current, incoming):
    chunk = str(incoming or "").strip()
    if not chunk:
        return current
    if not current or chunk.startswith(current):
        return chunk
    if current.endswith(chunk):
        return current
    return f"{current} {chunk}".strip()

async def _receive_responses(session, response_handler, connection_monitor, connection_id):
    """Handle Gemini responses with Live tool, interruption, and session metadata support."""
    turn_id = f"{connection_id}:{time.time_ns()}"
    output_transcription = ""

    async def finish_turn():
        if output_transcription:
            await response_handler.process_transcription_response(output_transcription)
        await response_handler.handle_turn_complete()

    try:
        async for response in session.receive():
            if not connection_monitor.is_websocket_open():
                print(f"Connection {connection_id} closed during response processing")
                break

            resumption_update = getattr(response, "session_resumption_update", None)
            if resumption_update is not None:
                handle = str(getattr(resumption_update, "new_handle", "") or "")
                resumable = bool(getattr(resumption_update, "resumable", False))
                if resumable and handle:
                    setattr(connection_monitor, "session_resumption_handle", handle)
                elif not resumable:
                    setattr(connection_monitor, "session_resumption_handle", "")
                await connection_monitor.safe_send(json.dumps({
                    "type": "session_resumption_update",
                    "handle": handle,
                    "resumable": resumable,
                    "lastConsumedClientMessageIndex": getattr(
                        resumption_update, "last_consumed_client_message_index", None
                    ),
                }))

            go_away = getattr(response, "go_away", None)
            if go_away is not None:
                time_left = getattr(go_away, "time_left", None)
                seconds_left = time_left.total_seconds() if hasattr(time_left, "total_seconds") else None
                setattr(connection_monitor, "planned_session_rotation", True)
                await connection_monitor.safe_send(json.dumps({
                    "type": "session_go_away",
                    "timeLeftSeconds": seconds_left,
                    "resumeAvailable": bool(getattr(connection_monitor, "session_resumption_handle", "")),
                }))

            usage_metadata = getattr(response, "usage_metadata", None)
            if usage_metadata is not None:
                usage = _usage_payload(usage_metadata)
                await connection_monitor.safe_send(json.dumps({
                    "type": "live_usage",
                    "turnId": turn_id,
                    "model": getattr(connection_monitor, "model_name", ""),
                    "usage": usage,
                }))

            # Tool calls are metadata-level Live messages and can arrive with no server_content.
            # Forward them before the server_content guard or they silently disappear.
            await forward_provider_tool_messages(response, session, connection_monitor)

            try:
                response_logger.debug(f"Raw response structure for {connection_id}: {response}")
                if hasattr(response, 'server_content') and response.server_content:
                    response_logger.debug(f"Server content attributes: {dir(response.server_content)}")
            except Exception as e:
                response_logger.warning(f"Could not log raw response: {e}")

            try:
                server_content = getattr(response, 'server_content', None)
                if server_content is None:
                    response_logger.debug(f"Metadata-only response for connection {connection_id}")
                    continue

                # Gemini Live uses this flag for server-side VAD/barge-in. The provider has already
                # abandoned the old model turn, so clear server accumulation and tell every browser
                # playback path to discard queued old speech before accepting the new user turn.
                if bool(getattr(server_content, "interrupted", False)):
                    try:
                        response_handler.audio_processor.reset()
                    except Exception as reset_error:
                        response_logger.warning(f"Could not reset interrupted audio: {reset_error}")
                    response_handler.last_audio_time = None
                    output_transcription = ""
                    await connection_monitor.safe_send(json.dumps({
                        "type": "gemini_interrupted",
                        "reason": "provider_barge_in",
                        "turnId": turn_id,
                    }))
                    response_logger.info(f"Gemini turn interrupted for connection {connection_id}")
                    continue

                native_transcription = getattr(server_content, "output_transcription", None)
                if native_transcription is not None:
                    output_transcription = _merge_transcript(
                        output_transcription,
                        getattr(native_transcription, "text", ""),
                    )

                model_turn = getattr(server_content, 'model_turn', None)
                if model_turn is not None:
                    parts = getattr(model_turn, 'parts', None)
                    if parts:
                        for part in parts:
                            await response_handler.process_response_part(part)
                    else:
                        print(f"No parts found in model_turn for connection {connection_id}")

                turn_complete = getattr(server_content, 'turn_complete', None)
                if turn_complete is not None and turn_complete:
                    print(f"Turn complete (explicit turn_complete) for connection {connection_id}")
                    await finish_turn()
                    return "rotate" if getattr(connection_monitor, "planned_session_rotation", False) else None

                if model_turn is not None:
                    final_attr = getattr(model_turn, 'final', None)
                    if final_attr is not None and final_attr:
                        print(f"Turn complete (legacy final=True) for connection {connection_id}")
                        await finish_turn()
                        return "rotate" if getattr(connection_monitor, "planned_session_rotation", False) else None

                    is_finished = getattr(model_turn, 'finished', None)
                    is_complete = getattr(model_turn, 'complete', None)
                    if is_finished or is_complete:
                        print(f"Turn complete (finished={is_finished}, complete={is_complete}) for connection {connection_id}")
                        await finish_turn()
                        return "rotate" if getattr(connection_monitor, "planned_session_rotation", False) else None
                else:
                    print(f"Non-model_turn content received for connection {connection_id}")

                completed = await response_handler.check_audio_completion()
                if not completed:
                    response_logger.debug(f"No turn completion detected for connection {connection_id}")
                    try:
                        server_content_attrs = [attr for attr in dir(server_content) if not attr.startswith('_')]
                        response_logger.debug(f"Available server_content attributes: {server_content_attrs}")
                        if model_turn:
                            model_turn_attrs = [attr for attr in dir(model_turn) if not attr.startswith('_')]
                            response_logger.debug(f"Available model_turn attributes: {model_turn_attrs}")
                    except Exception as e:
                        response_logger.warning(f"Could not log response attributes: {e}")

            except AttributeError as e:
                print(f"AttributeError in response parsing for connection {connection_id}: {e}")
                response_logger.warning(f"Response structure error for {connection_id}: {e}")
                try:
                    await response_handler.check_audio_completion()
                except Exception as fallback_error:
                    print(f"Fallback audio completion failed: {fallback_error}")
            except Exception as e:
                print(f"Unexpected error in response parsing for connection {connection_id}: {e}")
                response_logger.error(f"Response parsing error for {connection_id}: {e}")
                try:
                    await response_handler.check_audio_completion()
                except Exception as fallback_error:
                    print(f"Fallback audio completion failed: {fallback_error}")

        if getattr(connection_monitor, "planned_session_rotation", False):
            return "rotate"
    except websockets.exceptions.ConnectionClosedOK:
        print(f"Connection {connection_id} closed normally during response receiving")
    except websockets.exceptions.ConnectionClosed as e:
        error_msg = str(e)
        print(f"Connection {connection_id} closed during response receiving: {e}")
        usage_monitor.increment_error()

        if "deadline expired before operation could complete" in error_msg.lower() or e.code == 1011:
            usage_monitor.increment_deadline_error()
            raise Exception(f"Deadline expired error: {error_msg}")
        else:
            raise
    except asyncio.CancelledError:
        print(f"Response receiving task cancelled for connection {connection_id}")
        raise
    except Exception as e:
        print(f"Error in _receive_responses for connection {connection_id}: {e}")
        usage_monitor.increment_error()

        if connection_monitor.is_websocket_open():
            await connection_monitor.safe_send(json.dumps({
                "text": f"Error receiving response: {str(e)}",
                "is_system_message": True,
                "is_error": True
            }))
        raise
