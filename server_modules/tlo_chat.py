"""Thin EveOS policy and streaming adapter between TLO and Local MoE."""

from __future__ import annotations

import http.client
import json
import logging
import re
import threading
from dataclasses import dataclass, field
from http import HTTPStatus

from server_modules import agent_management_store, eveos_ports, gemini_control, local_moe_control
from server_modules.eve_state_store_api_helpers import query_value, send_json


BASE_PATH = "/api/eve-state/modular/tlo"
HARNESS_HOST = "127.0.0.1"
HARNESS_PORT = eveos_ports.service_port("LOCAL_MOE_HARNESS_PORT")
MAX_BODY_BYTES = 256 * 1024
MAX_MESSAGE_CHARS = 16_000
MAX_HISTORY_MESSAGES = 40
MAX_HISTORY_CHARS = 32_000
_REQUEST_ID = re.compile(r"^[A-Za-z0-9._-]{8,96}$")
_ACTIVE_LOCK = threading.RLock()
_SCHEMA_CACHE_LOCK = threading.RLock()
_SCHEMA_CACHE: dict[tuple[str, str, str], dict] = {}
_SCHEMA_INFLIGHT: dict[tuple[str, str, str], threading.Event] = {}
_SCHEMA_PATH = "/openapi.json"
logger = logging.getLogger("EveOSTLO")


@dataclass
class ActiveStream:
    cancelled: threading.Event = field(default_factory=threading.Event)
    connection: http.client.HTTPConnection | None = None


_ACTIVE: dict[str, ActiveStream] = {}


class TloChatError(ValueError):
    def __init__(self, message: str, *, status=HTTPStatus.BAD_REQUEST, state="invalid_request"):
        super().__init__(message)
        self.status = status
        self.state = state


def _authorize_tlo_ui(handler) -> bool:
    """Allow only loopback EveOS UI callers, including the supported file:// surface."""
    if gemini_control.request_can_control(handler):
        return True
    send_json(handler, HTTPStatus.FORBIDDEN, {
        "ok": False,
        "state": "forbidden",
        "error": "TLO requires a local EveOS page.",
    })
    return False


def _clean_text(value, field_name: str, maximum: int, *, required=False) -> str:
    if not isinstance(value, str):
        raise TloChatError(f"{field_name} must be text")
    text = value.strip()
    if required and not text:
        raise TloChatError(f"{field_name} is required")
    if len(text) > maximum:
        raise TloChatError(f"{field_name} exceeds {maximum} characters")
    return text


