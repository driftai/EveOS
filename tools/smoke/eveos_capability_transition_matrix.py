#!/usr/bin/env python3
"""Synthetic state-space coverage for EveOS lifecycle-backed tools.

This smoke never starts/stops real services. It patches each controller's low-level
sensors and proves the normalized lifecycle states that the real passive status
surface is expected to expose.
"""

from __future__ import annotations

import json
import sys
import tempfile
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import (  # noqa: E402
    bookmark_intel_control,
    eveos_web_control,
    gemini_control,
    local_moe_control,
    nexus_browser_control,
    piano_player_control,
    watchfusion_control,
    watchfusion_exposure,
    world_book_control,
)

EXPECTED = {
    "web": {"stopped", "starting", "blocked", "running"},
    "gemini": {"stopped", "starting", "conflict", "running"},
    "worldBook": {"stopped", "starting", "blocked", "running"},
    "piano": {"stopped", "starting", "blocked", "running", "needsSetup"},
    "watchFusion": {"stopped", "starting", "blocked", "running", "needsSetup"},
    "bookmarkIntel": {"stopped", "starting", "blocked", "running"},
    "localMoe": {"stopped", "starting", "blocked", "running", "needsSetup"},
    "nexusBrowser": {"stopped", "starting", "blocked", "running", "needsSetup"},
}


class FakeProcess:
    def __init__(self, pid=4242):
        self.pid = pid

    def poll(self):
        return None


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def compact(payload):
    keys = (
        "state", "running", "ok", "installed", "owned", "desiredRunning",
        "setupReady", "setupRequired", "dependenciesReady", "runtimeReady",
        "runtimeReachable", "runtimeHealth", "websocketReady", "statusReady",
        "portConflict", "extensionReady", "extensionConnected", "onlineTargets",
        "localTargets", "dexRooms",
    )
    return {key: payload.get(key) for key in keys if key in payload}


def fake_file(root: Path, relative: str) -> Path:
    path = root / relative
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("# smoke fixture\n", encoding="utf-8")
    return path


def exposure_passthrough(payload, *_args, **_kwargs):
    return payload


def web_matrix(root):
    entry = fake_file(root, "web/python-server.py")
    port = eveos_web_control.EVEOS_WEB_PORT

    def one(label, *, health=None, busy=False, process=None):
        with (
            patch.object(eveos_web_control, "_health_payload", return_value=health),
            patch.object(eveos_web_control, "_port_open", return_value=busy),
            patch.object(eveos_web_control, "_entry_point", return_value=entry),
            patch.object(eveos_web_control, "_read_preference", return_value=(False, port)),
            patch.object(eveos_web_control, "_listener_pids", return_value=[111] if health else []),
            patch.object(eveos_web_control, "_PROCESS", process),
            patch.object(eveos_web_control, "_PROCESS_PORT", port if process else None),
        ):
            return compact(eveos_web_control._status(port=port))

    return {
        "stopped": one("stopped"),
        "starting": one("starting", process=FakeProcess()),
        "blocked": one("blocked", busy=True),
        "running": one("running", health={"service": "eveos-local-server"}),
    }


def gemini_matrix():
    ws_port = gemini_control.WEBSOCKET_PORT
    status_port = gemini_control.STATUS_PORT

    def one(*, ws_pids=(), status_pids=(), status_snapshot=None, process=None):
        def listeners(port, fresh=False):
            del fresh
            return list(ws_pids if port == ws_port else status_pids if port == status_port else ())

        with (
            patch.object(gemini_control, "_listener_pids", side_effect=listeners),
            patch.object(gemini_control, "_status_http_snapshot", return_value=status_snapshot),
            patch.object(gemini_control, "_PROCESS", process),
        ):
            return compact(gemini_control._status_payload())

    running_snapshot = {
        "service": gemini_control.SERVICE_NAME,
        "websocketPort": ws_port,
        "statusPort": status_port,
    }
    return {
        "stopped": one(),
        "starting": one(process=FakeProcess(111)),
        "conflict": one(ws_pids=(999,), status_pids=(999,), status_snapshot=None),
        "running": one(ws_pids=(111,), status_pids=(111,), status_snapshot=running_snapshot),
    }


