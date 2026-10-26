import io
import asyncio
import os
import sys
import time
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch


ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from app.services.model_registry import ModelRegistry
from app.adapters.freetoken import FreeTokenAdapter
from app.services.runtime_lifecycle import RuntimeLifecycle
from app.services.runtime_lifecycle_windows import RuntimeLifecycle as WindowsRuntimeLifecycle


class RuntimeLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.registry = ModelRegistry(ROOT)
        self.lifecycle = RuntimeLifecycle(
            ROOT,
            "http://127.0.0.1:1919",
            settings={"gpu_coexistence_busy_start_enter_util_pct": 30},
            registry=self.registry,
        )

    @staticmethod
    def _model_argument(args):
        if "-ModelPath" in args:
            return args[args.index("-ModelPath") + 1]
        return args[2]

    def test_qwen_environment_preserves_validated_normal_geometry(self):
        record = self.registry.require("qwen36-nvfp4")
        with patch.dict(os.environ, {"LOCAL_MOE_MOE_CACHE_SIZE": "999"}):
            environment = self.lifecycle._profile_environment(record, "normal")
        self.assertEqual(environment["LOCAL_MOE_KV_RESERVE_TOKENS"], "12288")
        self.assertEqual(environment["LOCAL_MOE_MAX_PREFILL_LENGTH"], "2048")
        self.assertEqual(environment["LOCAL_MOE_PREFILL_HIT_D2D"], "1")
        self.assertEqual(environment["LOCAL_MOE_MEMORY_RATIO"], "0.92")
        self.assertEqual(environment["LOCAL_MOE_CUDA_GRAPH_MAX_BS"], "1")
        self.assertEqual(environment["LOCAL_MOE_NORMAL_MOE_SLOTS"], "569")
        self.assertNotIn("LOCAL_MOE_MOE_CACHE_SIZE", environment)

    def test_alternate_profile_uses_its_own_geometry(self):
        record = self.registry.require("gpt-oss-20b")
        normal = self.lifecycle._profile_environment(record, "normal")
        environment = self.lifecycle._profile_environment(record, "recovery")
        self.assertEqual(normal["LOCAL_MOE_KV_RESERVE_TOKENS"], "1024")
        self.assertEqual(normal["LOCAL_MOE_MAX_PREFILL_LENGTH"], "256")
        self.assertEqual(normal["LOCAL_MOE_MEMORY_RATIO"], "0.99")
        self.assertEqual(environment["LOCAL_MOE_KV_RESERVE_TOKENS"], "1024")
        self.assertEqual(environment["LOCAL_MOE_MAX_PREFILL_LENGTH"], "256")
        self.assertEqual(environment["LOCAL_MOE_MEMORY_RATIO"], "0.99")
        self.assertEqual(environment["LOCAL_MOE_CUDA_GRAPH_MAX_BS"], "0")
        self.assertNotIn("LOCAL_MOE_NORMAL_MOE_SLOTS", environment)

    def test_graph_recovery_is_model_specific(self):
        self.lifecycle.active_model_id = "qwen36-nvfp4"
        self.assertTrue(self.lifecycle.normal_profile_uses_graph())
        self.lifecycle.active_model_id = "gpt-oss-20b"
        self.assertFalse(self.lifecycle.normal_profile_uses_graph())

    def test_process_args_use_approved_single_file_entrypoint(self):
        record = self.registry.require("gemma4-26b-q4_0-gguf")
        args = self.lifecycle._process_args(record)
        self.assertEqual(
            self._model_argument(args),
            str(record.local_path / record.data["serve_file"]),
        )

    def test_process_args_keep_directory_models_unchanged(self):
        record = self.registry.require("qwen36-nvfp4")
        args = self.lifecycle._process_args(record)
        self.assertEqual(self._model_argument(args), str(record.local_path))

    def test_bonsai_uses_prism_backend_and_profile_offload(self):
        self.lifecycle = WindowsRuntimeLifecycle(ROOT, "http://127.0.0.1:1919", registry=self.registry)
        record = self.registry.require("bonsai2-27b-ptq1")
        args = self.lifecycle._process_args(record)
        environment = self.lifecycle._profile_environment(record, "normal")
        self.lifecycle.active_model_id = record.id
        self.lifecycle.active_profile_name = "normal"
        runtime_environment = self.lifecycle._runtime_environment(record, environment)
        self.assertIn("run-prism-llama-windows.ps1", " ".join(args))
        self.assertEqual(self._model_argument(args), str(record.runtime_path))
        self.assertEqual(args[args.index("-ServedModelName") + 1], record.served_model_name)
        self.assertEqual(environment["LOCAL_MOE_GPU_LAYERS"], "56")
        self.assertEqual(runtime_environment["LOCAL_MOE_GPU_LAYERS"], "auto")
        self.assertEqual(runtime_environment["LOCAL_MOE_GPU_FIT_TARGET_MB"], "256")
        self.assertEqual(self.lifecycle.active_runtime_backend(), "prism-llama")
        self.assertFalse(self.lifecycle.supports_dynamic_cache())

    def test_headed_runtime_title_uses_registry_metadata(self):
        self.lifecycle = WindowsRuntimeLifecycle(ROOT, "http://127.0.0.1:1919", registry=self.registry)
        record = self.registry.require("qwen36-nvfp4")
        title = self.lifecycle._console_title(record)
        self.assertIn(str(record.data["display_name"]), title)
        self.assertNotIn("ModelRecord", title)

    def test_windows_runtime_headed_default_is_explicit(self):
        if os.name != "nt":
            self.skipTest("Windows-only console policy")
        self.assertFalse(self.lifecycle._headless_requested({}))
        self.assertFalse(self.lifecycle._headless_requested({"EVEOS_HEADLESS": ""}))
        self.assertTrue(self.lifecycle._headless_requested({"EVEOS_HEADLESS": "1"}))
        self.assertTrue(self.lifecycle._headless_requested({"LOCAL_MOE_HEADLESS": "true"}))

    async def test_fast8k_launcher_request_maps_to_busy_qwen_profile(self):
        record = self.registry.require("qwen36-nvfp4")
        self.lifecycle.preflight_gpu_check = AsyncMock(return_value=(False, {}))
        with patch.dict(os.environ, {"LOCAL_MOE_CONTEXT_PROFILE": "fast8k"}, clear=False):
            name, _sample = await self.lifecycle._select_profile_name(record)
        self.assertEqual(name, "busy")

    async def test_nonblocking_busy_start_returns_without_readiness_wait_or_retry(self):
        record = self.registry.require("qwen36-nvfp4")
        self.lifecycle._start_process = AsyncMock(
            return_value={"started": True, "health_status": "starting"}
        )
        self.lifecycle._wait_for_startup_health = AsyncMock(return_value=False)
        with patch.object(
            self.registry, "require_selectable_installed", return_value=record
        ):
            result = await self.lifecycle.start_model(
                record.id, wait_until_ready=False, profile_name="busy"
            )
        self.assertTrue(result["started"])
        self.lifecycle._start_process.assert_awaited_once()
        self.lifecycle._wait_for_startup_health.assert_not_awaited()

    async def test_waiting_busy_start_uses_model_startup_budget(self):
        record = self.registry.require("qwen36-nvfp4")
        self.lifecycle._start_process = AsyncMock(
            return_value={"started": True, "health_status": "starting"}
        )
        self.lifecycle._wait_for_startup_health = AsyncMock(return_value=True)
        with patch.object(
            self.registry, "require_selectable_installed", return_value=record
        ):
            result = await self.lifecycle.start_model(
                record.id, wait_until_ready=True, profile_name="busy"
            )
        self.assertTrue(result["ready"])
        self.lifecycle._wait_for_startup_health.assert_awaited_once_with(record, 240.0)


