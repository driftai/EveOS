"""Shared paths, limits, and errors for TLO qualification helpers."""

from __future__ import annotations

import json
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
ROOT_TEXT = str(ROOT)
if ROOT_TEXT not in sys.path:
    sys.path.insert(0, ROOT_TEXT)

BINDING_PATH = ROOT / "config" / "agents" / "tlo" / "RUNTIME.json"
PACKAGE_PATH = ROOT / "package.json"
TLO_PROFILE_PATH = ROOT / "config" / "agents" / "tlo" / "AGENT.md"
LOCAL_MOE_CONFIG = ROOT / "tools" / "Local-MoE-Harness" / "config"
LOCAL_MOE_SETTINGS_PATH = LOCAL_MOE_CONFIG / "settings.json"
LOCAL_MOE_LOCK_PATH = LOCAL_MOE_CONFIG / "runtime-lock.json"
LOCAL_MOE_MODELS_PATH = LOCAL_MOE_CONFIG / "models.json"
PORTS_PATH = ROOT / "config" / "eveos-ports.json"
SERVER_STATUS_PATH = ROOT / "server_modules" / "eveos_server_status.py"
RESULT_DIR = ROOT / "data" / "runtime" / "smoke-results"
MAX_CAPTURE_CHARS = 160_000
MAX_PROMPT_CHARS = 12_000
TRIAGE_TIMEOUT_SECONDS = 360
MAX_TLO_JSON_ATTEMPTS = 3


class RehearsalError(RuntimeError):
    def __init__(self, message: str, *, state: str = "ERROR"):
        super().__init__(message)
        self.state = state


def load_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RehearsalError(
            f"Could not read JSON: {path}",
            state="CONFIG_INVALID",
        ) from exc
    if not isinstance(payload, dict):
        raise RehearsalError(
            f"Expected JSON object: {path}",
            state="CONFIG_INVALID",
        )
    return payload


def port_value(registry: dict, key: str) -> int:
    try:
        return int(registry["ports"][key]["port"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RehearsalError(
            f"Missing EveOS port registry entry: {key}",
            state="CONFIG_INVALID",
        ) from exc


def eveos_port() -> int:
    return port_value(load_json(PORTS_PATH), "EVEOS_WEB_PORT")