def world_matrix(root):
    entry = fake_file(root, "world/server.py")

    def one(*, health=None, busy=False, process=None):
        with (
            patch.object(world_book_control, "_health_payload", return_value=health),
            patch.object(world_book_control, "_port_open", return_value=busy),
            patch.object(world_book_control, "_entry_point", return_value=entry),
            patch.object(world_book_control, "_read_desired_state", return_value=False),
            patch.object(world_book_control, "_listener_pids", return_value=[222] if health else []),
            patch.object(world_book_control, "_PROCESS", process),
            patch.object(world_book_control.eveos_exposure, "decorate_status", side_effect=exposure_passthrough),
        ):
            return compact(world_book_control._status())

    return {
        "stopped": one(),
        "starting": one(process=FakeProcess()),
        "blocked": one(busy=True),
        "running": one(health={"appVersion": "smoke"}),
    }


def piano_matrix(root):
    entry = fake_file(root, "piano/server.py")

    def one(*, health=None, busy=False, process=None, setup=None):
        setup_state = setup or {"setupAvailable": True, "youtubeSetup": True, "hifiSetup": True}
        with (
            patch.object(piano_player_control, "_health", return_value=health),
            patch.object(piano_player_control, "_port_open", return_value=busy),
            patch.object(piano_player_control, "_entry", return_value=entry),
            patch.object(piano_player_control, "_desired", return_value=False),
            patch.object(piano_player_control, "_setup_state", return_value=setup_state),
            patch.object(piano_player_control, "_pids", return_value=[333] if health else []),
            patch.object(piano_player_control, "_PROCESS", process),
            patch.object(piano_player_control.eveos_exposure, "decorate_status", side_effect=exposure_passthrough),
        ):
            result = piano_player_control._status()
            payload = compact(result)
            payload["setupAvailable"] = result["setupAvailable"]
            payload["youtubeSetup"] = result["youtubeSetup"]
            payload["hifiSetup"] = result["hifiSetup"]
            return payload

    return {
        "stopped": one(),
        "starting": one(process=FakeProcess()),
        "blocked": one(busy=True),
        "needsSetup": one(setup={"setupAvailable": True, "youtubeSetup": False, "hifiSetup": False}),
        "running": one(health={"appVersion": "smoke"}),
    }


def watchfusion_matrix(root):
    entry = fake_file(root, "watchfusion/server.js")
    node = fake_file(root, "bin/node.exe")
    npm = fake_file(root, "bin/npm.cmd")

    def one(*, health=None, busy=False, process=None, deps=True, installed=True, node_ready=True):
        chosen_entry = entry if installed else root / "watchfusion/missing.js"
        with ExitStack() as stack:
            stack.enter_context(patch.object(watchfusion_control, "_health", return_value=health))
            stack.enter_context(patch.object(watchfusion_control, "_port_open", return_value=busy))
            stack.enter_context(patch.object(watchfusion_control, "_entry", return_value=chosen_entry))
            stack.enter_context(patch.object(watchfusion_control, "_node", return_value=node if node_ready else None))
            stack.enter_context(patch.object(watchfusion_control, "_npm", return_value=npm))
            stack.enter_context(patch.object(watchfusion_control, "_deps_ready", return_value=deps))
            stack.enter_context(patch.object(watchfusion_control, "_component_status", return_value={"core": {"installed": deps, "ready": bool(health) if health else None, "liveVerified": bool(health)}}))
            stack.enter_context(patch.object(watchfusion_control, "_pids", return_value=[444] if health else []))
            stack.enter_context(patch.object(watchfusion_control, "_remote_tunnel_url", return_value=""))
            stack.enter_context(patch.object(watchfusion_control, "_PROCESS", process))
            stack.enter_context(patch.object(watchfusion_control.eveos_exposure, "decorate_status", side_effect=exposure_passthrough))
            result = watchfusion_control._status()
        payload = compact(result)
        payload["components"] = result.get("components", {})
        return payload

    return {
        "stopped": one(),
        "starting": one(process=FakeProcess()),
        "blocked": one(busy=True),
        "needsSetup": one(deps=False),
        "running": one(health={"rooms": 2}),
    }