class RuntimeStatusTests(unittest.IsolatedAsyncioTestCase):
    async def test_concurrent_status_reads_share_one_probe(self):
        adapter = FreeTokenAdapter("http://127.0.0.1:1919")
        adapter._probe_status = AsyncMock(return_value={"ready": True, "models": []})
        first, second = await asyncio.gather(adapter.status(), adapter.status())
        self.assertTrue(first["ready"] and second["ready"])
        adapter._probe_status.assert_awaited_once()

    async def test_brief_probe_miss_retains_last_ready_status(self):
        adapter = FreeTokenAdapter("http://127.0.0.1:1919")
        adapter._last_ready_status = {"ready": True, "models": [{"id": "bonsai"}]}
        adapter._last_ready_at = time.monotonic()
        adapter._probe_status = AsyncMock(return_value={"ready": False, "latency_ms": 3000})
        status = await adapter.status(force=True)
        self.assertTrue(status["ready"])
        self.assertTrue(status["stale"])


if __name__ == "__main__":
    stream = io.StringIO()
    suite = unittest.defaultTestLoader.loadTestsFromModule(sys.modules[__name__])
    result = unittest.TextTestRunner(stream=stream, verbosity=1).run(suite)
    if result.wasSuccessful():
        print(f"[Runtime Lifecycle Tests] PASS ({result.testsRun}/{result.testsRun})")
        raise SystemExit(0)
    print("\n".join(stream.getvalue().splitlines()[-40:]), file=sys.stderr)
    raise SystemExit(1)
