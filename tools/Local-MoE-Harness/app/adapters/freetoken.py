from __future__ import annotations

import asyncio
import time
from typing import AsyncIterator, Callable

import httpx

from .base import RuntimeAdapter


class FreeTokenAdapter(RuntimeAdapter):
    """Adapter for FreeToken and compatible llama.cpp HTTP endpoints."""

    def __init__(
        self,
        base_url: str,
        timeout: float = 300.0,
        runtime_provider: Callable[[], str] | None = None,
    ):
        self.base_url = base_url.rstrip("/")
        self.timeout = timeout
        self.runtime_provider = runtime_provider
        self._status_lock = asyncio.Lock()
        self._status_cache: dict | None = None
        self._status_cache_at = 0.0
        self._last_ready_status: dict | None = None
        self._last_ready_at = 0.0

    def invalidate_status_cache(self, *, drop_ready: bool = False) -> None:
        """Discard passive probe state before an intentional lifecycle change."""
        self._status_cache = None
        self._status_cache_at = 0.0
        if drop_ready:
            self._last_ready_status = None
            self._last_ready_at = 0.0

    def _status_cache_ttl(self) -> float:
        """Keep loading feedback quick, then calm passive probes once the runtime is ready."""
        return 5.0 if self._status_cache and self._status_cache.get("ready") else 1.0

    async def status(self, *, force: bool = False) -> dict:
        """Coalesce passive probes and absorb brief misses from a busy runtime."""
        now = time.monotonic()
        if not force and self._status_cache and now - self._status_cache_at < self._status_cache_ttl():
            return dict(self._status_cache)

        async with self._status_lock:
            now = time.monotonic()
            if not force and self._status_cache and now - self._status_cache_at < self._status_cache_ttl():
                return dict(self._status_cache)

            result = await self._probe_status()
            if result.get("ready"):
                self._last_ready_status = dict(result)
                self._last_ready_at = now
            elif self._last_ready_status and now - self._last_ready_at < 6.0:
                result = {
                    **self._last_ready_status,
                    "stale": True,
                    "probe_latency_ms": result.get("latency_ms"),
                    "status_warning": "Runtime status is briefly delayed; retaining last-ready state.",
                }

            self._status_cache = dict(result)
            self._status_cache_at = now
            return dict(result)

    async def _probe_status(self) -> dict:
        """Report FreeToken reachability, loading state, readiness, and models.

        /v1/models may become available before generation is ready, so /health
        remains the authoritative readiness signal. We still fetch models even
        when /health fails so the UI can distinguish "server reachable" from
        "model ready".
        """
        started = time.perf_counter()
        health: dict = {}
        models: list[dict] = []
        health_error: str | None = None
        models_error: str | None = None

        timeout = httpx.Timeout(3.0, connect=2.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            try:
                response = await client.get(f"{self.base_url}/health")
                response.raise_for_status()
                health = response.json()
            except Exception as exc:
                health_error = str(exc)

            try:
                response = await client.get(f"{self.base_url}/v1/models")
                response.raise_for_status()
                models = response.json().get("data", [])
            except Exception as exc:
                models_error = str(exc)

        latency_ms = round((time.perf_counter() - started) * 1000, 1)
        health_status = health.get("status")
        reachable = bool(health) or bool(models)
        result = {
            "ready": health_status == "ok",
            "reachable": reachable,
            "runtime": self.runtime_provider() if self.runtime_provider else "freetoken",
            "base_url": self.base_url,
            "latency_ms": latency_ms,
            "health_status": health_status or ("unknown" if reachable else "offline"),
            "models": models,
        }

        if health_status != "ok":
            result["phase"] = health.get("phase", "unknown")
            if "progress" in health:
                result["progress"] = health["progress"]

        if health_error:
            result["health_error"] = health_error
        if models_error:
            result["models_error"] = models_error
        if not reachable:
            result["error"] = health_error or models_error or "Local model runtime is unreachable."

        return result

    async def models(self) -> list[dict]:
        async with httpx.AsyncClient(timeout=10.0) as client:
            response = await client.get(f"{self.base_url}/v1/models")
            response.raise_for_status()
            return response.json().get("data", [])

    async def count_tokens(
        self,
        model: str,
        messages: list[dict],
        system: str | None = None,
    ) -> int:
        """Count the rendered prompt with FreeToken's own tokenizer/template."""
        body: dict = {"model": model, "messages": messages}
        if system:
            body["system"] = system

        timeout = httpx.Timeout(15.0, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self.base_url}/v1/messages/count_tokens",
                json=body,
            )
            response.raise_for_status()
            value = response.json().get("input_tokens")

        if not isinstance(value, int) or value < 0:
            raise ValueError(f"FreeToken returned an invalid token count: {value!r}")
        return value

    async def cache_status(self, timeout_seconds: float = 10.0) -> dict:
        timeout = httpx.Timeout(timeout_seconds, connect=min(5.0, timeout_seconds))
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.get(f"{self.base_url}/v1/cache/status")
            response.raise_for_status()
            return response.json()

    async def rebuild_moe_cache(
        self,
        moe_cache_size: int,
        *,
        wait_seconds: float = 180.0,
    ) -> dict:
        """Resize only the live MoE expert cache; KV geometry remains untouched."""
        wait_seconds = max(10.0, float(wait_seconds))
        timeout = httpx.Timeout(wait_seconds + 10.0, connect=5.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self.base_url}/v1/cache/rebuild",
                json={
                    "moe_cache_size": int(moe_cache_size),
                    "timeout": wait_seconds,
                },
            )
            response.raise_for_status()
            return response.json()

    async def chat(self, payload: dict, timeout_seconds: float | None = None) -> dict:
        effective_timeout = self.timeout if timeout_seconds is None else timeout_seconds
        timeout = httpx.Timeout(effective_timeout, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            response = await client.post(
                f"{self.base_url}/v1/chat/completions", json=payload
            )
            response.raise_for_status()
            return response.json()

    async def chat_stream(
        self,
        payload: dict,
        timeout_seconds: float | None = None,
    ) -> AsyncIterator[bytes]:
        payload = {**payload, "stream": True}
        effective_timeout = self.timeout if timeout_seconds is None else timeout_seconds
        timeout = httpx.Timeout(effective_timeout, connect=10.0)
        async with httpx.AsyncClient(timeout=timeout) as client:
            async with client.stream(
                "POST", f"{self.base_url}/v1/chat/completions", json=payload
            ) as response:
                response.raise_for_status()
                async for chunk in response.aiter_bytes():
                    if chunk:
                        yield chunk
