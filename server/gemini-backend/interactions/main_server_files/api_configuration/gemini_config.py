import inspect
import json
import os
import socket
import httpx
from google import genai
from google.genai import types

from .model_registry import (
    LIVE_DEFAULT_MODEL,
    TEXT_BRAIN_DEFAULT_MODEL,
    TRANSCRIPTION_DEFAULT_MODEL,
    model_capabilities,
    model_options,
    resolve_live_model,
    resolve_text_brain_model,
)

# Configurable timeout settings for addressing deadline errors
class TimeoutConfig:
    """Centralized timeout configuration for addressing deadline exceeded errors"""
    # API client timeouts
    CLIENT_TIMEOUT_SECONDS = 300  # 5 minutes
    # google-genai HttpOptions.timeout is explicitly measured in milliseconds.
    CLIENT_TIMEOUT_MS = CLIENT_TIMEOUT_SECONDS * 1000
    
    # Response receiving timeouts (addressing the main deadline issue)
    RESPONSE_TIMEOUT = 75  # Increased from 45s to 75s for backend delays
    RESPONSE_TIMEOUT_EXTENDED = 90  # For retry attempts
    
    # WebSocket timeouts
    WEBSOCKET_PING_TIMEOUT = 120  # Increased from 90s
    WEBSOCKET_CLOSE_TIMEOUT = 60   # Increased from 45s
    WEBSOCKET_OPEN_TIMEOUT = 60    # Increased from 45s
    
    # Circuit breaker and retry settings
    MAX_CONSECUTIVE_DEADLINE_ERRORS = 3  # Reduced for faster circuit breaker activation
    DEADLINE_RETRY_BASE_DELAY = 5  # Base delay for deadline retries (seconds)
    CIRCUIT_BREAKER_COOLDOWN = 180  # Reduced from 300s to 3 minutes
    
    @classmethod
    def get_response_timeout(cls, retry_attempt: int = 0) -> int:
        """Get response timeout based on retry attempt"""
        if retry_attempt == 0:
            return cls.RESPONSE_TIMEOUT
        else:
            # Gradually increase timeout for retries
            return min(cls.RESPONSE_TIMEOUT_EXTENDED, cls.RESPONSE_TIMEOUT + (retry_attempt * 15))

# API usage monitoring
class APIUsageMonitor:
    """Monitor API usage to help identify quota and rate limit issues"""
    def __init__(self):
        self.request_count = 0
        self.error_count = 0
        self.deadline_error_count = 0
        self.last_reset = None
        
    def increment_request(self):
        self.request_count += 1
        
    def increment_error(self):
        self.error_count += 1
        
    def increment_deadline_error(self):
        self.deadline_error_count += 1
        
    def get_stats(self):
        return {
            "requests": self.request_count,
            "errors": self.error_count,
            "deadline_errors": self.deadline_error_count,
            "error_rate": self.error_count / max(self.request_count, 1),
            "deadline_error_rate": self.deadline_error_count / max(self.request_count, 1)
        }

# Global usage monitor instance
usage_monitor = APIUsageMonitor()

_LIVE_IPV4_PATCHED = False

def _env_enabled(name, default=True):
    raw = os.environ.get(name)
    if raw is None:
        return default
    return str(raw).strip().lower() not in {"0", "false", "off", "no"}


def _gemini_http_options(api_version):
    """Build deterministic google-genai HTTP options.

    API-key IP restrictions apply to GenerateContent as well as Live. Binding
    HTTPX transports to the IPv4 wildcard keeps Text Brain, transcription, and
    other HTTP model calls on IPv4 without changing the API key allowlist.
    The SDK enables ``trust_env`` by default, which can silently route only the
    HTTP calls through an inherited/system proxy. Direct egress keeps every
    Gemini HTTP call on the same public route as the Live WebSocket.
    """
    options = {
        "api_version": api_version,
        "timeout": TimeoutConfig.CLIENT_TIMEOUT_MS,
    }
    sync_args = {}
    async_args = {}
    if _env_enabled("EVEOS_GEMINI_FORCE_IPV4", True):
        sync_args["transport"] = httpx.HTTPTransport(local_address="0.0.0.0")
        async_args["transport"] = httpx.AsyncHTTPTransport(local_address="0.0.0.0")
    if _env_enabled("EVEOS_GEMINI_DIRECT_EGRESS", True):
        sync_args["trust_env"] = False
        async_args["trust_env"] = False
    if sync_args:
        options["client_args"] = sync_args
    if async_args:
        options["async_client_args"] = async_args
    return options


def _disable_automatic_websocket_proxy(connector, kwargs):
    """Disable system proxy discovery when the installed connector supports it.

    websockets 14.2 (the pinned EveOS version) connects directly and has no
    ``proxy`` argument. Newer releases discover OS proxies automatically, so
    detect that capability instead of passing an unsupported keyword today.
    """
    if not _env_enabled("EVEOS_GEMINI_DIRECT_EGRESS", True):
        return
    try:
        if "proxy" in inspect.signature(connector).parameters:
            kwargs.setdefault("proxy", None)
    except (TypeError, ValueError):
        pass


