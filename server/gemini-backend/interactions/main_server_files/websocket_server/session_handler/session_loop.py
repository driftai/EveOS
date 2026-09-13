import asyncio
import json
import datetime
from ...api_configuration.gemini_config import MAIN_MODEL, create_gemini_config
from ...api_configuration.live_tools import build_live_tools
from ...api_configuration.model_registry import model_capabilities, resolve_live_model
from ...session_management.session_manager import active_sessions
from ...session_management.keep_alive_manager import KeepAliveManager
from ..message_processor import send_to_gemini
from ...response_processing.stream_handling.stream_controller import receive_from_gemini

async def execute_session_loop(websocket, client, connection_monitor, audio_processor, error_handler, connection_id, voice_name, config_data, monitor_task):
    """Executes the main Gemini session loop."""
    session_role = str(config_data.get("sessionRole") or "interactive").strip().lower()
    is_narration = session_role == "world_book_narration"
    requested_model = str(config_data.get("model") or MAIN_MODEL).strip()
    model_name = resolve_live_model(requested_model)
    capabilities = model_capabilities("live", model_name)
    setattr(connection_monitor, "model_name", model_name)
    resume_handle = str(config_data.get("sessionResumptionHandle") or "").strip()[:16384]
    setattr(connection_monitor, "session_resumption_handle", resume_handle)
    setattr(connection_monitor, "planned_session_rotation", False)
    # Tool correlation belongs to one provider session. Clear it before every new Live connect so
    # a late browser result from an old/rotated session is rejected instead of crossing sessions.
    setattr(connection_monitor, "pending_gemini_tool_calls", {})
    setattr(connection_monitor, "completed_gemini_tool_calls", {})

    setup_data = config_data.get("setup", {})
    generation_config = setup_data.get("generationConfig")
    safety_settings = setup_data.get("safetySettings")
    system_instruction_data = setup_data.get("systemInstruction")
    system_instruction = None
    if isinstance(system_instruction_data, dict) and "parts" in system_instruction_data:
        parts = system_instruction_data.get("parts", [])
        if parts and isinstance(parts, list):
            texts = [p.get("text", "") for p in parts if isinstance(p, dict) and "text" in p]
            system_instruction = "\n".join(texts)
    elif isinstance(system_instruction_data, str):
        system_instruction = system_instruction_data

    speech_config = setup_data.get("speechConfig", {})
    voice_config = speech_config.get("voiceConfig", {}).get("prebuiltVoiceConfig", {})
    speaking_rate = voice_config.get("speakingRate", 1.0)
    pitch = voice_config.get("pitch", 0.0)
    response_timeout = config_data.get("responseTimeout")

    output_transcription_enabled = bool(config_data.get("outputTranscriptionEnabled", True))
    native_output_transcription = bool(
        output_transcription_enabled and capabilities.get("output_audio_transcription")
    )
    inline_transcription_mode = is_narration or native_output_transcription

    print(
        f"Connection {connection_id}: native output transcription "
        f"{'enabled' if native_output_transcription else 'disabled'}; "
        f"local fallback {'disabled' if inline_transcription_mode else 'enabled'}"
    )

    config = create_gemini_config(
        voice_name=voice_name,
        generation_config=generation_config,
        safety_settings=safety_settings,
        context=system_instruction,
        speaking_rate=speaking_rate,
        pitch=pitch,
        model_name=model_name,
        enable_input_transcription=False,
        enable_output_transcription=native_output_transcription,
        session_resumption_handle=resume_handle or None,
    )
    # Search Monitor's interactive session gets the model-callable allowlist. Narration remains
    # a pure voice renderer and never receives agentic declarations.
    if session_role == "interactive":
        config["tools"] = build_live_tools()
    print(f"Created configuration with voice: {voice_name}")
    print(f"Selected model: {model_name}")

    if requested_model != model_name:
        await connection_monitor.safe_send(json.dumps({
            "type": "model_migrated",
            "kind": "live",
            "from": requested_model,
            "to": model_name,
            "text": f"Updated retired Live model {requested_model} to {model_name}.",
            "is_system_message": True,
        }))

    await connection_monitor.safe_send(json.dumps({
        "text": f"Connecting to Gemini API ({model_name})...",
        "is_system_message": True
    }))

    try:
        print(f"Connecting to Gemini API for connection: {connection_id}")
        async with client.aio.live.connect(model=model_name, config=config) as session:
            print(f"Connected to Gemini API with voice: {voice_name}, model: {model_name}")

            active_sessions.setdefault(connection_id, {}).update({
                "session": session,
                "voice_name": voice_name,
                "model": model_name,
                "generation_config": generation_config,
                "connected_at": datetime.datetime.now().isoformat(),
                "client": client,
                "session_role": session_role,
            })
            print(f"Active sessions: {len(active_sessions)}")

            await connection_monitor.safe_send(json.dumps({
                "type": "session_ready",
                "text": f"Connected to {model_name}",
                "is_system_message": True,
                "model": model_name,
                "sessionRole": session_role,
                "resumed": bool(resume_handle),
            }))

            audio_processor.is_sequential = config_data.get("sequentialAudioPlay", False)
            print(f"Sequential audio playback {'enabled' if audio_processor.is_sequential else 'disabled'} for connection {connection_id}")

            keep_alive_manager = KeepAliveManager(websocket, connection_id, connection_monitor)
            await keep_alive_manager.start_keep_alive()
            audio_queue_task = asyncio.create_task(audio_processor.process_audio_queue())
            send_task = asyncio.create_task(send_to_gemini(
                session, websocket, connection_monitor, connection_id, audio_processor, client
            ))
            receive_task = asyncio.create_task(receive_from_gemini(
                session=session,
                websocket=websocket,
                connection_monitor=connection_monitor,
                connection_id=connection_id,
                audio_processor=audio_processor,
                response_timeout=response_timeout,
                inline_transcription_mode=inline_transcription_mode,
                session_role=session_role
            ))

            try:
                done, pending = await asyncio.wait(
                    [send_task, receive_task, monitor_task],
                    return_when=asyncio.FIRST_COMPLETED
                )
                for task in done:
                    if task.cancelled():
                        continue
                    task_error = task.exception()
                    if task_error:
                        print(f"Task failed with exception for connection {connection_id}: {task_error}")
                        for pending_task in pending:
                            pending_task.cancel()
                        break
            except Exception as e:
                await error_handler.handle_session_tasks_error(e, [send_task, receive_task, monitor_task])
            finally:
                if 'keep_alive_manager' in locals():
                    await keep_alive_manager.stop()
                tasks_to_close = [audio_queue_task, send_task, receive_task, monitor_task]
                for task in tasks_to_close:
                    if task and not task.done():
                        task.cancel()
                await asyncio.gather(*tasks_to_close, return_exceptions=True)
                if not getattr(connection_monitor, "planned_session_rotation", False):
                    await error_handler.send_session_closed_message()

    except Exception as e:
        hard_failure_markers = (
            "api key", "ip address restriction", "unauthorized", "permission denied",
            "quota", "resource exhausted", "model not found",
            "not supported for bidigeneratecontent",
        )
        recoverable_resume_failure = resume_handle and not any(
            marker in str(e).lower() for marker in hard_failure_markers
        )
        if recoverable_resume_failure and connection_monitor.is_websocket_open():
            await connection_monitor.safe_send(json.dumps({
                "type": "session_resumption_rejected",
                "text": "The saved Gemini Live session could not be resumed; reconnecting cleanly.",
                "is_system_message": True,
            }))
            return
        await error_handler.handle_session_error(e, model_name)
        return
