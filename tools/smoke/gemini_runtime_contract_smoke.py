"""Gemini model, Live-session, tool, interruption, transcript, and usage contract smoke."""

from __future__ import annotations

import asyncio
import importlib.metadata
import json
import sys
from pathlib import Path
from types import SimpleNamespace


ROOT = Path(__file__).resolve().parents[2]
INTERACTIONS = ROOT / "server" / "gemini-backend" / "interactions"
if str(INTERACTIONS) not in sys.path:
    sys.path.insert(0, str(INTERACTIONS))

from main_server_files.api_configuration.gemini_config import (  # noqa: E402
    TEXT_BRAIN_CONFIG,
    TRANSCRIPTION_CONFIG,
    TimeoutConfig,
    create_gemini_client,
    create_gemini_config,
)
from main_server_files.api_configuration.live_tools import (  # noqa: E402
    LIVE_TOOL_NAMES,
    build_live_tools,
    forward_provider_tool_messages,
    handle_browser_tool_response,
)
from main_server_files.api_configuration.model_registry import (  # noqa: E402
    LIVE_DEFAULT_MODEL,
    MUSIC_DEFAULT_MODEL,
    MUSIC_API_VERSION,
    MUSIC_API_FALLBACK_VERSIONS,
    TEXT_BRAIN_DEFAULT_MODEL,
    TRANSCRIPTION_DEFAULT_MODEL,
    model_capabilities,
    model_options,
    music_api_versions,
    resolve_live_model,
    resolve_music_model,
    resolve_text_brain_model,
    resolve_transcription_model,
)
from main_server_files.response_processing.stream_handling.response_parser import (  # noqa: E402
    _receive_responses,
)


def assert_model_contract() -> None:
    assert LIVE_DEFAULT_MODEL == "gemini-3.1-flash-live-preview"
    assert TEXT_BRAIN_DEFAULT_MODEL == "gemini-3.5-flash-lite"
    assert TRANSCRIPTION_DEFAULT_MODEL == "gemini-3.6-flash"
    assert MUSIC_DEFAULT_MODEL == "models/lyria-realtime-exp"
    assert MUSIC_API_VERSION == "v1beta"
    assert MUSIC_API_FALLBACK_VERSIONS == ("v1alpha",)
    assert music_api_versions() == ("v1beta", "v1alpha")
    assert resolve_live_model("gemini-2.5-flash-native-audio-latest") == LIVE_DEFAULT_MODEL
    assert resolve_text_brain_model("gemini-2.5-pro") == "gemini-3.6-flash"
    assert resolve_transcription_model("gemini-2.0-flash") == TRANSCRIPTION_DEFAULT_MODEL
    assert resolve_live_model("unknown") == LIVE_DEFAULT_MODEL
    assert resolve_music_model("unknown") == MUSIC_DEFAULT_MODEL
    assert len(model_options("live")) == 2
    assert model_capabilities("live", LIVE_DEFAULT_MODEL)["output_audio_transcription"] is True
    assert model_capabilities("music", MUSIC_DEFAULT_MODEL)["live_steering"] is True

    forbidden_sampling = {"temperature", "top_k", "top_p"}
    assert not forbidden_sampling.intersection(TEXT_BRAIN_CONFIG)
    assert not forbidden_sampling.intersection(TRANSCRIPTION_CONFIG)
    assert TimeoutConfig.CLIENT_TIMEOUT_SECONDS == 300
    assert TimeoutConfig.CLIENT_TIMEOUT_MS == 300_000

    live_config = create_gemini_config(
        model_name="gemini-2.5-flash-native-audio-latest",
        enable_input_transcription=False,
        enable_output_transcription=True,
        session_resumption_handle="smoke-resume-handle",
    )
    assert "output_audio_transcription" in live_config
    assert "input_audio_transcription" not in live_config
    assert live_config["response_modalities"] == ["AUDIO"]
    assert live_config["session_resumption"].handle == "smoke-resume-handle"

    music_client = create_gemini_client("test-key", api_version=MUSIC_API_VERSION)
    try:
        options = music_client._api_client._http_options
        assert options.api_version == MUSIC_API_VERSION
        assert options.timeout == TimeoutConfig.CLIENT_TIMEOUT_MS
        assert type(music_client.aio.live.music).__name__ == "AsyncLiveMusic"
    finally:
        music_client.close()


