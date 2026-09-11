"""Canonical EveOS service-port registry shared by Python lifecycle controllers."""

from __future__ import annotations

import json
import os
from functools import lru_cache
from pathlib import Path


class PortRegistryError(RuntimeError):
    pass


def _registry_path() -> Path:
    return Path(__file__).resolve().parent.parent / "config" / "eveos-ports.json"


@lru_cache(maxsize=1)
def _registry() -> dict:
    path = _registry_path()
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as exc:
        raise PortRegistryError(f"Could not load EveOS port registry: {path}: {exc}") from exc
    ports = payload.get("ports")
    if not isinstance(ports, dict) or not ports:
        raise PortRegistryError(f"EveOS port registry has no ports: {path}")
    return payload


def _valid_port(value, *, name: str) -> int:
    try:
        port = int(value)
    except (TypeError, ValueError) as exc:
        raise PortRegistryError(f"Invalid port for {name}: {value!r}") from exc
    if not 1 <= port <= 65535:
        raise PortRegistryError(f"Port for {name} must be between 1 and 65535: {port}")
    return port


def registered_port(env_name: str) -> int:
    entry = _registry()["ports"].get(env_name)
    if not isinstance(entry, dict) or "port" not in entry:
        raise PortRegistryError(f"Unknown EveOS port key: {env_name}")
    return _valid_port(entry.get("port"), name=env_name)


def service_port(env_name: str) -> int:
    """Resolve an effective service port, honoring an explicit environment override."""
    override = str(os.environ.get(env_name, "")).strip()
    if override:
        return _valid_port(override, name=env_name)
    return registered_port(env_name)


def service_label(env_name: str) -> str:
    entry = _registry()["ports"].get(env_name) or {}
    return str(entry.get("service") or env_name)


def registered_ports() -> dict[str, int]:
    return {name: registered_port(name) for name in _registry()["ports"]}


def effective_ports() -> dict[str, int]:
    return {name: service_port(name) for name in _registry()["ports"]}


def bootstrap_environment() -> dict[str, int]:
    """Populate unset service-port environment variables from the canonical registry."""
    values = registered_ports()
    for name, port in values.items():
        os.environ.setdefault(name, str(port))
    return {name: service_port(name) for name in values}


def conflicts(*, effective: bool = True) -> dict[int, list[str]]:
    values = effective_ports() if effective else registered_ports()
    owners: dict[int, list[str]] = {}
    for name, port in values.items():
        owners.setdefault(port, []).append(name)
    return {port: names for port, names in owners.items() if len(names) > 1}


def assert_unique_effective_ports() -> None:
    collisions = conflicts(effective=True)
    if not collisions:
        return
    details = "; ".join(
        f"{port}: {', '.join(service_label(name) for name in names)}"
        for port, names in sorted(collisions.items())
    )
    raise PortRegistryError(f"EveOS service-port collision: {details}")


def owner_for_registered_port(port: int) -> list[str]:
    target = _valid_port(port, name="port lookup")
    return [name for name, candidate in registered_ports().items() if candidate == target]