def bookmark_matrix(root):
    entry = fake_file(root, "bookmark/server.py")

    def one(*, health=None, busy=False, process=None):
        with (
            patch.object(bookmark_intel_control, "_health_payload", return_value=health),
            patch.object(bookmark_intel_control, "_port_open", return_value=busy),
            patch.object(bookmark_intel_control, "_entry_point", return_value=entry),
            patch.object(bookmark_intel_control, "_read_desired_state", return_value=False),
            patch.object(bookmark_intel_control, "_listener_pids", return_value=[555] if health else []),
            patch.object(bookmark_intel_control, "_PROCESS", process),
        ):
            return compact(bookmark_intel_control._status())

    return {
        "stopped": one(),
        "starting": one(process=FakeProcess()),
        "blocked": one(busy=True),
        "running": one(health={"appVersion": "smoke"}),
    }


def local_moe_matrix(root):
    tool_root = root / "local-moe"
    fake_file(tool_root, "app/main.py")

    def one(*, health=None, harness_pid=None, harness_busy=False, runtime_busy=False, setup=True, live=None):
        def port_open(port):
            if port == local_moe_control.HARNESS_PORT:
                return harness_busy
            if port == local_moe_control.RUNTIME_PORT:
                return runtime_busy
            return False

        details = live or {
            "runtimeReady": False,
            "runtimeReachable": False,
            "runtimeHealth": "offline",
            "activeModel": {"id": "smoke-model"},
            "activeProfile": "",
            "system": {},
            "gpuCoexistence": {},
        }
        with (
            patch.object(local_moe_control, "_tool_root", return_value=tool_root),
            patch.object(local_moe_control, "_port_open", side_effect=port_open),
            patch.object(local_moe_control, "_managed_runtime_pid", return_value=None),
            patch.object(local_moe_control, "_setup_ready", return_value=setup),
            patch.object(local_moe_control, "_configured_model", return_value={"id": "smoke-model"}),
            patch.object(local_moe_control, "_live_details", return_value=details),
            patch.object(local_moe_control, "_PROCESS", None),
        ):
            return compact(local_moe_control._status(health=health, harness_pid=harness_pid))

    ready = {
        "runtimeReady": True,
        "runtimeReachable": True,
        "runtimeHealth": "ok",
        "activeModel": {"id": "smoke-model"},
        "activeProfile": "balanced",
        "system": {},
        "gpuCoexistence": {},
    }
    return {
        "stopped": one(),
        "starting": one(harness_pid=666),
        "blocked": one(harness_busy=True),
        "needsSetup": one(setup=False),
        "running": one(health={"ok": True}, harness_pid=666, live=ready),
    }


def nexus_matrix(root):
    tool_root = root / "nexus"
    fake_file(tool_root, "server.js")
    entry = fake_file(tool_root, "bridge-supervisor.js")
    node = fake_file(root, "bin/node.exe")
    npm = fake_file(root, "bin/npm.cmd")

    def one(*, health=None, busy=False, pid=None, deps=True, diagnostics=None):
        with (
            patch.object(nexus_browser_control, "_health", return_value=health),
            patch.object(nexus_browser_control, "_http_json", return_value=diagnostics or {}),
            patch.object(nexus_browser_control, "_managed_pid", return_value=pid),
            patch.object(nexus_browser_control, "_port_open", return_value=busy),
            patch.object(nexus_browser_control, "_tool_root", return_value=tool_root),
            patch.object(nexus_browser_control, "_entry", return_value=entry),
            patch.object(nexus_browser_control, "_node", return_value=node),
            patch.object(nexus_browser_control, "_npm", return_value=npm),
            patch.object(nexus_browser_control, "_deps_ready", return_value=deps),
            patch.object(nexus_browser_control, "_extension_ready", return_value=True),
            patch.object(nexus_browser_control, "_listener_pids", return_value=[777] if health else []),
            patch.object(nexus_browser_control, "_PROCESS", None),
        ):
            return compact(nexus_browser_control._status())

    diagnostics = {
        "extensionConnected": True,
        "dexUiConnected": True,
        "onlineTargets": 14,
        "localTargets": 1,
        "dexRooms": 2,
        "extensionSessions": {
            "connected": 2,
            "primaryReady": True,
            "primaryTabs": 14,
            "standby": [{"ready": True, "tabs": 0}],
        },
    }
    return {
        "stopped": one(),
        "starting": one(pid=777),
        "blocked": one(busy=True),
        "needsSetup": one(deps=False),
        "running": one(health={"ok": True}, pid=777, diagnostics=diagnostics),
    }


