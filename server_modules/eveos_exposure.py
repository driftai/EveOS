"""Runtime-only exposure metadata for selectively shared EveOS surfaces."""

from __future__ import annotations

import json
import time
from pathlib import Path


_VALID_MODES = {"local", "lan", "cloudflare"}


def _root() -> Path:
    return Path(__file__).resolve().parent.parent


def _directory() -> Path:
    return _root() / "data" / "runtime" / "exposure"


def state_path(service: str) -> Path:
    safe = "".join(ch for ch in str(service or "").lower() if ch.isalnum() or ch in {"-", "_"})
    if not safe:
        raise ValueError("Exposure service key is required.")
    return _directory() / f"{safe}.json"


def read_state(service: str) -> dict:
    try:
        payload = json.loads(state_path(service).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError):
        return {}
    if not isinstance(payload, dict):
        return {}
    mode = str(payload.get("mode") or "local").lower()
    if mode not in _VALID_MODES or payload.get("active") is not True:
        return {}
    return {
        "active": True,
        "mode": mode,
        "publicUrl": str(payload.get("publicUrl") or "").strip(),
        "originUrl": str(payload.get("originUrl") or "").strip(),
        "routerPort": int(payload.get("routerPort") or 0),
        "updatedAt": str(payload.get("updatedAt") or ""),
    }


def clear_state(service: str) -> None:
    try:
        state_path(service).unlink(missing_ok=True)
    except OSError:
        pass


def write_state(service: str, *, mode: str, public_url: str = "", origin_url: str = "",
                router_port: int = 0, active: bool = True) -> dict:
    normalized = str(mode or "local").lower()
    if normalized not in _VALID_MODES:
        raise ValueError(f"Unsupported exposure mode: {mode}")
    if normalized == "local" or not active:
        clear_state(service)
        return {"active": False, "mode": "local"}
    path = state_path(service)
    path.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "active": True,
        "mode": normalized,
        "publicUrl": str(public_url or "").strip(),
        "originUrl": str(origin_url or "").strip(),
        "routerPort": int(router_port or 0),
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(payload, indent=2), encoding="utf-8")
    temporary.replace(path)
    return payload


def decorate_status(payload: dict, service: str, local_url: str) -> dict:
    result = dict(payload)
    exposure = read_state(service)
    result["localUrl"] = local_url
    result["exposureMode"] = exposure.get("mode", "local")
    result["publicUrl"] = exposure.get("publicUrl", "") if result.get("running") else ""
    if result.get("running") and result["publicUrl"]:
        result["url"] = result["publicUrl"]
    else:
        result["url"] = local_url
    return result
