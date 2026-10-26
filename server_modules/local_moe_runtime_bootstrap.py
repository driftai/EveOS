"""Pure helpers for Local MoE status and explicit model-runtime bootstrap."""

from __future__ import annotations

from collections.abc import Callable
import time


class StatusGraceCache:
    """Keep a verified Harness session stable across a brief health timeout."""

    def __init__(self, grace_seconds: float) -> None:
        self.grace_seconds = grace_seconds
        self._payload: dict | None = None
        self._healthy_at = 0.0

    def remember(self, payload: dict) -> dict:
        self._payload = dict(payload)
        self._healthy_at = time.monotonic()
        return payload

    def recover(self, port_open: bool) -> dict | None:
        if (
            not port_open
            or self._payload is None
            or time.monotonic() - self._healthy_at >= self.grace_seconds
        ):
            return None
        return {
            **self._payload,
            "statusStale": True,
            "message": "Local MoE Harness is online and temporarily resynchronizing.",
        }

    def clear(self) -> None:
        self._payload = None
        self._healthy_at = 0.0


def live_details(http_json: Callable, harness_port: int) -> dict:
    # The full Harness status includes storage metrics and availability checks for
    # every registered model. Some model roots live behind WSL UNC paths, so that
    # endpoint can take tens of seconds during a cold boot and block the Harness's
    # single event loop. Lifecycle callers need only the lightweight runtime view.
    payload = http_json(harness_port, "/api/runtime/status", timeout=4.5) or {}
    runtime = payload.get("runtime") if isinstance(payload.get("runtime"), dict) else {}
    lifecycle = (
        payload.get("runtime_lifecycle")
        if isinstance(payload.get("runtime_lifecycle"), dict)
        else {}
    )
    settings = payload.get("settings") if isinstance(payload.get("settings"), dict) else {}
    active_id = str(settings.get("active_model_id") or "")
    active_model = (
        payload.get("active_model")
        if isinstance(payload.get("active_model"), dict)
        else next(
            (
                item
                for item in payload.get("model_registry") or []
                if isinstance(item, dict) and item.get("id") == active_id
            ),
            {},
        )
    )
    return {
        "runtimeReady": runtime.get("ready") is True,
        "runtimeReachable": runtime.get("reachable") is True,
        "runtimeHealth": str(runtime.get("health_status") or "unknown"),
        "runtimeManagedRunning": lifecycle.get("managed_running") is True,
        "runtimeStartupStage": str(lifecycle.get("startup_stage") or ""),
        "runtimeLastError": str(lifecycle.get("last_error") or ""),
        "activeModel": {
            "id": active_id,
            "label": str(active_model.get("display_name") or active_model.get("id") or active_id),
            "validation": str(active_model.get("validation") or ""),
        },
        "activeProfile": str(settings.get("active_profile_label") or settings.get("active_profile") or ""),
        "system": payload.get("system") if isinstance(payload.get("system"), dict) else {},
        "gpuCoexistence": (
            payload.get("gpu_coexistence") if isinstance(payload.get("gpu_coexistence"), dict) else {}
        ),
    }


def start_runtime_for_explicit_request(
    status: dict,
    *,
    http_json: Callable,
    harness_port: int,
    refresh_status: Callable[[], dict],
) -> dict:
    should_start = (
        status.get("running") is True
        and status.get("runtimeReady") is not True
        and status.get("runtimeManagedRunning") is not True
        and status.get("runtimeReachable") is not True
    )
    if not should_start:
        return status

    accepted = http_json(
        harness_port,
        "/api/runtime/start",
        method="POST",
        timeout=30.0,
    )
    refreshed = refresh_status()
    if accepted is None:
        return {
            **refreshed,
            "runtimeStartAccepted": False,
            "message": (
                "Local MoE Harness is online, but model startup could not be confirmed. "
                "Use Start model to retry."
            ),
        }
    return {
        **refreshed,
        "runtimeStartAccepted": True,
        "message": (
            "Local MoE Harness is online; selected model startup was requested."
            if refreshed.get("runtimeReady") is not True
            else "Local MoE Harness and selected model are ready."
        ),
    }
