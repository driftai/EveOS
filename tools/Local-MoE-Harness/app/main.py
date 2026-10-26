from __future__ import annotations

import ipaddress
import json
import time
from contextlib import asynccontextmanager
from typing import Literal

import httpx
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field

from .adapters.freetoken import FreeTokenAdapter
from .config import ROOT, load_settings
from .services.benchmark import BenchmarkStore, summarize_completion
from .services.conversation_memory import (
    ConversationMemoryStore,
    compact_evicted_messages,
    memory_system_prompt,
    merge_memory,
)
from .services.gpu_coexistence import GpuCoexistenceManager
from .services.model_registry import ModelRegistry, ModelRegistryError
from .services.model_switching import ModelSwitchCoordinator, ModelSwitchError
from .services.runtime_lifecycle import RuntimeLifecycle
from .services.runtime_status import full_runtime_status, lightweight_runtime_status
from .services.system_metrics import system_snapshot

settings = load_settings()
model_registry = ModelRegistry(ROOT)
runtime_lifecycle = RuntimeLifecycle(
    ROOT,
    settings["runtime_base_url"],
    settings.get("runtime_model"),
    settings=settings,
    registry=model_registry,
)
adapter = FreeTokenAdapter(
    settings["runtime_base_url"],
    settings.get("request_timeout_seconds", 300),
    runtime_provider=runtime_lifecycle.active_runtime_backend,
)
gpu_coexistence = GpuCoexistenceManager(
    adapter, settings, runtime_lifecycle=runtime_lifecycle
)
conversation_memory = ConversationMemoryStore(
    max_items=settings.get("conversation_memory_max_items", 24),
    max_chars=settings.get("conversation_memory_max_chars", 2200),
    max_sessions=settings.get("conversation_memory_max_sessions", 16),
)
benchmarks = BenchmarkStore(ROOT / "data" / "benchmarks")
model_switching = ModelSwitchCoordinator(
    model_registry,
    runtime_lifecycle,
    adapter,
    gpu_coexistence,
    conversation_memory,
)

CONVERSATION_COOKIE = "local_moe_conversation_id"


def configure_gpu_for_active_model() -> None:
    model_id = runtime_lifecycle.active_model_id or model_registry.selected_model_id()
    gpu_coexistence.configure_runtime_profile(
        model_registry.profile(model_id, "normal"),
        model_registry.profile(model_id, "busy"),
        active_profile_name=runtime_lifecycle.active_profile_name or "normal",
    )


@asynccontextmanager
async def lifespan(_: FastAPI):
    if settings.get("runtime_autostart", True):
        await runtime_lifecycle.ensure_started()
    configure_gpu_for_active_model()
    await gpu_coexistence.start()
    try:
        yield
    finally:
        await gpu_coexistence.stop()


app = FastAPI(title="Local MoE Harness", version="0.5.0", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=ROOT / "web"), name="static")


class ChatMessage(BaseModel):
    role: Literal["user", "assistant"]
    content: str = Field(min_length=1)


class ChatRequest(BaseModel):
    message: str = Field(min_length=1)
    model: str | None = None
    system: str | None = "You are a helpful local AI assistant."
    history: list[ChatMessage] = Field(default_factory=list, max_length=40)
    temperature: float | None = None
    max_tokens: int | None = None
    # Omitted means use the selected registry model's validated default.
    reasoning_effort: str | None = None


class ModelSelectionRequest(BaseModel):
    model_id: str = Field(min_length=1, max_length=80)


class ModelLocationRequest(BaseModel):
    model_id: str = Field(min_length=1, max_length=80)
    path: str | None = Field(default=None, max_length=4096)


def _request_is_loopback(request: Request) -> bool:
    host = request.client.host if request.client else ""
    if host.lower() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _conversation_session(request: Request) -> tuple[str, bool]:
    return conversation_memory.resolve_session_id(request.cookies.get(CONVERSATION_COOKIE))


