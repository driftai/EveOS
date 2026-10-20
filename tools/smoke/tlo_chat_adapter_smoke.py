#!/usr/bin/env python3
"""Focused TLO projection, model-policy, streaming, and cancellation smoke."""

from __future__ import annotations

import io
import json
import sys
import tempfile
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import agent_management_store as store  # noqa: E402
from server_modules import tlo_chat, tlo_definition  # noqa: E402


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def profile(agent_id, *, private_note, context, model_id=""):
    return {
        "id": agent_id,
        "displayName": "TLO" if agent_id == "tlo" else "Other Agent",
        "role": "Local test agent",
        "identity": f"IDENTITY_{agent_id.upper()}",
        "workingRules": [f"RULE_{agent_id.upper()}"],
        "providerBinding": {"provider": "local-moe", "modelId": model_id},
        "allowedTools": [f"TOOL_{agent_id.upper()}"],
        "privateNotes": [private_note],
        "permissions": [f"PERMISSION_{agent_id.upper()}"],
        "scopes": [{
            "id": "default", "label": "Default", "instructions": f"INSTRUCTION_{agent_id.upper()}",
            "context": [context], "allowedTools": [f"SCOPE_TOOL_{agent_id.upper()}"],
        }],
    }


def harness_status(*, active="trusted-model", ready=True, reachable=True, switching=False):
    return {
        "runtime": {"ready": ready, "reachable": reachable},
        "model_switch": {"status": "switching" if switching else "idle"},
        "settings": {"active_model_id": active},
        "model_registry": [
            {"id": "trusted-model", "display_name": "Trusted Model"},
            {"id": "alternate-model", "display_name": "Alternate Model"},
        ],
    }


def lifecycle(*, running=True, state="running"):
    return {
        "running": running, "state": state, "owned": True, "runtimeReady": running,
        "message": "Local MoE Harness is online." if running else "Local MoE Harness is stopped.",
        "activeModel": {"id": "trusted-model", "label": "Trusted Model"},
    }


class FakeSocket:
    def settimeout(self, _timeout):
        return None


class FakeResponse:
    status = 200

    def __init__(self):
        self.chunks = [
            b'data: {"harness_context":{"prompt_tokens":12}}\n\n',
            b'data: {"choices":[{"delta":{"content":"Hel"}}]}\n\n',
            b'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n',
            b'data: [DONE]\n\n',
        ]

    def read1(self, _size):
        return self.chunks.pop(0) if self.chunks else b""


class FakeConnection:
    instances = []

    def __init__(self, *_args, **_kwargs):
        self.sock = FakeSocket()
        self.timeout = _kwargs.get("timeout")
        self.closed = False
        self.method = self.path = None
        self.body = b""
        self.headers = {}
        self.response = FakeResponse()
        self.__class__.instances.append(self)

    def request(self, method, path, body=None, headers=None):
        self.method, self.path = method, path
        self.body, self.headers = body or b"", headers or {}

    def getresponse(self):
        return self.response

    def close(self):
        self.closed = True


class FakeHandler:
    def __init__(self, payload=None, *, origin="http://127.0.0.1:8765", host="127.0.0.1"):
        body = json.dumps(payload).encode("utf-8") if payload is not None else b""
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


def expect_model_error(projection, harness, expected_state):
    try:
        tlo_chat._model_policy(projection, harness)
        raise AssertionError(f"Expected model policy state {expected_state}")
    except tlo_chat.TloChatError as exc:
        require(exc.state == expected_state, f"Expected {expected_state}, got {exc.state}")