def install_live_websocket_ipv4_patch():
    """Force Gemini Live and Live Music WebSockets through IPv4 when enabled.

    Google can reject IP-restricted API keys when the Live WebSocket exits over
    an IPv6 address that is not on the key allowlist. The google-genai client
    currently drops low-level WebSocket kwargs passed through HttpOptions, so we
    patch only the module-level connectors used by this backend.
    """
    global _LIVE_IPV4_PATCHED
    if _LIVE_IPV4_PATCHED or not _env_enabled("EVEOS_GEMINI_FORCE_IPV4", True):
        return _LIVE_IPV4_PATCHED

    try:
        import google.genai.live as live_module
        import google.genai.live_music as live_music_module

        if not getattr(live_module, "_eveos_ipv4_ws_connect", False):
            original_connect = live_module.ws_connect

            def eveos_ipv4_ws_connect(*args, **kwargs):
                kwargs.setdefault("family", socket.AF_INET)
                _disable_automatic_websocket_proxy(original_connect, kwargs)
                return original_connect(*args, **kwargs)

            eveos_ipv4_ws_connect.__name__ = "eveos_ipv4_ws_connect"
            live_module.ws_connect = eveos_ipv4_ws_connect
            live_module._eveos_ipv4_ws_connect = True

        if not getattr(live_music_module, "_eveos_ipv4_ws_connect", False):
            original_music_connect = live_music_module.connect

            def eveos_ipv4_music_connect(*args, **kwargs):
                kwargs.setdefault("family", socket.AF_INET)
                _disable_automatic_websocket_proxy(original_music_connect, kwargs)
                return original_music_connect(*args, **kwargs)

            eveos_ipv4_music_connect.__name__ = "eveos_ipv4_music_connect"
            live_music_module.connect = eveos_ipv4_music_connect
            live_music_module._eveos_ipv4_ws_connect = True
        _LIVE_IPV4_PATCHED = True
        print("[OK] Gemini Live and Live Music WebSocket IPv4 routing enabled")
        return True
    except Exception as exc:
        print(f"[WARN] Gemini Live IPv4 routing patch unavailable: {exc}")
        return False

def configure_gemini_api(api_key):
    """Validate configuration before creating the google-genai client.

    The legacy SDK used a process-global configure() call. google-genai keeps
    credentials on each Client, which prevents one session from mutating another.
    """
    if not str(api_key or "").strip():
        raise ValueError("A Gemini API key is required")
    print("\n[OK] Gemini credentials accepted for client initialization")

def create_gemini_client(api_key, api_version="v1beta"):
    """Create a Gemini client for one explicit API contract."""
    try:
        print("\nConfiguring Gemini client with enhanced timeout settings...")
        install_live_websocket_ipv4_patch()
        force_ipv4 = _env_enabled("EVEOS_GEMINI_FORCE_IPV4", True)
        client = genai.Client(
            api_key=api_key,
            http_options=_gemini_http_options(api_version),
        )
        print(f"[OK] Client configured successfully with {TimeoutConfig.CLIENT_TIMEOUT_SECONDS}s timeout")
        if force_ipv4:
            print("[OK] Gemini HTTP IPv4 routing enabled")
        if _env_enabled("EVEOS_GEMINI_DIRECT_EGRESS", True):
            print("[OK] Gemini direct egress enabled (environment proxies ignored)")
        print(f"[OK] Response timeout set to {TimeoutConfig.RESPONSE_TIMEOUT}s (extended to {TimeoutConfig.RESPONSE_TIMEOUT_EXTENDED}s for retries)")
        return client
    except Exception as e:
        print(f"\n====== ERROR: FAILED TO INITIALIZE GEMINI CLIENT ======")
        print(f"Error details: {str(e)}")
        print("\nPossible causes:")
        print("1. Invalid API key or unauthorized access")
        print("2. No internet connection")
        print("3. Requested model not available")
        print("4. Gemini API service is down or overloaded")
        raise RuntimeError("Gemini client initialization failed") from e

