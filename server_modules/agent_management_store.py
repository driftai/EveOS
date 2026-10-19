"""Versioned, machine-local Agent Management persistence for EveOS."""

from __future__ import annotations

import json
import os
import re
import shutil
import tempfile
import threading
from datetime import datetime, timezone
from pathlib import Path


SCHEMA_NAME = "eveos.agent-management"
SCHEMA_VERSION = 1
MAX_AGENTS = 128
MAX_SCOPES = 64
_ID_PATTERN = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
_PROJECT_ROOT = Path(__file__).resolve().parent.parent
STORE_PATH = _PROJECT_ROOT / "data" / "runtime" / "agent-management" / "agents.json"
BACKUP_PATH = STORE_PATH.with_name("agents.backup.json")
_STORE_LOCK = threading.RLock()


class AgentStoreError(ValueError):
    """Raised when local Agent Management data violates the public contract."""


def _now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def _text(value, field: str, *, maximum: int, required: bool = False) -> str:
    if value is None and not required:
        return ""
    if not isinstance(value, str):
        raise AgentStoreError(f"{field} must be text")
    normalized = value.strip()
    if required and not normalized:
        raise AgentStoreError(f"{field} is required")
    if len(normalized) > maximum:
        raise AgentStoreError(f"{field} exceeds {maximum} characters")
    return normalized


def _identifier(value, field: str) -> str:
    normalized = _text(value, field, maximum=64, required=True).lower()
    if not _ID_PATTERN.fullmatch(normalized):
        raise AgentStoreError(f"{field} must use lowercase letters, numbers, dots, dashes, or underscores")
    return normalized


def _text_list(value, field: str, *, maximum_items: int = 64, item_limit: int = 500) -> list[str]:
    if value is None:
        return []
    if not isinstance(value, list):
        raise AgentStoreError(f"{field} must be a list")
    if len(value) > maximum_items:
        raise AgentStoreError(f"{field} exceeds {maximum_items} entries")
    items = []
    for index, item in enumerate(value):
        normalized = _text(item, f"{field}[{index}]", maximum=item_limit, required=True)
        if normalized not in items:
            items.append(normalized)
    return items


def _normalize_provider(value) -> dict:
    if value is None:
        provider = {}
    elif isinstance(value, dict):
        provider = value
    else:
        raise AgentStoreError("providerBinding must be an object")
    return {
        "provider": _text(provider.get("provider") or "unassigned", "providerBinding.provider", maximum=64, required=True),
        "modelId": _text(provider.get("modelId"), "providerBinding.modelId", maximum=160),
        "profile": _text(provider.get("profile"), "providerBinding.profile", maximum=120),
    }


def _normalize_scope(value, index: int) -> dict:
    if not isinstance(value, dict):
        raise AgentStoreError(f"scopes[{index}] must be an object")
    return {
        "id": _identifier(value.get("id"), f"scopes[{index}].id"),
        "label": _text(value.get("label"), f"scopes[{index}].label", maximum=100, required=True),
        "instructions": _text(value.get("instructions"), f"scopes[{index}].instructions", maximum=12000),
        "context": _text_list(value.get("context"), f"scopes[{index}].context", item_limit=4000),
        "allowedTools": _text_list(value.get("allowedTools"), f"scopes[{index}].allowedTools", item_limit=120),
    }


def normalize_agent(value) -> dict:
    if not isinstance(value, dict):
        raise AgentStoreError("agent must be an object")
    scopes_source = value.get("scopes")
    if scopes_source is None:
        scopes_source = [{"id": "default", "label": "Default"}]
    if not isinstance(scopes_source, list) or not scopes_source:
        raise AgentStoreError("scopes must contain at least one scope")
    if len(scopes_source) > MAX_SCOPES:
        raise AgentStoreError(f"scopes exceeds {MAX_SCOPES} entries")
    scopes = [_normalize_scope(scope, index) for index, scope in enumerate(scopes_source)]
    scope_ids = [scope["id"] for scope in scopes]
    if len(scope_ids) != len(set(scope_ids)):
        raise AgentStoreError("scope ids must be unique within an agent")
    provenance_value = value.get("provenance")
    if provenance_value is None:
        provenance = {}
    elif isinstance(provenance_value, dict):
        provenance = provenance_value
    else:
        raise AgentStoreError("agent.provenance must be an object")
    provenance_source = provenance.get("source")
    if provenance_source not in {None, "local-user"}:
        raise AgentStoreError("agent.provenance.source must be local-user")
    return {
        "id": _identifier(value.get("id"), "agent.id"),
        "displayName": _text(value.get("displayName"), "agent.displayName", maximum=100, required=True),
        "role": _text(value.get("role"), "agent.role", maximum=240),
        "identity": _text(value.get("identity"), "agent.identity", maximum=16000),
        "workingRules": _text_list(value.get("workingRules"), "agent.workingRules", item_limit=2000),
        "providerBinding": _normalize_provider(value.get("providerBinding")),
        "allowedTools": _text_list(value.get("allowedTools"), "agent.allowedTools", item_limit=120),
        "permissions": _text_list(value.get("permissions"), "agent.permissions", item_limit=120),
        "privateNotes": _text_list(value.get("privateNotes"), "agent.privateNotes", item_limit=4000),
        "scopes": scopes,
        "provenance": {
            "source": "local-user",
            "updatedAt": _text(provenance.get("updatedAt"), "agent.provenance.updatedAt", maximum=40) or _now_iso(),
        },
    }


