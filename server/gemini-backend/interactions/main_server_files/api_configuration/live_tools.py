"""Explicit Gemini Live tool declarations and browser-response bridge.

The Live API does not execute function calls automatically. EveOS intentionally exposes a
small allowlist, forwards each call to the browser workspace, validates the correlated result,
and sends a FunctionResponse back to the same Gemini Live session.
"""

import json
from uuid import uuid4

from google.genai import types


_TOOL_SPECS = (
    {
        "name": "eve_get_client_time",
        "description": "Read the EveOS browser's current local time and timezone.",
        "parameters_json_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "eve_get_context_memory_state",
        "description": "Read whether EveOS conversation-memory context is enabled.",
        "parameters_json_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "eve_set_context_memory_state",
        "description": "Enable or disable EveOS conversation-memory context for later turns.",
        "parameters_json_schema": {
            "type": "object",
            "properties": {"enabled": {"type": "boolean", "description": "Desired conversation-memory state."}},
            "required": ["enabled"],
            "additionalProperties": False,
        },
    },
    {
        "name": "eve_get_screen_share_state",
        "description": "Read whether EveOS screen sharing is active. This never returns captured frame contents.",
        "parameters_json_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "eve_get_audio_playback_diagnostics",
        "description": "Read bounded Gemini Live audio queue, underrun, and backlog diagnostics from the browser.",
        "parameters_json_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
    {
        "name": "eve_get_session_state",
        "description": "Read non-secret EveOS Gemini session state such as model, socket readiness, and page visibility.",
        "parameters_json_schema": {"type": "object", "properties": {}, "additionalProperties": False},
    },
)

LIVE_TOOL_NAMES = frozenset(spec["name"] for spec in _TOOL_SPECS)
_MAX_TOOL_RESPONSE_CHARS = 16_384
_MAX_COMPLETED_CALLS = 128
_NO_ARG_TOOLS = LIVE_TOOL_NAMES - {"eve_set_context_memory_state"}


def build_live_tools():
    declarations = [types.FunctionDeclaration(**spec) for spec in _TOOL_SPECS]
    return [types.Tool(function_declarations=declarations)]


def _pending_calls(connection_monitor):
    pending = getattr(connection_monitor, "pending_gemini_tool_calls", None)
    if not isinstance(pending, dict):
        pending = {}
        setattr(connection_monitor, "pending_gemini_tool_calls", pending)
    return pending


def _completed_calls(connection_monitor):
    completed = getattr(connection_monitor, "completed_gemini_tool_calls", None)
    if not isinstance(completed, dict):
        completed = {}
        setattr(connection_monitor, "completed_gemini_tool_calls", completed)
    return completed


def _remember_completed(connection_monitor, request_id, record, response):
    completed = _completed_calls(connection_monitor)
    completed[request_id] = {
        "name": record["name"],
        "provider_id": record.get("provider_id", ""),
        "response": _bounded_response(response),
    }
    while len(completed) > _MAX_COMPLETED_CALLS:
        completed.pop(next(iter(completed)))


def _safe_args(value):
    if value is None:
        return {}
    if isinstance(value, dict):
        return value
    try:
        return dict(value)
    except Exception:
        return {}


def _validate_args(name, args):
    if name in _NO_ARG_TOOLS:
        return None if not args else "This EveOS tool does not accept arguments."
    if name == "eve_set_context_memory_state":
        if set(args) != {"enabled"} or not isinstance(args.get("enabled"), bool):
            return "enabled must be a boolean and is the only accepted argument."
        return None
    return "EveOS rejected an undeclared Live tool."


def _bounded_response(value):
    payload = value if isinstance(value, dict) else {"result": value}
    try:
        encoded = json.dumps(payload, ensure_ascii=False, default=str)
    except Exception:
        return {"ok": False, "error": "Tool result could not be serialized."}
    if len(encoded) <= _MAX_TOOL_RESPONSE_CHARS:
        return payload
    return {
        "ok": False,
        "error": "Tool result exceeded the EveOS Live response limit.",
        "truncatedChars": len(encoded),
    }


async def _send_function_response(session, *, provider_id, name, response):
    kwargs = {"name": name, "response": _bounded_response(response)}
    if provider_id:
        kwargs["id"] = provider_id
    await session.send_tool_response(function_responses=[types.FunctionResponse(**kwargs)])


async def forward_provider_tool_messages(response, session, connection_monitor):
    """Forward provider function calls/cancellations to the browser and reject unsafe calls."""
    forwarded = 0
    tool_call = getattr(response, "tool_call", None)
    function_calls = list(getattr(tool_call, "function_calls", None) or [])
    pending = _pending_calls(connection_monitor)
    completed = _completed_calls(connection_monitor)

    for call in function_calls:
        name = str(getattr(call, "name", "") or "")
        provider_id = str(getattr(call, "id", "") or "")
        request_id = provider_id or uuid4().hex

        if name not in LIVE_TOOL_NAMES:
            await _send_function_response(
                session,
                provider_id=provider_id,
                name=name or "unknown_tool",
                response={"ok": False, "error": "EveOS rejected an undeclared Live tool."},
            )
            continue

        args = _safe_args(getattr(call, "args", None))
        validation_error = _validate_args(name, args)
        if validation_error:
            await _send_function_response(
                session,
                provider_id=provider_id,
                name=name,
                response={"ok": False, "error": validation_error},
            )
            continue

        # Provider ids are stable call identities. Replays after completion receive the cached
        # result without executing browser state changes twice; replays while pending share the
        # original in-flight browser execution.
        if provider_id and request_id in completed:
            cached = completed[request_id]
            await _send_function_response(
                session,
                provider_id=provider_id,
                name=cached["name"],
                response=cached["response"],
            )
            continue
        if request_id in pending:
            continue

        pending[request_id] = {"name": name, "provider_id": provider_id}
        await connection_monitor.safe_send(json.dumps({
            "type": "gemini_tool_call",
            "call": {"requestId": request_id, "name": name, "args": args},
        }))
        forwarded += 1

    cancellation = getattr(response, "tool_call_cancellation", None)
    cancelled_ids = list(getattr(cancellation, "ids", None) or []) if cancellation is not None else []
    for provider_id in cancelled_ids:
        request_id = str(provider_id or "")
        record = pending.pop(request_id, None)
        await connection_monitor.safe_send(json.dumps({
            "type": "gemini_tool_call_cancelled",
            "requestId": request_id,
            "name": (record or {}).get("name", ""),
        }))

    return forwarded


async def handle_browser_tool_response(data, session, connection_monitor):
    """Validate one browser result and return it to Gemini Live as FunctionResponse."""
    request_id = str(data.get("requestId", "") or "")
    pending = _pending_calls(connection_monitor)
    record = pending.get(request_id)
    if not request_id or not record:
        await connection_monitor.safe_send(json.dumps({
            "type": "gemini_tool_response_rejected",
            "requestId": request_id,
            "reason": "unknown_or_completed_request",
        }))
        return False

    supplied_name = str(data.get("name", "") or "")
    if supplied_name and supplied_name != record["name"]:
        await connection_monitor.safe_send(json.dumps({
            "type": "gemini_tool_response_rejected",
            "requestId": request_id,
            "reason": "tool_name_mismatch",
        }))
        return False

    pending.pop(request_id, None)
    response = _bounded_response(data.get("response", {"ok": True}))
    await _send_function_response(
        session,
        provider_id=record.get("provider_id", ""),
        name=record["name"],
        response=response,
    )
    _remember_completed(connection_monitor, request_id, record, response)
    await connection_monitor.safe_send(json.dumps({
        "type": "gemini_tool_response_ack",
        "requestId": request_id,
        "name": record["name"],
    }))
    return True