def _set_conversation_cookie(response: Response, session_id: str) -> None:
    response.set_cookie(
        CONVERSATION_COOKIE,
        session_id,
        max_age=7 * 24 * 60 * 60,
        httponly=True,
        samesite="lax",
    )


async def require_ready_runtime() -> dict:
    if gpu_coexistence.model_switching:
        raise HTTPException(
            status_code=409,
            detail={
                "message": "A model switch is in progress; generation is temporarily disabled.",
                "switch": model_switching.snapshot(),
            },
        )
    runtime = await adapter.status()
    if runtime.get("ready"):
        return runtime

    if not runtime.get("reachable") and settings.get("runtime_autostart", True):
        await runtime_lifecycle.ensure_started()
        runtime = await adapter.status()

    if runtime.get("ready"):
        return runtime

    phase = runtime.get("phase") or runtime.get("health_status") or "offline"
    raise HTTPException(
        status_code=503,
        detail={
            "message": f"Local model runtime is not ready yet ({phase}).",
            "runtime": runtime,
            "lifecycle": runtime_lifecycle.local_status(),
        },
    )


def choose_model(req_model: str | None, runtime: dict) -> str:
    models = runtime.get("models") or []
    model = models[0].get("id") if models else None
    if not model:
        raise HTTPException(
            status_code=409,
            detail="The local runtime is ready but did not report a served model.",
        )
    if req_model:
        active_id = runtime_lifecycle.active_model_id or model_registry.selected_model_id()
        allowed = {model, active_id}
        try:
            active_record = runtime_lifecycle.active_record()
            if active_record:
                allowed.add(active_record.id)
                if active_record.hf_repo:
                    allowed.add(active_record.hf_repo)
        except Exception:
            pass
        if req_model not in allowed:
            raise HTTPException(
                status_code=409,
                detail=(
                    "The requested model is not the active local model. "
                    "Select it through /api/models/select before generation."
                ),
            )
    return model


def context_capacity_tokens() -> int:
    """Conservative capacity from the active model-specific runtime profile."""
    return runtime_lifecycle.context_capacity_tokens()


