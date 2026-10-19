#!/usr/bin/env python3
"""Focused Agent Management persistence, scope-isolation, and API security smoke."""

from __future__ import annotations

import io
import json
import subprocess
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import agent_management_api as api  # noqa: E402
from server_modules import agent_document_library as documents  # noqa: E402
from server_modules import agent_management_store as store, tlo_definition  # noqa: E402
from server_modules import tlo_chat  # noqa: E402


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def profile(agent_id, name, private_note, scope_context):
    return {
        "id": agent_id,
        "displayName": name,
        "role": "Test agent",
        "identity": f"Identity for {name}",
        "workingRules": [f"Rule for {name}"],
        "providerBinding": {"provider": "local-moe", "modelId": "test-model", "profile": "test"},
        "allowedTools": ["browser-search"],
        "permissions": ["local-test"],
        "privateNotes": [private_note],
        "scopes": [{
            "id": "default",
            "label": "Default",
            "instructions": f"Instructions for {name}",
            "context": [scope_context],
            "allowedTools": ["browser-search"],
        }],
    }


class FakeHandler:
    def __init__(self, *, host="127.0.0.1", origin="http://127.0.0.1:8765", body=b""):
        self.client_address = (host, 50000)
        self.headers = {"Origin": origin, "Content-Length": str(len(body))}
        self.rfile = io.BytesIO(body)
        self.wfile = io.BytesIO()
        self.status = None
        self.response_headers = {}
        self.close_connection = False

    def send_response(self, status):
        self.status = int(status)

    def send_header(self, name, value):
        self.response_headers[name] = value

    def end_headers(self):
        return None

    def payload(self):
        return json.loads(self.wfile.getvalue().decode("utf-8"))


