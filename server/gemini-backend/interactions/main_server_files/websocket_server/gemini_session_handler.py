from .session_handler.connection_setup import setup_connection_resources, acquire_session_slot
from .session_handler.config_manager import handle_initial_config
from .session_handler.session_loop import execute_session_loop
from .session_handler.sonic_forge_session import (
    execute_sonic_forge_with_fallback,
)
from .session_handler.nexus_chat_session import execute_nexus_chat_session
import websockets
import asyncio
import json
from main_server_files.session_management.session_manager import (
    cleanup_resources,
    disconnect_other_sessions,
    set_session_role,
)
from main_server_files.api_configuration.api_client_manager import initialize_api_client
from main_server_files.api_configuration.api_key_manager import persist_api_key
from main_server_files.api_configuration.model_registry import music_api_versions

async def gemini_session_handler(websocket, client):
    """Handles the interaction with Gemini API within a websocket session.
    
    Args:
        websocket: The websocket connection
        client: The default Gemini API client instance
    """
    # Track active connections to help with cleanup
    connection_id = id(websocket)
    print(f"New connection established: {connection_id}")
    
    # 1. SETUP CONNECTION RESOURCES
    # Initially use the default client
    connection_monitor, audio_processor, error_handler = setup_connection_resources(websocket, client, connection_id)
    
    # Start the connection monitor task
    monitor_task = asyncio.create_task(connection_monitor.monitor_connection())
    
    try:
        # 2. INITIAL CONFIGURATION HANDSHAKE
        # Read the role before claiming a model slot so ownership can be scoped. Narration may
        # coexist with Search Monitor, while a newer client still replaces an older client that
        # owns the same role.
        voice_name, config_data = await handle_initial_config(websocket, connection_monitor, error_handler, connection_id)
        if not voice_name:
            # Error handled inside config manager
            return

        session_role = set_session_role(connection_id, config_data.get("sessionRole") or "interactive")
        setattr(connection_monitor, "session_role", session_role)
        setattr(audio_processor, "session_role", session_role)
        kicked = await disconnect_other_sessions(connection_id, session_role)
        if kicked:
            await asyncio.sleep(0.15)

        # 3. ACQUIRE SESSION SLOT
        # Nexus text chat uses the shared Gemini client without opening a Live session.
        if session_role != "nexus_chat":
            slot_acquired = await acquire_session_slot(connection_monitor, error_handler, connection_id)
            if not slot_acquired:
                return
            
        # 3.5 CHECK FOR PER-SESSION API KEY
        session_api_key = config_data.get("apiKey")
        if session_api_key:
            print(f"Connection {connection_id}: Using client-provided API key")
            session_client = initialize_api_client(session_api_key)
            if session_client:
                # Update client for this session
                client = session_client
                # Also update audio processor's client
                audio_processor.client = client
                persist_api_key(session_api_key)
                print(f"Connection {connection_id}: Successfully initialized session-specific client")
            else:
                print(f"Connection {connection_id}: Failed to initialize session-specific client")
                if connection_monitor.is_websocket_open():
                    await connection_monitor.safe_send(json.dumps({
                        "text": "Error: Provided API key is invalid or failed to initialize.",
                        "is_error": True,
                        "is_system_message": True
                    }))
                return
        else:
            # Credentials can be synchronized by EveOS after the backend starts.
            # Refresh from the local vault for every new session so an older
            # startup client cannot keep using a stale/restricted key.
            refreshed_client = initialize_api_client()
            if refreshed_client:
                client = refreshed_client
                audio_processor.client = client
                print(f"Connection {connection_id}: Loaded fresh API credentials from the local EveOS vault")
            elif not client:
                print(f"Connection {connection_id}: No API key available (none on server, none provided by client)")
        if not client:
            if connection_monitor.is_websocket_open():
                await connection_monitor.safe_send(json.dumps({
                    "text": "Error: No API key configured. Please provide one in Session Controls settings.",
                    "is_error": True,
                    "is_system_message": True
                }))
            return

        if session_role == "nexus_chat":
            await execute_nexus_chat_session(
                websocket,
                client,
                connection_monitor,
                audio_processor,
                connection_id,
            )
            return

        # 4. EXECUTE THE ROLE-SPECIFIC SESSION LOOP
        if session_role == "sonic_forge":
            versions = music_api_versions()
            await execute_sonic_forge_with_fallback(
                websocket,
                connection_monitor,
                config_data.get("model"),
                versions,
                lambda api_version: initialize_api_client(
                    session_api_key,
                    api_version=api_version,
                ),
            )
            return

        await execute_session_loop(
            websocket, 
            client, 
            connection_monitor, 
            audio_processor, 
            error_handler, 
            connection_id,
            voice_name,
            config_data,
            monitor_task
        )

    except asyncio.TimeoutError:
        await error_handler.handle_timeout_error()
    except websockets.exceptions.ConnectionClosed as e:
        await error_handler.handle_connection_closed(e)
    except Exception as e:
        await error_handler.handle_session_error(e)
    finally:
        # Always clean up resources
        if not monitor_task.done():
            monitor_task.cancel()
        await cleanup_resources(connection_id)
        print(f"Connection {connection_id} handler completed")
