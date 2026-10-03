"""Small concurrent cache for TLO's stable OpenAPI schema."""

from __future__ import annotations

import threading
from collections.abc import Callable


SCHEMA_CACHE_LOCK = threading.RLock()
SCHEMA_CACHE: dict[tuple[str, str, str], dict] = {}
SCHEMA_INFLIGHT: dict[tuple[str, str, str], threading.Event] = {}
SCHEMA_PATH = "/openapi.json"


def harness_json(path: str, *, fetch: Callable, host: str, port: int, timeout=4.5) -> dict | None:
    """Fetch live runtime JSON and dedupe only stable schema discovery."""
    if path != SCHEMA_PATH:
        return fetch(path, timeout=timeout)

    key = ("local-moe", f"http://{host}:{port}", path)
    with SCHEMA_CACHE_LOCK:
        cached = SCHEMA_CACHE.get(key)
        if cached is not None:
            return cached
        waiter = SCHEMA_INFLIGHT.get(key)
        owner = waiter is None
        if owner:
            waiter = threading.Event()
            SCHEMA_INFLIGHT[key] = waiter

    if not owner:
        waiter.wait(timeout=max(0.1, float(timeout)) + 0.5)
        with SCHEMA_CACHE_LOCK:
            return SCHEMA_CACHE.get(key)

    payload = None
    try:
        payload = fetch(path, timeout=timeout)
        return payload
    finally:
        with SCHEMA_CACHE_LOCK:
            if payload is not None:
                SCHEMA_CACHE[key] = payload
            current = SCHEMA_INFLIGHT.pop(key, None)
            if current is not None:
                current.set()