def assert_source_contract() -> None:
    requirements = (ROOT / "requirements.txt").read_text(encoding="utf-8")
    assert "google-genai==2.17.0" in requirements
    assert "google-generativeai" not in requirements
    assert importlib.metadata.version("google-genai") == "2.17.0"

    session_loop = (
        INTERACTIONS
        / "main_server_files/websocket_server/session_handler/session_loop.py"
    ).read_text(encoding="utf-8")
    assert session_loop.count("async with client.aio.live.connect") == 1
    assert "await client.aio.live.connect" not in session_loop
    assert "outputTranscriptionEnabled" in session_loop
    assert "enable_input_transcription=False" in session_loop
    assert "sessionResumptionHandle" in session_loop
    assert '"type": "session_resumption_rejected"' in session_loop
    assert 'config["tools"] = build_live_tools()' in session_loop

    handler = (
        INTERACTIONS / "main_server_files/websocket_server/gemini_session_handler.py"
    ).read_text(encoding="utf-8")
    assert 'session_role == "sonic_forge"' in handler
    assert "music_api_versions()" in handler
    assert "execute_sonic_forge_with_fallback" in handler

    gemini_config = (
        INTERACTIONS / "main_server_files/api_configuration/gemini_config.py"
    ).read_text(encoding="utf-8")
    assert "import google.genai.live_music as live_music_module" in gemini_config
    assert "live_music_module.connect = eveos_ipv4_music_connect" in gemini_config
    assert 'base_config["session_resumption"]' in gemini_config

    parser = (
        INTERACTIONS
        / "main_server_files/response_processing/stream_handling/response_parser.py"
    ).read_text(encoding="utf-8")
    assert "forward_provider_tool_messages" in parser
    assert '"type": "gemini_interrupted"' in parser

    lifecycle = (
        INTERACTIONS
        / "main_server_files/response_processing/stream_handling/core/stream_lifecycle.py"
    ).read_text(encoding="utf-8")
    assert '"type": "session_go_away"' in lifecycle
    assert "blocked_markers" in lifecycle

    retired = [
        "main_server_files/server_initialization/reconnection_handler.py",
        "main_server_files/session_management/core/session_factory.py",
        "main_server_files/session_management/gemini_session_initializer.py",
        "main_server_files/websocket_server/message_processing/session_reinitializer.py",
    ]
    assert all(not (INTERACTIONS / relative).exists() for relative in retired)


class FakeConnectionMonitor:
    model_name = LIVE_DEFAULT_MODEL

    def __init__(self) -> None:
        self.messages: list[dict] = []

    def is_websocket_open(self) -> bool:
        return True

    async def safe_send(self, raw: str) -> None:
        self.messages.append(json.loads(raw))


class FakeAudioProcessor:
    def __init__(self) -> None:
        self.reset_count = 0

    def reset(self) -> None:
        self.reset_count += 1


class FakeResponseHandler:
    def __init__(self) -> None:
        self.parts: list[object] = []
        self.transcripts: list[str] = []
        self.completed = 0
        self.audio_processor = FakeAudioProcessor()
        self.last_audio_time = 123.0

    async def process_response_part(self, part: object) -> None:
        self.parts.append(part)

    async def process_transcription_response(self, text: str) -> None:
        self.transcripts.append(text)

    async def handle_turn_complete(self) -> None:
        self.completed += 1

    async def check_audio_completion(self) -> bool:
        return False


class FakeSession:
    def __init__(self, responses: list[object] | None = None) -> None:
        self.responses = responses or []
        self.function_responses: list[object] = []

    async def receive(self):
        for response in self.responses:
            yield response

    async def send_tool_response(self, *, function_responses) -> None:
        self.function_responses.extend(function_responses)