def default_store() -> dict:
    return {
        "schema": SCHEMA_NAME,
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": None,
        "agents": [normalize_agent({
            "id": "tlo",
            "displayName": "TLO",
            "role": "Local EveOS agent",
            "identity": "The Little One is a distinct agent that uses Local MoE as a provider.",
            "providerBinding": {"provider": "local-moe"},
            "scopes": [{"id": "default", "label": "Default"}],
        })],
    }


def normalize_store(value) -> dict:
    if not isinstance(value, dict):
        raise AgentStoreError("Agent Management store must be an object")
    if value.get("schema") != SCHEMA_NAME or value.get("schemaVersion") != SCHEMA_VERSION:
        raise AgentStoreError(f"Unsupported Agent Management schema; expected {SCHEMA_NAME} v{SCHEMA_VERSION}")
    source_agents = value.get("agents")
    if not isinstance(source_agents, list):
        raise AgentStoreError("agents must be a list")
    if len(source_agents) > MAX_AGENTS:
        raise AgentStoreError(f"agents exceeds {MAX_AGENTS} entries")
    agents = [normalize_agent(agent) for agent in source_agents]
    agent_ids = [agent["id"] for agent in agents]
    if len(agent_ids) != len(set(agent_ids)):
        raise AgentStoreError("agent ids must be unique")
    return {
        "schema": SCHEMA_NAME,
        "schemaVersion": SCHEMA_VERSION,
        "updatedAt": _text(value.get("updatedAt"), "updatedAt", maximum=40) or None,
        "agents": agents,
    }


def load_store() -> tuple[dict, bool]:
    with _STORE_LOCK:
        if not STORE_PATH.exists():
            return default_store(), False
        try:
            payload = json.loads(STORE_PATH.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            raise AgentStoreError("Agent Management data could not be read safely") from exc
        return normalize_store(payload), True


def _write_store(store: dict) -> None:
    normalized = normalize_store(store)
    normalized["updatedAt"] = _now_iso()
    STORE_PATH.parent.mkdir(parents=True, exist_ok=True)
    if STORE_PATH.exists():
        shutil.copyfile(STORE_PATH, BACKUP_PATH)
    handle, temporary_name = tempfile.mkstemp(prefix="agents-", suffix=".tmp", dir=STORE_PATH.parent)
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            json.dump(normalized, stream, ensure_ascii=False, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(temporary_name, STORE_PATH)
    finally:
        if os.path.exists(temporary_name):
            os.unlink(temporary_name)


def save_agent(value) -> dict:
    agent = normalize_agent(value)
    agent["provenance"]["updatedAt"] = _now_iso()
    with _STORE_LOCK:
        store, _ = load_store()
        agents = list(store["agents"])
        replacement_index = next((index for index, item in enumerate(agents) if item["id"] == agent["id"]), None)
        if replacement_index is None:
            if len(agents) >= MAX_AGENTS:
                raise AgentStoreError(f"agents exceeds {MAX_AGENTS} entries")
            agents.append(agent)
        else:
            agents[replacement_index] = agent
        store["agents"] = agents
        _write_store(store)
        return agent


def scoped_projection(agent_id: str, scope_id: str = "default") -> dict:
    target_agent = _identifier(agent_id, "agentId")
    target_scope = _identifier(scope_id or "default", "scopeId")
    store, _ = load_store()
    agent = next((item for item in store["agents"] if item["id"] == target_agent), None)
    if not agent:
        raise AgentStoreError("Agent not found")
    scope = next((item for item in agent["scopes"] if item["id"] == target_scope), None)
    if not scope:
        raise AgentStoreError("Agent scope not found")
    from server_modules import agent_document_library, tlo_definition

    definition = tlo_definition.load(agent) if target_agent == "tlo" else None
    nexus_guide = agent_document_library.tlo_guide() if target_agent == "tlo" else None
    return {
        "schema": "eveos.agent-projection",
        "schemaVersion": 1,
        "agent": {
            "id": agent["id"],
            "displayName": agent["displayName"],
            "role": agent["role"],
            "identity": agent["identity"],
            "workingRules": list(agent["workingRules"]),
            "providerBinding": dict(agent["providerBinding"]),
            "allowedTools": list(agent["allowedTools"]),
            **({"nexusGuide": nexus_guide["text"], "nexusGuideRevision": nexus_guide["revision"]} if nexus_guide else {}),
            **({"definition": definition["text"], "definitionMetadata": {
                "source": definition["source"], "revision": definition["revision"], "path": definition["path"],
                "includedSections": ["agent.definition", "agent.role", "scope.instructions", "scope.context", "allowedTools"],
                "metadataOnly": ["origin"],
            }} if definition else {}),
        },
        "scope": {
            "id": scope["id"],
            "label": scope["label"],
            "instructions": scope["instructions"],
            "context": list(scope["context"]),
            "allowedTools": list(scope["allowedTools"]),
        },
    }
