from __future__ import annotations

import asyncio
import logging
import os
import signal
import subprocess
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

import httpx

from .model_registry import ModelRecord, ModelRegistry

logger = logging.getLogger(__name__)


class RuntimeLifecycle:
    """Own one local OpenAI-compatible runtime and its selected registry model."""

    def __init__(
        self,
        root: Path,
        base_url: str,
        model: str | None = None,
        settings: dict[str, Any] | None = None,
        registry: ModelRegistry | None = None,
    ) -> None:
        self.root = root.resolve()
        self.base_url = base_url.rstrip("/")
        self.model = model
        self.settings = settings or {}
        self.registry = registry or ModelRegistry(self.root)
        parsed = urlparse(self.base_url)
        self.port = parsed.port or 1919
        self.script = self.root / "scripts" / "run-freetoken.sh"
        self.venv = self.root / ".venvs" / "freetoken"
        self.runtime_dir = self.root / "runtime" / "freetoken"
        self.state_dir = self.root / "state"
        self.logs_dir = self.root / "logs"
        self.pid_path = self.state_dir / "freetoken.pid"
        self.log_path = self.logs_dir / "freetoken-server.log"
        self.startup_gpu_mode = "normal"
        self.active_model_id: str | None = None
        self.active_profile_name: str | None = None
        self.startup_stage = "idle"
        self.last_error: str | None = None
        self._log_start_offset = 0

    def _read_pid(self) -> int | None:
        try:
            return int(self.pid_path.read_text(encoding="utf-8").strip())
        except (OSError, ValueError):
            return None

    @staticmethod
    def _pid_alive(pid: int | None) -> bool:
        if not pid or pid <= 1:
            return False
        try:
            os.kill(pid, 0)
            return True
        except OSError:
            return False

    def _pid_is_managed_runtime(self, pid: int) -> bool:
        try:
            command = (Path("/proc") / str(pid) / "cmdline").read_bytes().replace(
                b"\0", b" "
            )
        except OSError:
            return False
        root_bytes = str(self.root).encode("utf-8")
        return root_bytes in command and (
            b"run-freetoken.sh" in command
            or (b".venvs/freetoken" in command and b" serve " in command)
        )

    def local_status(self) -> dict[str, Any]:
        pid = self._read_pid()
        running = self._pid_alive(pid)
        if pid and not running:
            try:
                self.pid_path.unlink()
            except OSError:
                pass
            pid = None

        missing = []
        if not self.script.exists():
            missing.append(str(self.script))
        if not self.venv.exists():
            missing.append(str(self.venv))
        if not self.runtime_dir.exists():
            missing.append(str(self.runtime_dir))

        return {
            "managed_pid": pid,
            "managed_running": running,
            "can_start": not missing,
            "missing": missing,
            "log_path": str(self.log_path),
            "startup_gpu_mode": self.startup_gpu_mode,
            "active_model_id": self.active_model_id,
            "active_profile": self.active_profile_name,
            "startup_stage": self.startup_stage,
            "last_error": self.last_error,
        }

    def active_record(self) -> ModelRecord:
        model_id = self.active_model_id or self.registry.selected_model_id()
        return self.registry.require(model_id)

    def active_runtime_backend(self) -> str:
        return self.active_record().runtime_backend

    def supports_dynamic_cache(self) -> bool:
        return self.active_runtime_backend() == "freetoken"

    def active_profile(self) -> dict[str, Any]:
        profile_name = self.active_profile_name or "normal"
        return self.registry.profile(self.active_record().id, profile_name)

    def context_capacity_tokens(self) -> int:
        try:
            return max(512, int(self.active_profile()["kv_tokens"]))
        except (KeyError, TypeError, ValueError):
            return 4096

    def normal_profile_uses_graph(self) -> bool:
        try:
            return int(
                self.registry.profile(self.active_record().id, "normal")["graph"]
            ) > 0
        except (KeyError, TypeError, ValueError):
            return False

    async def _sample_gpu(self) -> dict[str, Any] | None:
        query = "--query-gpu=utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits"
        attempts = [
            (
                "windows-nvidia-smi",
                [
                    "powershell.exe",
                    "-NoProfile",
                    "-NonInteractive",
                    "-Command",
                    f"nvidia-smi.exe {query}",
                ],
            ),
            ("wsl-nvidia-smi", ["nvidia-smi", *query.split()]),
        ]
        for source, command in attempts:
            try:
                proc = await asyncio.to_thread(
                    subprocess.run,
                    command,
                    capture_output=True,
                    text=True,
                    timeout=4,
                    check=False,
                )
                if proc.returncode != 0:
                    continue
                line = next(
                    (item.strip() for item in proc.stdout.splitlines() if item.strip()),
                    "",
                )
                parts = [part.strip() for part in line.split(",")]
                if len(parts) >= 3:
                    return {
                        "util_pct": float(parts[0]),
                        "memory_used_mb": float(parts[1]),
                        "memory_total_mb": float(parts[2]),
                        "source": source,
                    }
            except Exception:
                pass
        return None

    async def preflight_gpu_check(self) -> tuple[bool, dict[str, Any]]:
        """Classify external GPU pressure before model startup."""
        samples = []
        for _ in range(3):
            sample = await self._sample_gpu()
            if sample:
                samples.append(sample)
            await asyncio.sleep(0.5)
        if not samples:
            return False, {}
        average_util = sum(sample["util_pct"] for sample in samples) / len(samples)
        latest = samples[-1]
        busy_threshold = float(
            self.settings.get("gpu_coexistence_busy_start_enter_util_pct", 30.0)
        )
        is_busy = (
            average_util >= busy_threshold
            or any(sample.get("util_pct", 0) >= busy_threshold for sample in samples)
            or latest.get("memory_used_mb", 0) >= 1000.0
        )
        return is_busy, latest

    async def stop_managed(self) -> None:
        """Stop only the process group recorded by this harness."""
        self.startup_stage = "stopping"
        pid = self._read_pid()
        if pid and self._pid_alive(pid):
            if not self._pid_is_managed_runtime(pid):
                self.last_error = (
                    f"Refusing to stop PID {pid}: it is not this harness's FreeToken process."
                )
                try:
                    self.pid_path.unlink()
                except OSError:
                    pass
                self.startup_stage = "stopped"
                return
            try:
                try:
                    os.killpg(pid, signal.SIGTERM)
                except OSError:
                    os.kill(pid, signal.SIGTERM)
                for _ in range(40):
                    await asyncio.sleep(0.25)
                    if not self._pid_alive(pid):
                        break
                if self._pid_alive(pid):
                    try:
                        os.killpg(pid, signal.SIGKILL)
                    except OSError:
                        os.kill(pid, signal.SIGKILL)
            except OSError:
                pass
        try:
            self.pid_path.unlink()
        except OSError:
            pass
        self.startup_stage = "stopped"

    def _profile_environment(
        self,
        record: ModelRecord,
        profile_name: str,
        *,
        graph_override: int | None = None,
    ) -> dict[str, str]:
        profile = self.registry.profile(record.id, profile_name)
        graph = int(profile["graph"] if graph_override is None else graph_override)
        environment = os.environ.copy()
        environment.update(
            {
                "LOCAL_MOE_ACTIVE_MODEL_ID": record.id,
                "LOCAL_MOE_SERVED_MODEL_NAME": record.served_model_name,
                "LOCAL_MOE_PROFILE_NAME": profile_name,
                "LOCAL_MOE_CONTEXT_PROFILE": str(profile["label"]),
                "LOCAL_MOE_KV_RESERVE_TOKENS": str(profile["kv_tokens"]),
                "LOCAL_MOE_MAX_PREFILL_LENGTH": str(profile["prefill_tokens"]),
                "LOCAL_MOE_PREFILL_HIT_D2D": str(profile["d2d"]),
                "LOCAL_MOE_MEMORY_RATIO": str(profile["memory_ratio"]),
                "LOCAL_MOE_CUDA_GRAPH_MAX_BS": str(graph),
                "LOCAL_MOE_MAX_RUNNING_REQUESTS": "1",
            }
        )
        slots = profile.get("moe_slots")
        environment.pop("LOCAL_MOE_MOE_CACHE_SIZE", None)
        if slots is None:
            environment.pop("LOCAL_MOE_NORMAL_MOE_SLOTS", None)
        else:
            environment["LOCAL_MOE_NORMAL_MOE_SLOTS"] = str(slots)
        if profile_name == "recovery":
            environment["LOCAL_MOE_RECOVERY"] = "1"
            environment["LOCAL_MOE_RECOVERY_MEMORY_RATIO"] = str(
                profile["memory_ratio"]
            )
            environment["LOCAL_MOE_RECOVERY_KV_RESERVE_TOKENS"] = str(
                profile["kv_tokens"]
            )
            environment["LOCAL_MOE_RECOVERY_MAX_PREFILL_LENGTH"] = str(
                profile["prefill_tokens"]
            )
            environment["LOCAL_MOE_RECOVERY_PREFILL_HIT_D2D"] = str(
                profile["d2d"]
            )
        else:
            environment.pop("LOCAL_MOE_RECOVERY", None)
        runtime_profiles = record.data.get("runtime_options", {}).get("profiles", {})
        runtime_profile = runtime_profiles.get(profile_name, {})
        gpu_layers = runtime_profile.get("gpu_layers")
        if gpu_layers is None:
            environment.pop("LOCAL_MOE_GPU_LAYERS", None)
        else:
            environment["LOCAL_MOE_GPU_LAYERS"] = str(int(gpu_layers))
        return environment

    async def _start_process(
        self,
        record: ModelRecord,
        environment: dict[str, str],
    ) -> dict[str, Any]:
        self.state_dir.mkdir(parents=True, exist_ok=True)
        self.logs_dir.mkdir(parents=True, exist_ok=True)
        self.startup_stage = "loading_weights"
        self.last_error = None
        try:
            self._log_start_offset = self.log_path.stat().st_size
        except OSError:
            self._log_start_offset = 0

        args = self._process_args(record)
        log_file = self.log_path.open("ab", buffering=0)
        try:
            process = await asyncio.create_subprocess_exec(
                *args,
                cwd=str(self.root),
                stdout=log_file,
                stderr=asyncio.subprocess.STDOUT,
                start_new_session=True,
                env=environment,
            )
        finally:
            log_file.close()

        self.pid_path.write_text(f"{process.pid}\n", encoding="utf-8")
        self.active_model_id = record.id
        await asyncio.sleep(0.35)
        if process.returncode is not None:
            try:
                self.pid_path.unlink()
            except OSError:
                pass
            self.last_error = (
                f"Local model runtime exited immediately with code {process.returncode}. "
                f"Check {self.log_path}."
            )
            self.startup_stage = "failed"
            return {**self.local_status(), "started": False, "error": self.last_error}

        return {
            **self.local_status(),
            "started": True,
            "already_reachable": False,
            "health_status": "starting",
        }

    def _process_args(self, record: ModelRecord) -> list[str]:
        """Resolve only the registry-approved directory or single-file entrypoint."""
        return [
            "bash",
            str(self.script),
            str(record.runtime_path),
            str(self.port),
        ]

    def _new_log_tail(self) -> str:
        try:
            with self.log_path.open("rb") as handle:
                handle.seek(self._log_start_offset)
                return handle.read()[-5000:].decode("utf-8", errors="ignore")
        except OSError:
            return ""

    async def _wait_for_startup_health(
        self,
        record: ModelRecord,
        timeout_seconds: float,
    ) -> bool:
        """Wait for authoritative health and the expected served model identity."""
        deadline = asyncio.get_running_loop().time() + timeout_seconds
        while asyncio.get_running_loop().time() < deadline:
            pid = self._read_pid()
            if not self._pid_alive(pid):
                self.last_error = "Local model runtime exited before readiness."
                self.startup_stage = "failed"
                return False

            tail = self._new_log_tail()
            if (
                "cudaErrorStreamCaptureInvalidated" in tail
                or "Backend worker is gone" in tail
            ):
                self.last_error = "FreeToken reported a startup backend failure."
                self.startup_stage = "failed"
                return False

            try:
                async with httpx.AsyncClient(timeout=2.0) as client:
                    health_response = await client.get(f"{self.base_url}/health")
                    if health_response.is_success:
                        health = health_response.json()
                        if health.get("status") == "error":
                            self.last_error = str(
                                health.get("error") or "FreeToken health reported error."
                            )
                            self.startup_stage = "failed"
                            return False
                        if health.get("status") == "ok":
                            self.startup_stage = "checking_identity"
                            models_response = await client.get(
                                f"{self.base_url}/v1/models"
                            )
                            models_response.raise_for_status()
                            ids = {
                                item.get("id")
                                for item in models_response.json().get("data", [])
                            }
                            if record.served_model_name not in ids:
                                self.last_error = (
                                    "Local runtime became ready with an unexpected model: "
                                    f"expected {record.served_model_name}, got {sorted(ids)}"
                                )
                                self.startup_stage = "failed"
                                return False
                            self.startup_stage = "ready"
                            self.last_error = None
                            return True
            except Exception:
                pass
            await asyncio.sleep(1.0)

        self.last_error = (
            f"Local model runtime did not become ready within {int(timeout_seconds)} seconds."
        )
        self.startup_stage = "failed"
        return False

    async def _existing_runtime(self) -> dict[str, Any] | None:
        try:
            async with httpx.AsyncClient(timeout=2.0) as client:
                response = await client.get(f"{self.base_url}/health")
                if not response.is_success or response.json().get("status") != "ok":
                    return None
                models_response = await client.get(f"{self.base_url}/v1/models")
                models_response.raise_for_status()
                models = models_response.json().get("data", [])
        except Exception:
            return None

        served_ids = {item.get("id") for item in models}
        inherited_profile = None
        pid = self._read_pid()
        if pid and self._pid_alive(pid):
            try:
                raw_environment = (
                    Path("/proc") / str(pid) / "environ"
                ).read_bytes().split(b"\0")
                values = dict(
                    item.split(b"=", 1) for item in raw_environment if b"=" in item
                )
                candidate = values.get(b"LOCAL_MOE_PROFILE_NAME", b"").decode()
                if candidate in {"normal", "busy", "recovery"}:
                    inherited_profile = candidate
            except OSError:
                pass
        for record in self.registry.records():
            if record.served_model_name in served_ids:
                self.active_model_id = record.id
                self.active_profile_name = (
                    self.active_profile_name or inherited_profile or "normal"
                )
                self.startup_stage = "ready"
                return {"health": response.json(), "models": models}
        self.last_error = f"Ready local runtime model is outside the registry: {served_ids}"
        return {"health": response.json(), "models": models}

    async def _select_profile_name(
        self, record: ModelRecord
    ) -> tuple[str, dict[str, Any]]:
        configured = os.environ.get("LOCAL_MOE_CONTEXT_PROFILE", "").lower()
        is_manual_recovery = (
            record.id == self.registry.default_model_id
            and configured in {"balanced4k", "recovery4k"}
        )
        if os.environ.get("LOCAL_MOE_RECOVERY") == "1" or is_manual_recovery:
            return "recovery", {}
        is_busy, sample = await self.preflight_gpu_check()
        if record.id == self.registry.default_model_id and configured == "fast8k":
            is_busy = True
        return ("busy" if is_busy else "normal"), sample

    async def start_model(
        self,
        model_id: str,
        *,
        wait_until_ready: bool,
        profile_name: str | None = None,
    ) -> dict[str, Any]:
        """Start one trusted installed model, optionally waiting through readiness."""
        record = self.registry.require_selectable_installed(model_id)
        selected_profile, sample = (
            (profile_name, {})
            if profile_name is not None
            else await self._select_profile_name(record)
        )
        if selected_profile not in {"normal", "busy", "recovery"}:
            raise ValueError(f"Unsupported runtime profile: {selected_profile}")

        self.active_model_id = record.id
        self.active_profile_name = selected_profile
        profile = self.registry.profile(record.id, selected_profile)
        graph = int(profile["graph"])
        self.startup_gpu_mode = (
            "normal" if selected_profile == "normal" else "coexistence-graph"
        )
        if graph == 0:
            if selected_profile == "normal":
                self.startup_gpu_mode = "normal-eager"
            elif selected_profile == "recovery":
                self.startup_gpu_mode = "recovery"
            else:
                self.startup_gpu_mode = "coexistence-eager"

        if sample:
            logger.info(
                "Selected %s %s profile at %.1f%% GPU / %.0f MiB VRAM.",
                record.id,
                selected_profile,
                sample.get("util_pct", 0),
                sample.get("memory_used_mb", 0),
            )
        environment = self._profile_environment(record, selected_profile)
        result = await self._start_process(record, environment)
        if not result.get("started"):
            return result

        # A non-blocking start request must return after the owned process is
        # launched. The former busy-profile path waited 45 seconds first, then
        # treated an actively loading large model as failed and launched it a
        # second time. Callers that request readiness still retain the guarded
        # graph-to-eager recovery below.
        if not wait_until_ready:
            return result

        startup_timeout = float(profile["startup_timeout"])
        if selected_profile == "busy" and graph > 0:
            graph_ok = await self._wait_for_startup_health(
                record, startup_timeout
            )
            if graph_ok:
                return {**self.local_status(), "started": True, "ready": True}
            logger.warning(
                "%s busy graph startup failed; retrying the same profile in eager mode.",
                record.id,
            )
            await self.stop_managed()
            await asyncio.sleep(1.0)
            self.startup_gpu_mode = "coexistence-eager"
            environment = self._profile_environment(
                record, selected_profile, graph_override=0
            )
            result = await self._start_process(record, environment)
            if not result.get("started"):
                return result

        ready = await self._wait_for_startup_health(record, startup_timeout)
        return {
            **self.local_status(),
            "started": True,
            "ready": ready,
            **({"error": self.last_error} if not ready else {}),
        }

    async def restart_normal(self) -> None:
        """Restart the active model with its model-specific normal profile."""
        record = self.active_record()
        logger.info(
            "[RuntimeLifecycle] Restarting %s into its normal profile.", record.id
        )
        await self.stop_managed()
        await asyncio.sleep(1.0)
        await self.start_model(record.id, wait_until_ready=False, profile_name="normal")

    async def ensure_started(self) -> dict[str, Any]:
        """Start the persisted selected model if no healthy runtime already exists."""
        local = self.local_status()
        existing = await self._existing_runtime()
        if existing is not None:
            return {
                **local,
                "started": False,
                "already_reachable": True,
                "health_status": existing["health"].get("status"),
            }
        if local["managed_running"]:
            return {
                **local,
                "started": False,
                "already_reachable": False,
                "health_status": "starting",
            }
        if not local["can_start"]:
            return {
                **local,
                "started": False,
                "error": "Local model runtime files are incomplete.",
            }
        return await self.start_model(
            self.registry.selected_model_id(), wait_until_ready=False
        )