def _read_body(handler) -> dict:
    try:
        length = int(handler.headers.get("Content-Length", "0"))
    except (TypeError, ValueError):
        length = 0
    if length <= 0:
        raise TloChatError("Empty request body")
    if length > MAX_BODY_BYTES:
        handler.close_connection = True
        raise TloChatError(f"Request body exceeds {MAX_BODY_BYTES} bytes")
    try:
        payload = json.loads(handler.rfile.read(length).decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise TloChatError("Invalid JSON body") from exc
    if not isinstance(payload, dict):
        raise TloChatError("Request body must be an object")
    return payload


def _history(value) -> list[dict]:
    if value is None:
        return []
    if not isinstance(value, list) or len(value) > MAX_HISTORY_MESSAGES:
        raise TloChatError(f"history must contain at most {MAX_HISTORY_MESSAGES} messages")
    normalized = []
    for index, item in enumerate(value):
        if not isinstance(item, dict) or item.get("role") not in {"user", "assistant"}:
            raise TloChatError(f"history[{index}] has an invalid role")
        normalized.append({
            "role": item["role"],
            "content": _clean_text(item.get("content"), f"history[{index}].content", MAX_HISTORY_CHARS, required=True),
        })
    return normalized


def build_system_prompt(projection: dict) -> str:
    """Build inference context exclusively from the allowlisted scoped projection."""
    agent = projection.get("agent") if isinstance(projection.get("agent"), dict) else {}
    scope = projection.get("scope") if isinstance(projection.get("scope"), dict) else {}
    display_name = str(agent.get("displayName") or "TLO").strip()
    sections = [
        f"You are {display_name}, an EveOS local agent.",
        f"Role:\n{str(agent.get('role') or '').strip()}",
    ]
    definition = str(agent.get("definition") or "").strip()
    sections.append(f"Agent definition:\n{definition}" if definition else f"Identity:\n{str(agent.get('identity') or '').strip()}")
    rules = [] if definition else [str(item).strip() for item in agent.get("workingRules") or [] if str(item).strip()]
    if rules:
        sections.append("Working rules:\n" + "\n".join(f"- {item}" for item in rules))
    instructions = str(scope.get("instructions") or "").strip()
    if instructions:
        sections.append(f"Scope instructions ({scope.get('id') or 'default'}):\n{instructions}")
    context = [str(item).strip() for item in scope.get("context") or [] if str(item).strip()]
    if context:
        sections.append("Scope context:\n" + "\n".join(f"- {item}" for item in context))
    tools = []
    for item in [*(agent.get("allowedTools") or []), *(scope.get("allowedTools") or [])]:
        name = str(item).strip()
        if name and name not in tools:
            tools.append(name)
    if tools:
        sections.append(
            "Allowed capability context (availability must still be confirmed by EveOS):\n"
            + "\n".join(f"- {item}" for item in tools)
        )
    sections.append("Never claim access to data, tools, agents, or scopes not present in this projection.")
    return "\n\n".join(section for section in sections if not section.endswith("\n"))


def _fetch_harness_json(path: str, *, timeout=4.5) -> dict | None:
    connection = None
    try:
        connection = http.client.HTTPConnection(HARNESS_HOST, HARNESS_PORT, timeout=timeout)
        connection.request("GET", path, headers={"Connection": "close"})
        response = connection.getresponse()
        payload = json.loads(response.read(2_000_000).decode("utf-8"))
        return payload if response.status < 400 and isinstance(payload, dict) else None
    except (OSError, ValueError, UnicodeError):
        return None
    finally:
        if connection is not None:
            connection.close()


def _schema_cache_key(path: str) -> tuple[str, str, str]:
    return ("local-moe", f"http://{HARNESS_HOST}:{HARNESS_PORT}", path)


def _harness_json(path: str, *, timeout=4.5) -> dict | None:
    """Fetch Harness JSON, caching only the stable OpenAPI schema.

    `/api/status` and every other runtime endpoint stay live/uncached. Concurrent
    schema discovery shares one in-flight request; failures are deliberately not
    cached so a later request can recover after the Harness comes online.
    """
    if path != _SCHEMA_PATH:
        return _fetch_harness_json(path, timeout=timeout)

    key = _schema_cache_key(path)
    with _SCHEMA_CACHE_LOCK:
        cached = _SCHEMA_CACHE.get(key)
        if cached is not None:
            return cached
        waiter = _SCHEMA_INFLIGHT.get(key)
        owner = waiter is None
        if owner:
            waiter = threading.Event()
            _SCHEMA_INFLIGHT[key] = waiter

    if not owner:
        waiter.wait(timeout=max(0.1, float(timeout)) + 0.5)
        with _SCHEMA_CACHE_LOCK:
            return _SCHEMA_CACHE.get(key)

    payload = None
    try:
        payload = _fetch_harness_json(path, timeout=timeout)
        return payload
    finally:
        with _SCHEMA_CACHE_LOCK:
            if payload is not None:
                _SCHEMA_CACHE[key] = payload
            current = _SCHEMA_INFLIGHT.pop(key, None)
            if current is not None:
                current.set()


def _projection(scope_id: str) -> dict:
    projection = agent_management_store.scoped_projection("tlo", scope_id or "default")
    provider = projection.get("agent", {}).get("providerBinding", {}).get("provider")
    if provider != "local-moe":
        raise TloChatError(
            "TLO must use the Local MoE provider before chatting.",
            status=HTTPStatus.CONFLICT,
            state="provider_mismatch",
        )
    return projection


def _model_policy(projection: dict, harness: dict) -> tuple[str | None, str, list[dict]]:
    binding = projection.get("agent", {}).get("providerBinding") or {}
    requested = str(binding.get("modelId") or "").strip()
    registry = [item for item in harness.get("model_registry") or [] if isinstance(item, dict)]
    trusted_ids = {str(item.get("id") or "") for item in registry}
    active = str((harness.get("settings") or {}).get("active_model_id") or "")
    if requested and requested not in trusted_ids:
        raise TloChatError(
            "TLO's configured model is not in the trusted Local MoE registry.",
            status=HTTPStatus.BAD_REQUEST,
            state="model_untrusted",
        )
    if requested and requested != active:
        raise TloChatError(
            "TLO's configured model differs from the active Harness model. Switch it in Local MoE first.",
            status=HTTPStatus.CONFLICT,
            state="model_mismatch",
        )
    return requested or None, active, registry


def status_payload(scope_id="default") -> dict:
    projection = _projection(scope_id)
    lifecycle = local_moe_control.get_status()
    harness = _harness_json("/api/status") if lifecycle.get("running") else None
    state = str(lifecycle.get("state") or "stopped")
    can_chat = False
    message = str(lifecycle.get("message") or "Local MoE is stopped.")
    active_model = str((lifecycle.get("activeModel") or {}).get("id") or "")
    configured_model = str(projection["agent"].get("providerBinding", {}).get("modelId") or "")
    if lifecycle.get("running") and harness:
        switch = harness.get("model_switch") or {}
        runtime = harness.get("runtime") or {}
        if switch.get("status") == "switching":
            state, message = "model_switching", "Local MoE is switching models. TLO will be ready afterward."
        elif runtime.get("ready") is not True:
            state = "runtime_offline" if runtime.get("reachable") is not True else "runtime_starting"
            message = "The Local MoE runtime is offline." if state == "runtime_offline" else "The Local MoE model is still loading."
        else:
            try:
                _requested, active_model, _registry = _model_policy(projection, harness)
                state, can_chat = "ready", True
                message = "TLO is ready through the active Local MoE model."
            except TloChatError as exc:
                state, message = exc.state, str(exc)
    elif lifecycle.get("running"):
        state, message = "stream_interrupted", "Local MoE is online but its status endpoint is unavailable."
    elif state == "stopped":
        message = "Local MoE is stopped. Start it explicitly before chatting with TLO."
    return {
        "ok": True,
        "state": state,
        "canChat": can_chat,
        "message": message,
        "agent": {
            "id": "tlo",
            "displayName": projection["agent"].get("displayName") or "TLO",
            "role": projection["agent"].get("role") or "Local EveOS agent",
            "scopeId": projection["scope"].get("id") or "default",
            "provider": "local-moe",
            "configuredModelId": configured_model,
            "activeModelId": active_model,
            "definition": {key: projection["agent"].get("definitionMetadata", {}).get(key)
                           for key in ("source", "revision")},
        },
        "localMoe": {
            "running": lifecycle.get("running") is True,
            "owned": lifecycle.get("owned") is True,
            "state": lifecycle.get("state") or "stopped",
            "runtimeReady": lifecycle.get("runtimeReady") is True,
        },
    }


def _request_data(payload: dict) -> tuple[str, str, str, list[dict]]:
    message = _clean_text(payload.get("message"), "message", MAX_MESSAGE_CHARS, required=True)
    scope_id = _clean_text(payload.get("scopeId") or "default", "scopeId", 64, required=True).lower()
    request_id = _clean_text(payload.get("requestId"), "requestId", 96, required=True)
    if not _REQUEST_ID.fullmatch(request_id):
        raise TloChatError("requestId has an invalid format")
    return message, scope_id, request_id, _history(payload.get("history"))


def _register(request_id: str) -> ActiveStream:
    with _ACTIVE_LOCK:
        if request_id in _ACTIVE:
            raise TloChatError("requestId is already active", status=HTTPStatus.CONFLICT, state="duplicate_request")
        stream = ActiveStream()
        _ACTIVE[request_id] = stream
        return stream


def cancel_active(request_id: str) -> bool:
    with _ACTIVE_LOCK:
        stream = _ACTIVE.get(request_id)
        if not stream:
            return False
        stream.cancelled.set()
        connection = stream.connection
    if connection is not None:
        try:
            connection.close()
        except OSError:
            pass
    return True


def _error_payload(exc: TloChatError) -> dict:
    return {"ok": False, "state": exc.state, "error": str(exc)}


def _upstream_error(response) -> TloChatError:
    raw = response.read(64_000)
    message = "Local MoE rejected the TLO request."
    try:
        payload = json.loads(raw.decode("utf-8"))
        detail = payload.get("detail") if isinstance(payload, dict) else None
        if isinstance(detail, dict):
            message = str(detail.get("message") or message)
        elif isinstance(detail, str):
            message = detail
    except (UnicodeError, ValueError):
        pass
    state = "model_switching" if response.status == 409 else "inference_failure"
    return TloChatError(message[:500], status=response.status, state=state)


def _stream_chat(handler, payload: dict) -> None:
    message, scope_id, request_id, history = _request_data(payload)
    projection = _projection(scope_id)
    lifecycle = local_moe_control.get_status()
    if not lifecycle.get("running"):
        state = "harness_starting" if lifecycle.get("state") == "starting" else "harness_stopped"
        raise TloChatError(
            "Local MoE is starting." if state == "harness_starting" else "Local MoE is stopped. Start it explicitly before chatting with TLO.",
            status=HTTPStatus.SERVICE_UNAVAILABLE,
            state=state,
        )
    harness = _harness_json("/api/status")
    if not harness:
        raise TloChatError("Local MoE status is unavailable.", status=HTTPStatus.BAD_GATEWAY, state="stream_interrupted")
    model_id, _active, _registry = _model_policy(projection, harness)
    runtime = harness.get("runtime") or {}
    if runtime.get("ready") is not True:
        state = "runtime_offline" if runtime.get("reachable") is not True else "runtime_starting"
        raise TloChatError("The Local MoE runtime is not ready.", status=HTTPStatus.SERVICE_UNAVAILABLE, state=state)

    body = {"message": message, "system": build_system_prompt(projection), "history": history}
    if model_id:
        body["model"] = model_id
    encoded = json.dumps(body, ensure_ascii=False).encode("utf-8")
    stream = _register(request_id)
    connection = http.client.HTTPConnection(HARNESS_HOST, HARNESS_PORT, timeout=300)
    stream.connection = connection
    response_started = False
    seen_done = False
    tail = b""
    try:
        connection.request("POST", "/api/chat/stream", body=encoded, headers={
            "Content-Type": "application/json",
            "Content-Length": str(len(encoded)),
            "Connection": "close",
        })
        response = connection.getresponse()
        if response.status >= 400:
            raise _upstream_error(response)
        handler.send_response(HTTPStatus.OK)
        handler.send_header("Content-Type", "text/event-stream; charset=utf-8")
        handler.send_header("Cache-Control", "no-cache")
        handler.send_header("X-Accel-Buffering", "no")
        handler.send_header("Connection", "close")
        handler.end_headers()
        handler.close_connection = True
        response_started = True
        while not stream.cancelled.is_set():
            chunk = response.read1(8192)
            if not chunk:
                break
            seen_done = b"data: [DONE]" in tail + chunk
            tail = (tail + chunk)[-64:]
            handler.wfile.write(chunk)
            handler.wfile.flush()
        if not stream.cancelled.is_set() and not seen_done:
            error = json.dumps({"error": {"message": "The Local MoE stream ended before completion.", "state": "stream_interrupted"}})
            handler.wfile.write(f"data: {error}\n\ndata: [DONE]\n\n".encode("utf-8"))
            handler.wfile.flush()
    except TloChatError:
        raise
    except (BrokenPipeError, ConnectionResetError):
        stream.cancelled.set()
    except Exception as exc:
        if not response_started:
            raise TloChatError("Local MoE inference could not start.", status=HTTPStatus.BAD_GATEWAY, state="inference_failure") from exc
        if not stream.cancelled.is_set() and not seen_done:
            logger.exception("TLO upstream stream interrupted")
            error = json.dumps({"error": {"message": "The TLO stream was interrupted.", "state": "stream_interrupted"}})
            try:
                handler.wfile.write(f"data: {error}\n\ndata: [DONE]\n\n".encode("utf-8"))
                handler.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
    finally:
        connection.close()
        with _ACTIVE_LOCK:
            _ACTIVE.pop(request_id, None)


def handle_get_request(handler, path, query) -> bool:
    if path != f"{BASE_PATH}/status":
        return False
    if not _authorize_tlo_ui(handler):
        return True
    try:
        send_json(handler, HTTPStatus.OK, status_payload(query_value(query, "scopeId", "default")))
    except agent_management_store.AgentStoreError as exc:
        send_json(handler, HTTPStatus.BAD_REQUEST, {"ok": False, "state": "profile_invalid", "error": str(exc)})
    except TloChatError as exc:
        send_json(handler, exc.status, _error_payload(exc))
    except Exception:
        logger.exception("TLO status failed")
        send_json(handler, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "state": "status_failure", "error": "TLO status failed."})
    return True


def handle_post_request(handler, path) -> bool:
    if path not in {f"{BASE_PATH}/chat/stream", f"{BASE_PATH}/chat/cancel"}:
        return False
    if not _authorize_tlo_ui(handler):
        return True
    try:
        payload = _read_body(handler)
        if path.endswith("/cancel"):
            request_id = _clean_text(payload.get("requestId"), "requestId", 96, required=True)
            if not _REQUEST_ID.fullmatch(request_id):
                raise TloChatError("requestId has an invalid format")
            send_json(handler, HTTPStatus.OK, {"ok": True, "cancelled": cancel_active(request_id)})
        else:
            _stream_chat(handler, payload)
    except agent_management_store.AgentStoreError as exc:
        send_json(handler, HTTPStatus.BAD_REQUEST, {"ok": False, "state": "profile_invalid", "error": str(exc)})
    except TloChatError as exc:
        send_json(handler, exc.status, _error_payload(exc))
    except Exception:
        logger.exception("TLO chat failed")
        send_json(handler, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "state": "inference_failure", "error": "TLO chat failed."})
    return True
