from __future__ import annotations

from typing import Any


async def full_runtime_status(
    adapter: Any,
    runtime_lifecycle: Any,
    model_switching: Any,
    gpu_coexistence: Any,
    model_registry: Any,
    settings: dict[str, Any],
    system_snapshot: Any,
    context_capacity_tokens: Any,
) -> dict[str, Any]:
    """Assemble the detailed UI status, including intentionally expensive scans."""
    runtime = await adapter.status()
    lifecycle_status = runtime_lifecycle.local_status()
    if runtime.get("ready") and model_switching.snapshot()["status"] != "switching":
        lifecycle_status["startup_stage"] = "ready"
    profile = runtime_lifecycle.active_profile()
    return {
        "harness": "ready",
        "runtime": runtime,
        "runtime_lifecycle": lifecycle_status,
        "system": system_snapshot(settings["model_root"]),
        "gpu_coexistence": gpu_coexistence.snapshot(),
        "model_switch": model_switching.snapshot(),
        "model_registry": model_registry.public_models(
            active_model_id=runtime_lifecycle.active_model_id
        ),
        "settings": {
            "runtime": runtime_lifecycle.active_runtime_backend(),
            "runtime_base_url": settings["runtime_base_url"],
            "model_root": settings["model_root"],
            "runtime_autostart": settings.get("runtime_autostart", True),
            "default_reasoning_effort": runtime_lifecycle.active_record().data.get(
                "default_reasoning_effort"
            ),
            "default_max_tokens": settings.get("default_max_tokens", 1024),
            "conversation_kv_floor_tokens": context_capacity_tokens(),
            "active_model_id": runtime_lifecycle.active_model_id,
            "active_profile": runtime_lifecycle.active_profile_name or "normal",
            "active_profile_label": profile.get("label"),
            "max_prefill_length": profile.get("prefill_tokens"),
            "prefill_hit_d2d": profile.get("d2d"),
            "conversation_context_margin_tokens": settings.get(
                "conversation_context_margin_tokens", 128
            ),
            "conversation_raw_history_max_messages": settings.get(
                "conversation_raw_history_max_messages", 38
            ),
            "conversation_memory_max_items": settings.get(
                "conversation_memory_max_items", 24
            ),
            "conversation_memory_max_chars": settings.get(
                "conversation_memory_max_chars", 2200
            ),
            "gpu_coexistence_enabled": settings.get("gpu_coexistence_enabled", True),
        },
    }


async def lightweight_runtime_status(
    adapter: Any,
    runtime_lifecycle: Any,
    model_switching: Any,
    gpu_coexistence: Any,
) -> dict[str, Any]:
    """Assemble lifecycle state without model-root or system-storage scans."""
    runtime = await adapter.lifecycle_status()
    lifecycle_status = runtime_lifecycle.local_status()
    if runtime.get("ready") and model_switching.snapshot()["status"] != "switching":
        lifecycle_status["startup_stage"] = "ready"
    active_record = runtime_lifecycle.active_record()
    active_profile = runtime_lifecycle.active_profile_name or "normal"
    profile = runtime_lifecycle.active_profile()
    return {
        "harness": "ready",
        "runtime": runtime,
        "runtime_lifecycle": lifecycle_status,
        "active_model": {
            "id": active_record.id,
            "display_name": active_record.data.get("display_name") or active_record.id,
            "validation": active_record.data.get("validation") or "",
        },
        "gpu_coexistence": gpu_coexistence.snapshot(),
        "settings": {
            "active_model_id": active_record.id,
            "active_profile": active_profile,
            "active_profile_label": profile.get("label") or active_profile,
        },
    }
