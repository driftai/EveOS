"""Loopback-authorized HTTP surface for Agent Management."""

from __future__ import annotations

import json
import logging
from http import HTTPStatus

from server_modules import agent_document_library, agent_management_store, agent_portability, gemini_control, tlo_definition
from server_modules.eve_state_store_api_helpers import query_value, send_json


BASE_PATH = "/api/eve-state/modular/agent-management"
MAX_BODY_BYTES = 256 * 1024
logger = logging.getLogger("EveOSAgentManagement")


def authorize_local_ui(handler) -> bool:
    headers = getattr(handler, "headers", None)
    origin = str(headers.get("Origin", "") if headers else "").strip().lower()
    trusted_origin = (
        not origin
        or origin.startswith("http://127.0.0.1:")
        or origin.startswith("http://localhost:")
    )
    if trusted_origin and gemini_control.request_can_control(handler):
        return True
    send_json(handler, HTTPStatus.FORBIDDEN, {
        "ok": False,
        "error": "Agent Management requires the localhost EveOS page.",
    })
    return False


def _read_body(handler, *, maximum=MAX_BODY_BYTES):
    try:
        content_length = int(handler.headers.get("Content-Length", "0"))
    except (TypeError, ValueError):
        content_length = 0
    if content_length <= 0:
        return None, "Empty request body"
    if content_length > maximum:
        handler.close_connection = True
        return None, f"Request body exceeds {maximum} bytes"
    raw = handler.rfile.read(content_length)
    try:
        payload = json.loads(raw.decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError):
        return None, "Invalid JSON body"
    if not isinstance(payload, dict):
        return None, "Request body must be an object"
    return payload, None


def handle_get_request(handler, path, query) -> bool:
    if path not in {BASE_PATH, f"{BASE_PATH}/projection", f"{BASE_PATH}/definition", f"{BASE_PATH}/portable/export", f"{BASE_PATH}/documents", f"{BASE_PATH}/documents/file"}:
        return False
    if not authorize_local_ui(handler):
        return True
    try:
        if path == BASE_PATH:
            store, persisted = agent_management_store.load_store()
            send_json(handler, HTTPStatus.OK, {"ok": True, "persisted": persisted, "store": store})
            return True
        if path == f"{BASE_PATH}/definition":
            store, _ = agent_management_store.load_store()
            agent = next((item for item in store["agents"] if item["id"] == "tlo"), None)
            if not agent:
                raise agent_management_store.AgentStoreError("TLO agent not found")
            send_json(handler, HTTPStatus.OK, {"ok": True, "definition": tlo_definition.load(agent)})
            return True
        if path == f"{BASE_PATH}/documents":
            send_json(handler, HTTPStatus.OK, {"ok": True, "documents": agent_document_library.catalog()})
            return True
        if path == f"{BASE_PATH}/documents/file":
            document = agent_document_library.read(query_value(query, "path"))
            send_json(handler, HTTPStatus.OK, {"ok": True, "document": document})
            return True
        if path == f"{BASE_PATH}/portable/export":
            send_json(handler, HTTPStatus.OK, {"ok": True, "bundle": agent_portability.export_bundle()})
            return True
        projection = agent_management_store.scoped_projection(
            query_value(query, "agentId"),
            query_value(query, "scopeId", "default"),
        )
        send_json(handler, HTTPStatus.OK, {"ok": True, "projection": projection})
    except (agent_management_store.AgentStoreError, tlo_definition.DefinitionError,
            agent_document_library.DocumentError, agent_portability.PortabilityError) as exc:
        send_json(handler, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
    except Exception:
        logger.exception("Agent Management read failed")
        send_json(handler, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "Agent Management read failed."})
    return True


def handle_post_request(handler, path) -> bool:
    if path not in {f"{BASE_PATH}/save", f"{BASE_PATH}/definition",
                    f"{BASE_PATH}/portable/preview", f"{BASE_PATH}/portable/apply",
                    f"{BASE_PATH}/documents/file"}:
        return False
    if not authorize_local_ui(handler):
        return True
    portable = path.startswith(f"{BASE_PATH}/portable/")
    payload, error = _read_body(handler, maximum=agent_portability.MAX_BYTES if portable else MAX_BODY_BYTES)
    if error:
        send_json(handler, HTTPStatus.BAD_REQUEST, {"ok": False, "error": error})
        return True
    try:
        if portable:
            result = (agent_portability.preview(payload.get("bundle")) if path.endswith("/preview")
                      else agent_portability.apply(payload.get("bundle")))
            send_json(handler, HTTPStatus.OK, {"ok": True, "plan": result})
            return True
        if path == f"{BASE_PATH}/documents/file":
            document = agent_document_library.save(payload.get("path"), payload.get("text"),
                                                   payload.get("expectedRevision"))
            send_json(handler, HTTPStatus.OK, {"ok": True, "document": document})
            return True
        if path == f"{BASE_PATH}/definition":
            definition = tlo_definition.save(payload.get("text"))
            send_json(handler, HTTPStatus.OK, {"ok": True, "definition": definition})
            return True
        agent = agent_management_store.save_agent(payload.get("agent"))
        send_json(handler, HTTPStatus.OK, {
            "ok": True,
            "schemaVersion": agent_management_store.SCHEMA_VERSION,
            "agent": agent,
        })
    except (agent_management_store.AgentStoreError, tlo_definition.DefinitionError,
            agent_document_library.DocumentError, agent_portability.PortabilityError) as exc:
        send_json(handler, HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)})
    except Exception:
        logger.exception("Agent Management save failed")
        send_json(handler, HTTPStatus.INTERNAL_SERVER_ERROR, {"ok": False, "error": "Agent Management save failed."})
    return True