def create_gemini_config(
    voice_name="Aoede",
    context=None,
    generation_config=None,
    safety_settings=None,
    speaking_rate=1.0,
    pitch=0.0,
    model_name=None,
    enable_input_transcription=False,
    enable_output_transcription=True,
    session_resumption_handle=None,
):
    """Create configuration for Gemini session with optional context and overrides."""
    
    resolved_model = resolve_live_model(model_name)
    capabilities = model_capabilities("live", resolved_model)
    
    # LiveConnectConfig exposes these controls at the top level. Keeping them
    # out of a nested GenerationConfig avoids invalid-argument failures as
    # preview model contracts evolve.
    gen_config = {
        "temperature": 0.9,
        "top_k": 1,
        "top_p": 1,
        "max_output_tokens": 2048,
    }
    
    # Apply overrides if provided
    if generation_config:
        # Mapping from client-side keys (often camelCase) to server-side keys
        if "temperature" in generation_config: gen_config["temperature"] = generation_config["temperature"]
        if "topK" in generation_config: gen_config["top_k"] = generation_config["topK"]
        if "topP" in generation_config: gen_config["top_p"] = generation_config["topP"]
        if "maxOutputTokens" in generation_config: gen_config["max_output_tokens"] = generation_config["maxOutputTokens"]
        
        # Also check for snake_case keys just in case
        if "top_k" in generation_config: gen_config["top_k"] = generation_config["top_k"]
        if "top_p" in generation_config: gen_config["top_p"] = generation_config["top_p"]
        if "max_output_tokens" in generation_config: gen_config["max_output_tokens"] = generation_config["max_output_tokens"]
    base_config = {
        **gen_config,
        "response_modalities": ["AUDIO"],
        "speech_config": {
            "voice_config": {
                "prebuilt_voice_config": {
                    "voice_name": voice_name
                    # "speaking_rate": speaking_rate, 
                    # "pitch": pitch 
                }
            }
        }
    }
    
    # if safety_settings:
    #     base_config["safety_settings"] = safety_settings
    
    if context:
         full_context = context
         base_config["system_instruction"] = types.Content(parts=[types.Part(text=full_context)])

    if enable_input_transcription and capabilities.get("input_audio_transcription"):
        base_config["input_audio_transcription"] = types.AudioTranscriptionConfig()
    if enable_output_transcription and capabilities.get("output_audio_transcription"):
        base_config["output_audio_transcription"] = types.AudioTranscriptionConfig()

    # The Live session has a bounded context window that fills with conversation,
    # streamed audio, and EveOS context snapshots.
    # Without compression the API terminates the session when the window fills; sliding-window
    # compression evicts the oldest turns instead, so long sessions and large context relays
    # survive. Guarded for older google-genai builds that predate the config type.
    try:
        base_config["context_window_compression"] = types.ContextWindowCompressionConfig(
            sliding_window=types.SlidingWindow()
        )
    except Exception as compression_error:  # pragma: no cover - depends on installed SDK
        print(f"[GeminiConfig] Context window compression unavailable: {compression_error}", flush=True)

    base_config["session_resumption"] = types.SessionResumptionConfig(
        handle=session_resumption_handle or None
    )

    return base_config

# Public aliases retained for modules that import the historical config surface.
MAIN_MODEL = LIVE_DEFAULT_MODEL
TRANSCRIPTION_MODEL = TRANSCRIPTION_DEFAULT_MODEL

# Current Gemini 3.x GenerateContent models reject the legacy sampling fields
# (temperature, top_k, and top_p). Keep the bounded response size only.
TRANSCRIPTION_CONFIG = {
    "max_output_tokens": 1024,
}

# Alias MODEL to MAIN_MODEL for backward compatibility
MODEL = MAIN_MODEL

# ---------------------------------------------------------------------------
# Mode 2 (Text Brain -> Live Voice) configuration
# ---------------------------------------------------------------------------
# The "text brain" is a large-context text model that holds the grand EveOS
# conversation history/context and produces the line the live voice model speaks.
# The text brain holds the larger EveOS context while the Live model handles the
# spoken interaction. Model policy and migration live in model_registry.py.
TEXT_BRAIN_MODEL = TEXT_BRAIN_DEFAULT_MODEL

# Text-capable models the Mode 2 text brain may be switched to from Session Controls. This is the
# server-side allowlist: the client can only select a KNOWN text-generation model, so a stale or
# tampered value can never send an invalid/unsupported model id to the API. Ordered by how well
# each suits the extraction role on a free key (fast + large window + generous quota first).
TEXT_BRAIN_MODEL_OPTIONS = model_options("text_brain")


TEXT_BRAIN_CONFIG = {"max_output_tokens": 2048}

# System instruction for the text brain. It reasons over the full history/context
# and returns ONLY the spoken reply (the live model will voice it verbatim).
TEXT_BRAIN_SYSTEM_PREFIX = (
    "You are an information extraction assistant for a live voice model inside EveOS. "
    "Your job is to analyze the user's message, the conversation history, and the EveOS context, "
    "and extract the relevant details, data, facts, and updates needed to answer the user's query. "
    "Provide this extracted information clearly and concisely as context, under 150 words. "
    "Do not write a conversational response to the user. "
    "Never quote, summarize, or repeat prior background-context injections, system messages, or "
    "your own previous extractions that appear in the history - extract only from the EveOS "
    "context and genuinely new user information. "
    "If nothing in the EveOS context or history is relevant to the user's message (greetings, "
    "small talk, acknowledgments, connection tests), reply with exactly: NO_CONTEXT"
)

# Recommended system instruction for the LIVE model when Mode 2 is active. The client
# normally sets this in the Session Control system-instruction field; provided here for
# reference and reuse.
MODE2_LIVE_SYSTEM_INSTRUCTION = (
    "You are a faithful text-to-speech voice. Speak the exact text you are given, "
    "naturally and verbatim. Do not add words, do not answer, do not reason - only "
    "voice the provided text."
)