def run():
    with tempfile.TemporaryDirectory(prefix="eveos-agent-management-") as temporary:
        live_path = Path(temporary) / "agents.json"
        backup_path = Path(temporary) / "agents.backup.json"
        definition_path = Path(temporary) / "tlo" / "AGENT.md"
        with patch.object(store, "STORE_PATH", live_path), patch.object(store, "BACKUP_PATH", backup_path), \
                patch.object(tlo_definition, "LIVE_PATH", definition_path), \
                patch.object(documents, "OVERRIDES", Path(temporary) / "documents"):
            initial, persisted = store.load_store()
            require(not persisted and [agent["id"] for agent in initial["agents"]] == ["tlo"],
                    "Missing safe non-persisted TLO bootstrap profile")

            tlo = store.save_agent(profile("tlo", "TLO", "TLO_PRIVATE_SENTINEL", "TLO_SCOPE_SENTINEL"))
            eve = store.save_agent(profile(
                "eve-engineering", "Eve Engineering", "EVE_PRIVATE_SENTINEL", "EVE_SCOPE_SENTINEL"
            ))
            store.save_agent({**eve, "role": "Updated test agent"})
            require(live_path.exists() and backup_path.exists(), "Atomic live/backup files were not created")

            saved, persisted = store.load_store()
            require(persisted and {agent["id"] for agent in saved["agents"]} == {"tlo", "eve-engineering"},
                    "Multi-agent persistence did not retain both profiles")
            projection = store.scoped_projection("tlo", "default")
            encoded = json.dumps(projection, sort_keys=True)
            require(projection["agent"]["id"] == tlo["id"] and "TLO_SCOPE_SENTINEL" in encoded,
                    "Requested TLO scope was not projected")
            for forbidden in ["TLO_PRIVATE_SENTINEL", "EVE_PRIVATE_SENTINEL", "EVE_SCOPE_SENTINEL", "permissions"]:
                require(forbidden not in encoded, f"Projection leaked forbidden field/value: {forbidden}")
            require("Identity for TLO" in projection["agent"]["definition"],
                    "Legacy authored identity was not preserved before file save")
            require(not definition_path.exists(), "Projection read should not write private state")
            saved_definition = tlo_definition.save("# TLO\n\nFILE_BACKED_SENTINEL")
            require(saved_definition["source"] == "private-file" and definition_path.exists(),
                    "Private definition file was not saved")
            updated_projection = store.scoped_projection("tlo", "default")
            prompt = tlo_chat.build_system_prompt(updated_projection)
            metadata = updated_projection["agent"]["definitionMetadata"]
            require(metadata["source"] == "private-file" and len(metadata["revision"]) == 16
                    and "origin" in metadata["metadataOnly"],
                    "Definition source/revision/metadata contract was not projected")
            require("FILE_BACKED_SENTINEL" in prompt and "Identity for TLO" not in prompt,
                    "File-backed definition did not become sole active TLO identity")
            require("I am no longer just a chat box" in tlo_definition.load(tlo)["origin"] and
                    "I am no longer just a chat box" not in prompt,
                    "Origin metadata was lost or injected into the boot prompt")
            require("TLO_PRIVATE_SENTINEL" not in prompt, "Private notes leaked into boot context")
            require("Machine Spaces" in prompt and "Nexus Browser knowledge" in prompt,
                    "Nexus guide was not injected into TLO new-turn context")
            guide = documents.read(documents.GUIDE)
            require(guide["source"] == "tracked" and
                    any(item["path"] == documents.GUIDE for item in documents.catalog()),
                    "Tracked Markdown library did not expose Nexus guide")
            updated_guide = documents.save(documents.GUIDE, "# Custom Nexus Guide\\nGUIDE_ONLY_SENTINEL\\n",
                                            guide["revision"])
            require(updated_guide["source"] == "private-override" and
                    "GUIDE_ONLY_SENTINEL" in tlo_chat.build_system_prompt(store.scoped_projection("tlo", "default")),
                    "Private guide did not reach TLO new-turn context")
            try:
                documents.save(documents.GUIDE, "old revision must fail", guide["revision"])
                raise AssertionError("Stale Markdown revision was accepted")
            except documents.DocumentError:
                pass
            require("GUIDE_ONLY_SENTINEL" in documents.read(documents.GUIDE)["text"],
                    "Rejected stale revision replaced the current document")
            require("GUIDE_ONLY_SENTINEL" not in
                    tlo_chat.build_system_prompt(store.scoped_projection("eve-engineering", "default")),
                    "TLO's guide leaked into another agent's prompt")
            try:
                tlo_definition.save("\x00")
                raise AssertionError("Invalid definition was accepted")
            except tlo_definition.DefinitionError:
                pass
            require(definition_path.read_text(encoding="utf-8") == saved_definition["text"],
                    "Rejected definition modified existing file")

            try:
                store.scoped_projection("eve-engineering", "missing")
                raise AssertionError("Unknown agent scope did not fail closed")
            except store.AgentStoreError:
                pass
            try:
                store.save_agent(profile("../escape", "Bad", "private", "context"))
                raise AssertionError("Unsafe agent id was accepted")
            except store.AgentStoreError:
                pass

            forbidden_handler = FakeHandler(host="192.0.2.20", origin="https://example.invalid")
            require(api.handle_get_request(forbidden_handler, api.BASE_PATH, {}), "Agent API did not claim its route")
            require(forbidden_handler.status == 403, "Nonlocal Agent Management caller was not rejected")

            null_origin_handler = FakeHandler(origin="null")
            require(api.handle_get_request(null_origin_handler, api.BASE_PATH, {}), "Null-origin route was not handled")
            require(null_origin_handler.status == 403, "A file/null-origin page could read private agent profiles")

            local_handler = FakeHandler()
            require(api.handle_get_request(local_handler, api.BASE_PATH, {}), "Local Agent API route was not handled")
            require(local_handler.status == 200 and local_handler.payload()["store"]["schemaVersion"] == 1,
                    "Authorized local Agent Management read failed")
            definition_handler = FakeHandler()
            require(api.handle_get_request(definition_handler, f"{api.BASE_PATH}/definition", {}),
                    "Definition endpoint was not claimed")
            require(definition_handler.status == 200 and
                    "FILE_BACKED_SENTINEL" in definition_handler.payload()["definition"]["text"],
                    "Authorized private definition read failed")

            oversized = FakeHandler(body=b"{}")
            oversized.headers["Content-Length"] = str(api.MAX_BODY_BYTES + 1)
            require(api.handle_post_request(oversized, f"{api.BASE_PATH}/save"), "Agent save route was not handled")
            require(oversized.status == 400 and oversized.close_connection,
                    "Oversized Agent Management body was not rejected safely")

    ignored = subprocess.run(
        ["git", "check-ignore", "-q", "data/runtime/agent-management/agents.json"],
        cwd=ROOT,
        check=False,
    )
    require(ignored.returncode == 0, "Live Agent Management store is not covered by gitignore")
    ignored_definition = subprocess.run(
        ["git", "check-ignore", "-q", "data/runtime/agent-management/tlo/AGENT.md"],
        cwd=ROOT, check=False,
    )
    require(ignored_definition.returncode == 0, "Private TLO definition is not covered by gitignore")
    print("AGENT_MANAGEMENT_SMOKE_OK")


if __name__ == "__main__":
    run()
