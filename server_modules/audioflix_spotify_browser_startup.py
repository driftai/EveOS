"""Shared startup budget and diagnostics for the managed Spotify browser helper."""
from __future__ import annotations

import json
from pathlib import Path

_CONTRACT_PATH = Path(__file__).with_name("audioflix_spotify_browser_startup.json")
_DEFAULTS = {
    "edgeLaunchTimeoutMs": 45000,
    "chromiumLaunchTimeoutMs": 45000,
    "navigationTimeoutMs": 30000,
    "outerGraceMs": 15000,
}


def load_startup_contract() -> dict:
    try:
        raw = json.loads(_CONTRACT_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        raw = {}
    contract = {}
    for key, fallback in _DEFAULTS.items():
        try:
            contract[key] = max(1000, int(raw.get(key, fallback)))
        except (TypeError, ValueError):
            contract[key] = fallback
    return contract


STARTUP_CONTRACT = load_startup_contract()
START_TIMEOUT_S = sum(STARTUP_CONTRACT.values()) / 1000.0


def startup_log_reason(log_path: Path, fallback: str) -> str:
    try:
        lines = [line.strip() for line in log_path.read_text(
            encoding="utf-8", errors="replace"
        ).splitlines()[-120:] if line.strip()]
    except OSError:
        lines = []
    if not lines:
        return fallback
    error_markers = ("Error:", "browserType.launch", "Target page, context or browser")
    for line in reversed(lines):
        if line.startswith("at ") or line.startswith("at async "):
            continue
        if any(marker in line for marker in error_markers):
            return line[:500]
    for line in reversed(lines):
        if "startup-phase" in line or "launch-error" in line:
            return f"{fallback} Last helper event: {line[:360]}"
    return fallback
