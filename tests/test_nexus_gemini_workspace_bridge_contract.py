from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "server" / "gemini-backend" / "interactions" / "main_server_files"


def _read(relative_path):
    return (BACKEND / relative_path).read_text(encoding="utf-8")


def _read_root(relative_path):
    return (ROOT / relative_path).read_text(encoding="utf-8")


def test_nexus_reuses_normal_eveos_realtime_input_pipeline():
    bridge = _read("websocket_server/session_handler/nexus_workspace_bridge.py")
    assert "process_realtime_input" in bridge
    assert '"source": "nexus_workspace_request"' in bridge
    assert "send_client_content" not in bridge
    assert "await session.send(" not in bridge


def test_live_workspace_registers_dependencies_needed_by_sidecar():
    session_loop = _read("websocket_server/session_handler/session_loop.py")
    assert '"connection_monitor": connection_monitor' in session_loop
    assert '"audio_processor": audio_processor' in session_loop
    assert '"session_role": session_role' in session_loop
    assert '"provider": "gemini_link"' in session_loop


def test_nexus_sidecar_does_not_require_its_own_provider_credentials():
    handler = _read("websocket_server/gemini_session_handler.py")
    nexus_dispatch = handler.index('if session_role != "nexus_chat":')
    credential_refresh = handler.index('session_api_key = config_data.get("apiKey")')
    assert nexus_dispatch < credential_refresh
    assert "execute_nexus_chat_session" in handler[nexus_dispatch:credential_refresh]


def test_workspace_binding_is_fail_closed_and_can_be_exact():
    bridge = _read("websocket_server/session_handler/nexus_workspace_bridge.py")
    sidecar = _read("websocket_server/session_handler/nexus_chat_session.py")
    assert "More than one interactive Gemini Link workspace is registered" in bridge
    assert "required_connection_id" in bridge
    assert "workspaceConnectionId" in sidecar
    assert "workspace_connection_id=workspace_connection_id" in sidecar


def test_provider_interruption_reaches_nexus_turn_stream():
    parser = _read("response_processing/stream_handling/response_parser.py")
    assert "publish_nexus_interrupted" in parser
    assert 'await publish_nexus_interrupted(connection_id, "provider_barge_in")' in parser


def test_nexus_user_turn_is_echoed_to_existing_gemini_feed_without_second_provider_send():
    bridge = _read("websocket_server/session_handler/nexus_workspace_bridge.py")
    feed_ui = _read_root(
        "js/modules/gemini/client/connection_management/socket_core/nexusWorkspaceFeedUI.js"
    )
    manifest = _read_root("js/config/manifest/scripts.parts/13-gemini.js")

    assert '"type": "nexus_workspace_user_message"' in bridge
    assert "await _echo_nexus_user_message(entry, prompt, request_id)" in bridge
    assert "await process_realtime_input(" in bridge
    assert "send_client_content" not in bridge
    assert "await session.send(" not in bridge

    assert "nexus_workspace_user_message" in feed_ui
    assert "nexus-workspace-user-message" in feed_ui
    assert "previousHandleSocketMessage(event)" in feed_ui
    assert ".send(" not in feed_ui
    assert "sendTextMessage" not in feed_ui
    assert "nexusWorkspaceFeedUI.js" in manifest
    assert "geminiCredentialWorkflow.js" in manifest


def test_gemini_full_shutdown_and_global_stop_share_manual_disable_semantics():
    shutdown_ui = _read_root("js/modules/gemini/server_control/geminiShutdownUI.js")
    control_plane = _read_root("js/modules/gemini/server_control/eveosControlPlane.js")
    manifest = _read_root("js/config/manifest/scripts.parts/13-gemini.js")

    assert "gemini-server-shutdown-btn" in shutdown_ui
    assert "await control.toggleServer()" in shutdown_ui
    assert "eve:eveos-global-stop" in shutdown_ui
    assert "setClientLink?.(false)" in shutdown_ui
    assert "updateConnectionStatus('disconnected', message || 'Disabled')" in shutdown_ui
    assert "eve:eveos-global-stop" in control_plane
    assert "geminiShutdownUI.js" in manifest


def test_gemini_shutdown_ui_observer_cannot_feedback_on_its_own_render():
    shutdown_ui = _read_root("js/modules/gemini/server_control/geminiShutdownUI.js")
    manifest = _read_root("js/config/manifest/scripts.parts/13-gemini.js")

    assert "if (!document.getElementById(BUTTON_ID))" in shutdown_ui
    assert "if (icon && icon.textContent !== desiredIcon)" in shutdown_ui
    assert "geminiShutdownUI.js?v=20261005.1" in manifest


def test_gemini_credential_status_requests_are_cached_and_single_flight():
    credentials = _read_root("js/modules/gemini/server_control/geminiCredentialBridge.js")
    manifest = _read_root("js/config/manifest/scripts.parts/13-gemini.js")

    assert "const STATUS_CACHE_MS = 1500;" in credentials
    assert "if (!force && statusRequest?.baseUrl === baseUrl)" in credentials
    assert "return statusRequest.promise;" in credentials
    assert "return status || getStatus(baseUrl, { force });" in credentials
    assert "rememberStatus(baseUrl, payload);" in credentials
    assert "geminiCredentialBridge.js?v=20261005.4" in manifest


def test_search_monitor_local_moe_refresh_is_open_only_and_single_flight():
    ai_home = _read_root("js/modules/gemini/search_monitor/searchMonitorAiHome.js")
    manifest = _read_root("js/config/manifest/scripts.parts/13-gemini.js")

    assert "let localMoeRefreshPromise = null;" in ai_home
    assert "if (localMoeRefreshPromise) return localMoeRefreshPromise;" in ai_home
    assert "localMoeRefreshPromise = (async function ()" in ai_home
    assert "localMoeRefreshPromise = null;" in ai_home
    assert "if (localMoe?.open) refreshLocalMoe();" in ai_home
    assert "if (active && localMoe?.open) refreshLocalMoe();" in ai_home
    assert "if (active) refreshLocalMoe();" not in ai_home
    assert "searchMonitorAiHome.js?v=20261005.1" in manifest