def _rough_prompt_tokens(system: str | None, messages: list[dict]) -> int:
    """Conservative fallback only if FreeToken's exact count endpoint is unavailable."""
    chars = len(system or "") + sum(
        len(str(message.get("content", ""))) for message in messages
    )
    return max(1, (chars + 2) // 3) + (10 * len(messages)) + 16


def _drop_oldest_turn(history: list[dict]) -> tuple[list[dict], list[dict]]:
    if not history:
        return history, []
    if (
        len(history) >= 2
        and history[0].get("role") == "user"
        and history[1].get("role") == "assistant"
    ):
        return history[2:], history[:2]
    return history[1:], history[:1]


def make_payload(
    req: ChatRequest,
    model: str,
    history: list[dict] | None = None,
    *,
    system_prompt: str | None = None,
) -> dict:
    messages = []
    effective_system = req.system if system_prompt is None else system_prompt
    if effective_system:
        messages.append({"role": "system", "content": effective_system})
    if history is None:
        messages.extend(message.model_dump() for message in req.history)
    else:
        messages.extend(history)
    messages.append({"role": "user", "content": req.message})
    payload = {
        "model": model,
        "messages": messages,
        "temperature": (
            req.temperature
            if req.temperature is not None
            else settings["default_temperature"]
        ),
        "max_tokens": (
            req.max_tokens
            if req.max_tokens is not None
            else settings["default_max_tokens"]
        ),
    }
    reasoning_effort = req.reasoning_effort
    if reasoning_effort is None:
        reasoning_effort = runtime_lifecycle.active_record().data.get(
            "default_reasoning_effort"
        )
    if reasoning_effort:
        payload["reasoning_effort"] = reasoning_effort
    return payload


async def prepare_chat_payload(
    req: ChatRequest,
    model: str,
    *,
    session_id: str | None = None,
) -> tuple[dict, dict]:
    """Fit chat into reserved KV while retaining compact memory of evicted turns.

    Exact FreeToken token counting remains authoritative. Old complete raw turns
    are compacted deterministically into a small in-process memory block before
    they are removed. If context becomes extremely tight, oldest memory entries
    are pruned before the current user message is ever rejected.
    """
    history = [message.model_dump() for message in req.history]
    memory = conversation_memory.get(session_id) if session_id else []

    requested_max_tokens = (
        req.max_tokens if req.max_tokens is not None else settings["default_max_tokens"]
    )
    capacity = context_capacity_tokens()
    margin = max(64, int(settings.get("conversation_context_margin_tokens", 128)))
    prompt_budget = capacity - int(requested_max_tokens) - margin
    if prompt_budget < 128:
        raise HTTPException(
            status_code=413,
            detail={
                "message": (
                    "Requested generation budget leaves too little room for the prompt. "
                    "Lower max_tokens or increase LOCAL_MOE_KV_RESERVE_TOKENS."
                ),
                "context_capacity_tokens": capacity,
                "requested_max_tokens": requested_max_tokens,
            },
        )

    memory_max_items = max(1, int(settings.get("conversation_memory_max_items", 24)))
    memory_max_chars = max(256, int(settings.get("conversation_memory_max_chars", 2200)))
    user_excerpt_chars = max(
        32, int(settings.get("conversation_memory_user_excerpt_chars", 220))
    )
    assistant_excerpt_chars = max(
        32, int(settings.get("conversation_memory_assistant_excerpt_chars", 180))
    )
    raw_history_max = max(
        2, min(40, int(settings.get("conversation_raw_history_max_messages", 38)))
    )

    trimmed_messages = 0
    memory_added_items = 0
    memory_pruned_items = 0

    def remember_removed(removed: list[dict]) -> None:
        nonlocal memory, memory_added_items, memory_pruned_items
        if not removed:
            return
        additions = compact_evicted_messages(
            removed,
            user_excerpt_chars=user_excerpt_chars,
            assistant_excerpt_chars=assistant_excerpt_chars,
        )
        memory_added_items += len(additions)
        memory, dropped = merge_memory(
            memory,
            additions,
            max_items=memory_max_items,
            max_chars=memory_max_chars,
        )
        memory_pruned_items += dropped
        if session_id:
            memory_pruned_items += conversation_memory.set(session_id, memory)

    # The browser keeps at most 40 raw messages. Compact a complete oldest turn
    # before it would be silently lost by the next client-side history rollover.
    while len(history) > raw_history_max:
        history, removed = _drop_oldest_turn(history)
        trimmed_messages += len(removed)
        remember_removed(removed)

    count_source = "runtime_count_tokens"
    runtime_counter_available = True

    while True:
        effective_system = memory_system_prompt(req.system, memory)
        count_messages = [*history, {"role": "user", "content": req.message}]
        if runtime_counter_available:
            try:
                prompt_tokens = await adapter.count_tokens(
                    model,
                    count_messages,
                    effective_system,
                )
            except Exception:
                runtime_counter_available = False
                count_source = "conservative_estimate"
                prompt_tokens = _rough_prompt_tokens(effective_system, count_messages)
        else:
            prompt_tokens = _rough_prompt_tokens(effective_system, count_messages)

        if prompt_tokens <= prompt_budget:
            break

        history, removed = _drop_oldest_turn(history)
        if removed:
            trimmed_messages += len(removed)
            remember_removed(removed)
            continue

        if memory:
            memory = memory[1:]
            memory_pruned_items += 1
            if session_id:
                memory_pruned_items += conversation_memory.set(session_id, memory)
            continue

        raise HTTPException(
            status_code=413,
            detail={
                "message": (
                    f"The current message needs about {prompt_tokens} prompt tokens, "
                    f"but this local session reserves {prompt_budget} for the prompt. "
                    "Shorten this message or start with a larger KV reserve."
                ),
                "prompt_tokens": prompt_tokens,
                "prompt_budget_tokens": prompt_budget,
                "context_capacity_tokens": capacity,
                "requested_max_tokens": requested_max_tokens,
            },
        )

    if session_id:
        memory_pruned_items += conversation_memory.set(session_id, memory)

    effective_system = memory_system_prompt(req.system, memory)
    payload = make_payload(
        req,
        model,
        history,
        system_prompt=effective_system,
    )
    context = {
        "prompt_tokens": prompt_tokens,
        "prompt_budget_tokens": prompt_budget,
        "context_capacity_tokens": capacity,
        "requested_max_tokens": requested_max_tokens,
        "trimmed_history_messages": trimmed_messages,
        "trimmed_history_turns": (trimmed_messages + 1) // 2,
        "count_source": count_source,
        "conversation_memory": list(memory),
        "conversation_memory_items": len(memory),
        "conversation_memory_chars": sum(len(item) + 2 for item in memory),
        "conversation_memory_added_items": memory_added_items,
        "conversation_memory_pruned_items": memory_pruned_items,
    }
    return payload, context


@app.get("/")
async def index():
    return FileResponse(ROOT / "web" / "index.html")


@app.get("/api/status")
async def api_status():
    return await full_runtime_status(
        adapter, runtime_lifecycle, model_switching, gpu_coexistence,
        model_registry, settings, system_snapshot, context_capacity_tokens,
    )


@app.get("/api/runtime/status")
async def api_runtime_status():
    """Return lifecycle state without model-root or system-storage scans."""
    return await lightweight_runtime_status(
        adapter, runtime_lifecycle, model_switching, gpu_coexistence
    )


@app.post("/api/runtime/start")
async def api_runtime_start():
    lifecycle = await runtime_lifecycle.ensure_started()
    configure_gpu_for_active_model()
    runtime = await adapter.lifecycle_status()
    return {
        "lifecycle": lifecycle,
        "runtime": runtime,
        "gpu_coexistence": gpu_coexistence.snapshot(),
    }


@app.post("/api/runtime/stop")
async def api_runtime_stop(request: Request):
    if not _request_is_loopback(request):
        raise HTTPException(
            status_code=403,
            detail="The local model runtime can only be stopped from the Harness machine.",
        )
    if model_switching.snapshot()["status"] == "switching":
        raise HTTPException(status_code=409, detail="A model switch is currently in progress.")
    await runtime_lifecycle.stop_managed()
    runtime_lifecycle.active_model_id = None
    runtime_lifecycle.active_profile_name = None
    return {
        "stopped": True,
        "lifecycle": runtime_lifecycle.local_status(),
    }


@app.get("/api/models")
async def api_models(request: Request):
    local_admin = _request_is_loopback(request)
    try:
        runtime_models = await adapter.models()
    except Exception:
        runtime_models = []
    return {
        "data": runtime_models,
        "registry": model_registry.public_models(
            active_model_id=runtime_lifecycle.active_model_id,
            include_paths=local_admin,
        ),
        "switch": model_switching.snapshot(),
        "location_editable": local_admin,
    }


@app.post("/api/models/location")
async def api_model_location(req: ModelLocationRequest, request: Request):
    if not _request_is_loopback(request):
        raise HTTPException(
            status_code=403,
            detail="Model filesystem locations can only be changed from the local machine.",
        )

    lifecycle = runtime_lifecycle.local_status()
    if (
        runtime_lifecycle.active_model_id == req.model_id
        and lifecycle.get("managed_running")
    ):
        raise HTTPException(
            status_code=409,
            detail=(
                "Stop the active local runtime before changing this model's filesystem "
                "location. The path can be changed once its files are no longer in use."
            ),
        )

    try:
        if req.path is None or not req.path.strip():
            model_registry.reset_model_location(req.model_id)
            action = "reset"
        else:
            model_registry.set_model_location(req.model_id, req.path)
            action = "linked"
    except ModelRegistryError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    model = next(
        item
        for item in model_registry.public_models(
            active_model_id=runtime_lifecycle.active_model_id,
            include_paths=True,
        )
        if item["id"] == req.model_id
    )
    return {
        "action": action,
        "model": model,
        "location_editable": True,
    }


@app.get("/api/models/switch-status")
async def api_model_switch_status():
    return model_switching.snapshot()


@app.post("/api/models/select")
async def api_model_select(req: ModelSelectionRequest):
    try:
        return await model_switching.switch(req.model_id)
    except ModelSwitchError as exc:
        raise HTTPException(
            status_code=409 if exc.client_error else 502,
            detail={
                "message": str(exc),
                "restored_model_id": exc.restored_model_id,
                "switch": model_switching.snapshot(),
            },
        ) from exc


@app.post("/api/chat")
async def api_chat(req: ChatRequest, request: Request, response: Response):
    runtime = await require_ready_runtime()
    model = choose_model(req.model, runtime)
    session_id, _created = _conversation_session(request)
    if not req.history:
        conversation_memory.reset(session_id)
    payload, context = await prepare_chat_payload(req, model, session_id=session_id)
    _set_conversation_cookie(response, session_id)
    try:
        async with gpu_coexistence.request_scope() as timeout_seconds:
            result = await adapter.chat(payload, timeout_seconds=timeout_seconds)
        result["_harness_context"] = context
        result["_gpu_coexistence"] = gpu_coexistence.snapshot()
        return result
    except httpx.HTTPStatusError as exc:
        detail = exc.response.text or str(exc)
        raise HTTPException(status_code=exc.response.status_code, detail=detail) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc


@app.post("/api/chat/stream")
async def api_chat_stream(req: ChatRequest, request: Request):
    runtime = await require_ready_runtime()
    model = choose_model(req.model, runtime)
    session_id, _created = _conversation_session(request)
    if not req.history:
        conversation_memory.reset(session_id)
    payload, context = await prepare_chat_payload(req, model, session_id=session_id)
    payload["stream_options"] = {"include_usage": True}

    async def guarded_stream():
        async with gpu_coexistence.request_scope() as timeout_seconds:
            metadata = {
                "harness_context": context,
                "gpu_coexistence": gpu_coexistence.snapshot(),
            }
            yield f"data: {json.dumps(metadata)}\n\n".encode("utf-8")
            try:
                async for chunk in adapter.chat_stream(
                    payload, timeout_seconds=timeout_seconds
                ):
                    yield chunk
            except httpx.HTTPStatusError as exc:
                message = exc.response.text or str(exc)
                body = {
                    "error": {"message": message, "status": exc.response.status_code}
                }
                yield f"data: {json.dumps(body)}\n\n".encode("utf-8")
                yield b"data: [DONE]\n\n"
            except Exception as exc:
                body = {"error": {"message": str(exc), "status": 502}}
                yield f"data: {json.dumps(body)}\n\n".encode("utf-8")
                yield b"data: [DONE]\n\n"

    stream_response = StreamingResponse(
        guarded_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "X-Context-Prompt-Tokens": str(context["prompt_tokens"]),
            "X-Context-Trimmed-Messages": str(context["trimmed_history_messages"]),
            "X-Conversation-Memory-Items": str(context["conversation_memory_items"]),
        },
    )
    _set_conversation_cookie(stream_response, session_id)
    return stream_response


@app.post("/api/benchmark")
async def api_benchmark(req: ChatRequest):
    runtime = await require_ready_runtime()
    model = choose_model(req.model, runtime)
    benchmark_req = req.model_copy(
        update={"max_tokens": req.max_tokens or 256, "temperature": 0.0}
    )
    payload, context = await prepare_chat_payload(benchmark_req, model)
    started = time.perf_counter()
    try:
        async with gpu_coexistence.request_scope() as timeout_seconds:
            response = await adapter.chat(payload, timeout_seconds=timeout_seconds)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc
    result = summarize_completion(started, response, req.message)
    result["context"] = context
    result["gpu_coexistence"] = gpu_coexistence.snapshot()
    path = benchmarks.save(result)
    result["saved_to"] = str(path)
    return result
