"""Whether each spawned EveOS service shows a console window.

Kept in its own file on purpose. eveos-web-service.json is rewritten wholesale every time the web
service starts or stops -- it only ever carries desiredRunning/port/updatedAt -- so anything else
stored beside it is silently erased on the next lifecycle change.

Shape:

    {"default": false, "services": {"gemini": true}}

`default` is the answer for a service with no entry of its own; false means headed, because a
console you can see is the point. A per-service entry overrides it, so a chatty backend can be
silenced without hiding everything else. EVEOS_HEADLESS overrides both, for a one-off quiet run.
"""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

# Services that spawn their own process and can therefore own a console. The UI lists these, so a
# service missing here is invisible in settings even if it is running.
KNOWN_SERVICES = ("web", "gemini", "worldBook", "piano", "watchFusion")
_TRUE = {"1", "true", "yes", "on"}


def _path() -> Path:
    return Path(__file__).resolve().parent.parent / "data" / "runtime" / "eveos-consoles.json"


def read_all() -> dict:
    """Stored preferences, normalised. A missing or corrupt file means "all headed"."""
    try:
        payload = json.loads(_path().read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        payload = {}
    services = payload.get("services")
    if not isinstance(services, dict):
        services = {}
    return {
        "default": bool(payload.get("default")),
        "services": {str(k): bool(v) for k, v in services.items() if k in KNOWN_SERVICES},
    }


def headless_for(service: str | None = None) -> bool:
    """Whether `service` should hide its console. Env wins, then per-service, then the default."""
    env = str(os.environ.get("EVEOS_HEADLESS", "")).strip().lower()
    if env:
        return env in _TRUE
    prefs = read_all()
    if service and service in prefs["services"]:
        return prefs["services"][service]
    return prefs["default"]


def set_console(service: str | None, headless: bool) -> dict:
    """Set one service's preference, or the default when `service` is falsy/'default'."""
    prefs = read_all()
    if not service or service == "default":
        prefs["default"] = bool(headless)
    elif service in KNOWN_SERVICES:
        prefs["services"][service] = bool(headless)
    else:
        raise ValueError(f"Unknown service: {service}")

    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = dict(prefs, updatedAt=time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()))
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(path)
    return prefs


def clear(service: str) -> dict:
    """Drop a per-service override so it follows the default again."""
    prefs = read_all()
    prefs["services"].pop(service, None)
    path = _path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(prefs, indent=2), encoding="utf-8")
    temporary.replace(path)
    return prefs
