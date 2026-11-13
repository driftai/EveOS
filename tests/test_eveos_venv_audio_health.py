"""Deterministic failure-injection tests. Never probes the host audio hardware."""
import importlib.util
from pathlib import Path
from types import SimpleNamespace
import unittest

PATH = Path(__file__).resolve().parents[1] / 'tools/health/eveos_venv_audio_health.py'
spec = importlib.util.spec_from_file_location('eveos_venv_audio_health', PATH)
health = importlib.util.module_from_spec(spec)
spec.loader.exec_module(health)

ROOT = Path(__file__).resolve().parents[1]


def modules(*, fail=None, outputs=None, query_error=None):
    fail = {} if fail is None else fail
    if outputs is None:
        outputs = [{'name': 'CABLE Input', 'max_output_channels': 2},
                   {'name': 'Microphone', 'max_output_channels': 0}]

    def query_devices():
        if query_error:
            raise query_error
        return outputs

    result = {name: SimpleNamespace(__version__='test') for name in health.MODULES}
    result['sounddevice'].query_devices = query_devices

    def importer(name):
        if name in fail:
            raise fail[name]
        return result[name]
    return importer


def inspect(*, importer=None, prefix=None, version=(3, 10), windows=True):
    return health.inspect_audio(root=ROOT, executable='fixture-python',
        prefix=prefix or str(ROOT / '.venv'), base_prefix=str(ROOT / 'base-python'),
        version=version, importer=importer or modules(), windows=windows)


class VenvAudioHealthTests(unittest.TestCase):
    def test_valid_cffi_binary_and_audio_endpoints_pass(self):
        result = inspect()
        self.assertEqual(result['status'], 'PASS')
        self.assertTrue(result['projectVenv'])
        self.assertEqual(result['playableOutputs'], 1)
        self.assertEqual(result['cableOutputs'], ['CABLE Input'])

    def test_missing_compiled_cffi_backend_fails_with_specific_reason(self):
        result = inspect(importer=modules(fail={
            '_cffi_backend': ModuleNotFoundError("No module named '_cffi_backend'"),
            'sounddevice': ModuleNotFoundError("No module named '_cffi_backend'")
        }))
        self.assertEqual(result['status'], 'FAIL')
        self.assertEqual(result['reason'], 'cffi-backend-import-failed')

    def test_missing_cffi_package_is_distinct(self):
        result = inspect(importer=modules(fail={'cffi': ImportError('cffi gone')}))
        self.assertEqual(result['reason'], 'cffi-import-failed')

    def test_broken_sounddevice_import_is_detected(self):
        result = inspect(importer=modules(fail={'sounddevice': ImportError('broken')}))
        self.assertEqual(result['reason'], 'sounddevice-import-failed')

    def test_numpy_failure_is_detected(self):
        result = inspect(importer=modules(fail={'numpy': ImportError('missing')}))
        self.assertEqual(result['reason'], 'numpy-import-failed')

    def test_portaudio_enumeration_error_is_not_reported_as_missing_cffi(self):
        result = inspect(importer=modules(query_error=RuntimeError('PortAudio init failed')))
        self.assertEqual(result['reason'], 'portaudio-enumeration-failed')
        self.assertEqual(result['status'], 'FAIL')

    def test_zero_windows_outputs_get_warning_not_false_cffi_diagnosis(self):
        result = inspect(importer=modules(outputs=[]))
        self.assertEqual(result['status'], 'WARN')
        self.assertEqual(result['reason'], 'no-windows-playable-outputs')

    def test_linux_without_outputs_does_not_require_windows_hardware(self):
        result = inspect(importer=modules(outputs=[]), windows=False)
        self.assertEqual(result['status'], 'PASS')

    def test_unrelated_system_python_is_not_claimed_as_project_venv(self):
        result = inspect(prefix=str(ROOT / 'outside'))
        self.assertEqual(result['reason'], 'wrong-python-environment')

    def test_unsupported_python_is_rejected(self):
        result = inspect(version=(3, 9))
        self.assertEqual(result['reason'], 'unsupported-python-version')

    def test_cable_not_required_for_healthy_audio(self):
        result = inspect(importer=modules(outputs=[{
            'name': 'Speakers', 'max_output_channels': 2
        }]))
        self.assertEqual(result['status'], 'PASS')
        self.assertEqual(result['cableOutputs'], [])

    def test_error_text_is_bounded(self):
        result = inspect(importer=modules(fail={'sounddevice': ImportError('x' * 2000)}))
        self.assertLess(len(result['imports']['sounddevice']['error']), 350)


if __name__ == '__main__':
    unittest.main()