def validate(matrix):
    require(set(matrix) == set(EXPECTED), f"tool matrix drifted: {sorted(matrix)}")
    for tool, expected_variants in EXPECTED.items():
        actual = set(matrix[tool])
        require(actual == expected_variants,
                f"{tool} state variants drifted: expected={sorted(expected_variants)} actual={sorted(actual)}")
        for label, payload in matrix[tool].items():
            state = payload.get("state")
            require(state in {"stopped", "starting", "blocked", "running", "conflict"},
                    f"{tool}.{label} emitted unknown state {state!r}")
            require(isinstance(payload.get("running"), bool), f"{tool}.{label} running is not boolean")
            require((state == "running") == payload["running"],
                    f"{tool}.{label} state/running disagree: {state}/{payload['running']}")
            if label == "blocked":
                require(payload["ok"] is False, f"{tool}.blocked must fail closed")
            if label == "running":
                require(payload["running"] is True, f"{tool}.running did not report running")
            if label == "needsSetup":
                if tool == "localMoe":
                    require(payload.get("setupReady") is False, "Local MoE needsSetup did not expose setupReady=false")
                elif tool in {"watchFusion", "nexusBrowser"}:
                    require(payload.get("setupRequired") is True, f"{tool} needsSetup did not expose setupRequired=true")
                elif tool == "piano":
                    require(payload.get("youtubeSetup") is False and payload.get("hifiSetup") is False,
                            "Piano needsSetup did not expose missing setup components")


def validate_watchfusion_exposure():
    local_url = "http://127.0.0.1:9087/"
    base = {"exposureMode": "local", "publicUrl": "", "url": local_url}
    lan = watchfusion_exposure.reconcile_status(
        dict(base), local_url=local_url,
        network={"localOnly": False, "canonicalLanHost": "http://192-168-1-209.sslip.io:9087/"},
    )
    require(lan["exposureMode"] == "lan" and "sslip.io" in lan["url"],
            "WatchFusion live LAN exposure did not select its canonical sslip.io host")
    remote = watchfusion_exposure.reconcile_status(
        dict(base), local_url=local_url, remote_url="https://watchfusion.trycloudflare.com/",
    )
    require(remote["exposureMode"] == "cloudflare" and remote["url"].startswith("https://"),
            "WatchFusion remote exposure did not take priority over LAN metadata")


def main():
    with tempfile.TemporaryDirectory(prefix="eveos-state-matrix-") as temp_dir:
        root = Path(temp_dir)
        matrix = {
            "web": web_matrix(root),
            "gemini": gemini_matrix(),
            "worldBook": world_matrix(root),
            "piano": piano_matrix(root),
            "watchFusion": watchfusion_matrix(root),
            "bookmarkIntel": bookmark_matrix(root),
            "localMoe": local_moe_matrix(root),
            "nexusBrowser": nexus_matrix(root),
        }
    validate(matrix)
    validate_watchfusion_exposure()

    result = {
        "tools": matrix,
        "coverage": {
            "lifecycleTools": len(matrix),
            "variants": sum(len(states) for states in matrix.values()),
            "variantLabels": {tool: sorted(states) for tool, states in matrix.items()},
        },
    }
    result_dir = ROOT / "data" / "runtime" / "smoke-results"
    result_dir.mkdir(parents=True, exist_ok=True)
    snapshot = result_dir / "LAST-EVEOS-CAPABILITY-MATRIX.json"
    snapshot.write_text(json.dumps(result, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print("EVEOS_CAPABILITY_TRANSITION_MATRIX_OK " + json.dumps(result["coverage"], sort_keys=True))
    print(f"CAPABILITY_MATRIX_SNAPSHOT {snapshot.relative_to(ROOT).as_posix()}")


if __name__ == "__main__":
    main()
