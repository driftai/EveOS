#!/usr/bin/env python3
"""Focused regression for TLO OpenAPI schema cache and in-flight dedupe."""

from __future__ import annotations

import sys
import threading
import time
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import tlo_chat  # noqa: E402


def require(condition, message):
    if not condition:
        raise AssertionError(message)


def clear_schema_state():
    with tlo_chat._SCHEMA_CACHE_LOCK:
        tlo_chat._SCHEMA_CACHE.clear()
        tlo_chat._SCHEMA_INFLIGHT.clear()


def run():
    clear_schema_state()
    calls = []

    def fake_fetch(path, *, timeout=4.5):
        calls.append(path)
        return {"path": path, "ok": True}

    with patch.object(tlo_chat, "_fetch_harness_json", side_effect=fake_fetch):
        for _ in range(6):
            status = tlo_chat._harness_json("/api/status")
            require(status == {"path": "/api/status", "ok": True}, "status fetch changed")
        require(calls.count("/api/status") == 6, "/api/status must remain live and uncached")
        require(calls.count(tlo_chat._SCHEMA_PATH) == 0, "status polling unexpectedly fetched OpenAPI")

        first = tlo_chat._harness_json(tlo_chat._SCHEMA_PATH)
        second = tlo_chat._harness_json(tlo_chat._SCHEMA_PATH)
        require(first == second, "cached schema changed between reads")
        require(calls.count(tlo_chat._SCHEMA_PATH) == 1, "serial schema reads bypassed cache")

    clear_schema_state()
    concurrent_calls = []
    release = threading.Event()

    def slow_fetch(path, *, timeout=4.5):
        concurrent_calls.append(path)
        release.wait(timeout=1.0)
        return {"openapi": "3.1.0"}

    results = []
    with patch.object(tlo_chat, "_fetch_harness_json", side_effect=slow_fetch):
        threads = [threading.Thread(
            target=lambda: results.append(tlo_chat._harness_json(tlo_chat._SCHEMA_PATH, timeout=1.0))
        ) for _ in range(8)]
        for thread in threads:
            thread.start()
        deadline = time.time() + 1.0
        while not concurrent_calls and time.time() < deadline:
            time.sleep(0.005)
        release.set()
        for thread in threads:
            thread.join(timeout=2.0)

    require(len(results) == 8, "not all concurrent schema callers completed")
    require(concurrent_calls.count(tlo_chat._SCHEMA_PATH) == 1,
            "concurrent schema cache misses produced duplicate /openapi.json requests")
    require(all(item == {"openapi": "3.1.0"} for item in results),
            "schema waiters did not receive the shared cached result")

    clear_schema_state()
    failures = []

    def failing_fetch(path, *, timeout=4.5):
        failures.append(path)
        return None

    with patch.object(tlo_chat, "_fetch_harness_json", side_effect=failing_fetch):
        require(tlo_chat._harness_json(tlo_chat._SCHEMA_PATH) is None, "failed schema fetch changed semantics")
        require(tlo_chat._harness_json(tlo_chat._SCHEMA_PATH) is None, "failed schema fetch changed semantics")
    require(failures.count(tlo_chat._SCHEMA_PATH) == 2,
            "failed schema result poisoned the cache instead of allowing retry")

    clear_schema_state()
    print("TLO_SCHEMA_CACHE_SMOKE_OK")


if __name__ == "__main__":
    run()