async def assert_live_tool_contract() -> None:
    expected_names = {
        "eve_get_client_time",
        "eve_get_context_memory_state",
        "eve_set_context_memory_state",
        "eve_get_screen_share_state",
        "eve_get_audio_playback_diagnostics",
        "eve_get_session_state",
    }
    assert LIVE_TOOL_NAMES == expected_names
    tools = build_live_tools()
    assert len(tools) == 1
    declarations = tools[0].function_declarations
    assert {declaration.name for declaration in declarations} == expected_names

    monitor = FakeConnectionMonitor()
    session = FakeSession()
    provider_response = SimpleNamespace(
        tool_call=SimpleNamespace(function_calls=[SimpleNamespace(
            id="call-1", name="eve_get_client_time", args={}
        )]),
        tool_call_cancellation=None,
    )
    forwarded = await forward_provider_tool_messages(provider_response, session, monitor)
    assert forwarded == 1
    call_message = monitor.messages[-1]
    assert call_message["type"] == "gemini_tool_call"
    assert call_message["call"]["requestId"] == "call-1"
    assert call_message["call"]["name"] == "eve_get_client_time"

    accepted = await handle_browser_tool_response({
        "requestId": "call-1",
        "name": "eve_get_client_time",
        "response": {"ok": True, "local": "fixture-time"},
    }, session, monitor)
    assert accepted is True
    assert len(session.function_responses) == 1
    result = session.function_responses[0]
    assert result.id == "call-1"
    assert result.name == "eve_get_client_time"
    assert result.response["ok"] is True

    duplicate = await handle_browser_tool_response({
        "requestId": "call-1",
        "name": "eve_get_client_time",
        "response": {"ok": True},
    }, session, monitor)
    assert duplicate is False
    assert monitor.messages[-1]["type"] == "gemini_tool_response_rejected"

    unknown = SimpleNamespace(
        tool_call=SimpleNamespace(function_calls=[SimpleNamespace(
            id="call-x", name="not_allowed", args={}
        )]),
        tool_call_cancellation=None,
    )
    forwarded = await forward_provider_tool_messages(unknown, session, monitor)
    assert forwarded == 0
    assert len(session.function_responses) == 2
    assert session.function_responses[-1].response["ok"] is False


async def assert_parser_contract() -> None:
    usage_one = SimpleNamespace(
        prompt_token_count=10,
        response_token_count=4,
        cached_content_token_count=2,
        total_token_count=14,
    )
    usage_two = SimpleNamespace(
        prompt_token_count=10,
        response_token_count=7,
        cached_content_token_count=2,
        total_token_count=17,
    )
    responses = [
        SimpleNamespace(
            session_resumption_update=SimpleNamespace(
                new_handle="smoke-handle",
                resumable=True,
                last_consumed_client_message_index=3,
            ),
            server_content=None,
        ),
        SimpleNamespace(
            usage_metadata=usage_one,
            server_content=SimpleNamespace(
                output_transcription=SimpleNamespace(text="EveOS keeps"),
                model_turn=SimpleNamespace(parts=[SimpleNamespace(text="part-a"), SimpleNamespace(inline_data=b"a")]),
                turn_complete=False,
            ),
        ),
        SimpleNamespace(
            go_away=SimpleNamespace(time_left=None),
            usage_metadata=usage_two,
            server_content=SimpleNamespace(
                output_transcription=SimpleNamespace(text="EveOS keeps one transcript"),
                model_turn=SimpleNamespace(parts=[SimpleNamespace(inline_data=b"b")]),
                turn_complete=True,
            ),
        ),
    ]
    monitor = FakeConnectionMonitor()
    handler = FakeResponseHandler()
    result = await _receive_responses(FakeSession(responses), handler, monitor, "smoke")

    assert len(handler.parts) == 3
    assert handler.transcripts == ["EveOS keeps one transcript"]
    assert handler.completed == 1
    usage_messages = [message for message in monitor.messages if message.get("type") == "live_usage"]
    assert len(usage_messages) == 2
    assert len({message["turnId"] for message in usage_messages}) == 1
    assert usage_messages[-1]["usage"]["total"] == 17
    assert result == "rotate"
    assert monitor.session_resumption_handle == "smoke-handle"
    assert any(message.get("type") == "session_resumption_update" for message in monitor.messages)
    assert any(message.get("type") == "session_go_away" for message in monitor.messages)

    interrupted_monitor = FakeConnectionMonitor()
    interrupted_handler = FakeResponseHandler()
    interrupted_response = SimpleNamespace(
        server_content=SimpleNamespace(interrupted=True),
    )
    await _receive_responses(
        FakeSession([interrupted_response]),
        interrupted_handler,
        interrupted_monitor,
        "interrupt-smoke",
    )
    assert interrupted_handler.audio_processor.reset_count == 1
    assert interrupted_handler.last_audio_time is None
    assert any(message.get("type") == "gemini_interrupted" for message in interrupted_monitor.messages)


def main() -> None:
    assert_model_contract()
    assert_source_contract()
    asyncio.run(assert_live_tool_contract())
    asyncio.run(assert_parser_contract())
    print("GEMINI_RUNTIME_CONTRACT_SMOKE_OK")


if __name__ == "__main__":
    main()