def run():
    with tempfile.TemporaryDirectory(prefix="eveos-tlo-chat-") as temporary:
        live_path = Path(temporary) / "agents.json"
        backup_path = Path(temporary) / "agents.backup.json"
        definition_path = Path(temporary) / "tlo" / "AGENT.md"
        definition_path.parent.mkdir(parents=True)
        definition_path.write_text("# TLO\nIDENTITY_TLO\nRULE_TLO\n", encoding="utf-8")
        with patch.object(store, "STORE_PATH", live_path), patch.object(store, "BACKUP_PATH", backup_path), \
                patch.object(tlo_definition, "LIVE_PATH", definition_path):
            store.save_agent(profile("tlo", private_note="TLO_PRIVATE_SENTINEL", context="TLO_SCOPE_SENTINEL"))
            store.save_agent(profile("other-agent", private_note="OTHER_PRIVATE_SENTINEL", context="OTHER_SCOPE_SENTINEL"))
            projection = store.scoped_projection("tlo", "default")
            prompt = tlo_chat.build_system_prompt(projection)
            for required in ["IDENTITY_TLO", "RULE_TLO", "INSTRUCTION_TLO", "TLO_SCOPE_SENTINEL", "TOOL_TLO"]:
                require(required in prompt, f"TLO model context omitted {required}")
            for forbidden in ["TLO_PRIVATE_SENTINEL", "OTHER_PRIVATE_SENTINEL", "OTHER_SCOPE_SENTINEL", "PERMISSION_TLO"]:
                require(forbidden not in prompt, f"TLO model context leaked {forbidden}")

            selected, active, _registry = tlo_chat._model_policy(projection, harness_status())
            require(selected is None and active == "trusted-model", "Empty modelId did not use Harness selection")
            untrusted = {**projection, "agent": {**projection["agent"], "providerBinding": {
                "provider": "local-moe", "modelId": "C:/arbitrary/model"
            }}}
            expect_model_error(untrusted, harness_status(), "model_untrusted")
            alternate = {**projection, "agent": {**projection["agent"], "providerBinding": {
                "provider": "local-moe", "modelId": "alternate-model"
            }}}
            expect_model_error(alternate, harness_status(), "model_mismatch")

            with patch.object(tlo_chat.local_moe_control, "get_status", return_value=lifecycle(running=False, state="stopped")), \
                    patch.object(tlo_chat.local_moe_control, "start_server") as start, \
                    patch.object(tlo_chat, "_harness_json") as read_harness:
                stopped = tlo_chat.status_payload("default")
                require(stopped["state"] == "stopped" and not stopped["canChat"], "Stopped state is not usable")
                start.assert_not_called()
                read_harness.assert_not_called()

            with patch.object(tlo_chat.local_moe_control, "get_status", return_value=lifecycle()), \
                    patch.object(tlo_chat, "_harness_json", return_value=harness_status()):
                file_status = FakeHandler(origin="null")
                require(
                    tlo_chat.handle_get_request(file_status, f"{tlo_chat.BASE_PATH}/status", {"scopeId": ["default"]}),
                    "File-origin TLO status route was not handled"
                )
                require(
                    file_status.status == 200 and json.loads(file_status.wfile.getvalue())["canChat"] is True,
                    "Supported file-origin EveOS page could not read TLO readiness"
                )
                remote_status = FakeHandler(origin="https://example.invalid")
                require(
                    tlo_chat.handle_get_request(remote_status, f"{tlo_chat.BASE_PATH}/status", {"scopeId": ["default"]}),
                    "Remote-origin TLO status route was not handled"
                )
                require(remote_status.status == 403, "Remote web origin could read TLO status")

            with patch.object(tlo_chat.local_moe_control, "get_status", return_value=lifecycle()), \
                    patch.object(tlo_chat, "_harness_json", return_value=harness_status()), \
                    patch.object(tlo_chat.http.client, "HTTPConnection", FakeConnection):
                FakeConnection.instances.clear()
                handler = FakeHandler({
                    "requestId": "tlo-stream-test-0001", "scopeId": "default", "message": "Say hello",
                    "history": [{"role": "user", "content": "Earlier question"},
                                {"role": "assistant", "content": "Earlier answer"}],
                })
                claimed = tlo_chat.handle_post_request(handler, f"{tlo_chat.BASE_PATH}/chat/stream")
                require(claimed and handler.status == 200, "Running Harness did not accept a TLO message")
                require(len(FakeConnection.instances) == 1, "One TLO turn dispatched more than one Harness request")
                upstream = FakeConnection.instances[0]
                require(upstream.timeout >= 120, "TLO stream timeout cannot cover real local-model prefill")
                require(upstream.path == "/api/chat/stream", "TLO bypassed the Harness streaming endpoint")
                model_payload = json.loads(upstream.body.decode("utf-8"))
                require("model" not in model_payload, "Empty modelId overrode current Harness selection")
                require(model_payload["system"] == prompt, "TLO scoped projection was not the exact system context")
                capability_header = json.loads(handler.response_headers["X-EveOS-Capability-Context"])
                require(capability_header["schema"] == "eveos.agent-capability-context.v1"
                        and capability_header["packs"] == [] and len(capability_header["digest"]) == 64,
                        "TLO stream omitted its bounded capability-context receipt")
                streamed = handler.wfile.getvalue().decode("utf-8")
                require(streamed.index('"Hel"') < streamed.index('"lo"'), "Streaming text order changed")
                require(streamed.count("data: [DONE]") == 1, "TLO stream did not finalize exactly once")

            active_connection = FakeConnection()
            active_stream = tlo_chat.ActiveStream(connection=active_connection)
            with tlo_chat._ACTIVE_LOCK:
                tlo_chat._ACTIVE["tlo-cancel-test-0001"] = active_stream
            cancel_handler = FakeHandler({"requestId": "tlo-cancel-test-0001"})
            tlo_chat.handle_post_request(cancel_handler, f"{tlo_chat.BASE_PATH}/chat/cancel")
            require(cancel_handler.status == 200 and active_stream.cancelled.is_set() and active_connection.closed,
                    "Cancel did not terminate the active TLO upstream stream")
            with tlo_chat._ACTIVE_LOCK:
                tlo_chat._ACTIVE.pop("tlo-cancel-test-0001", None)

    server_source = (ROOT / "server_modules" / "tlo_chat.py").read_text(encoding="utf-8")
    ui_source = (ROOT / "js" / "modules" / "gemini" / "search_monitor" / "tloChat.js").read_text(encoding="utf-8")
    require("start_server(" not in server_source and "/api/local-moe/start" not in ui_source,
            "Opening or chatting with TLO can auto-start Local MoE")
    require("localStorage" not in ui_source and "sessionStorage" not in ui_source,
            "TLO transcript escaped its private in-memory ownership boundary")
    print("TLO_CHAT_ADAPTER_SMOKE_OK")


if __name__ == "__main__":
    run()
