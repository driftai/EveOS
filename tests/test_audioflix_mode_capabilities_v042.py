import importlib.util
import unittest
from pathlib import Path
from unittest import mock


class Tests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[1]
        source = root / 'server_modules' / 'audioflix_mode_capabilities.py'
        if not source.exists(): source = root / 'payload' / 'audioflix_mode_capabilities.py'
        spec = importlib.util.spec_from_file_location('mode_caps', str(source))
        cls.module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(cls.module)

    def probe(self, edge=True, adapter=True, version='1.1.1', platform='win32'):
        return self.module.detect_mode_capabilities(
            platform=platform,
            env={'PROGRAMFILES(X86)': 'C:/Program Files (x86)', 'PROGRAMFILES': 'C:/Program Files'},
            exists=lambda p: edge and str(p).replace('\\', '/').startswith('C:/Program Files (x86)/'),
            module_exists=lambda name: adapter,
            version_lookup=lambda name: version)

    def test_edge_detected_does_not_claim_playback(self):
        r = self.probe()
        self.assertEqual(r['edgeBeta']['status'], 'detected')
        self.assertEqual(r['windowsAppRouting']['status'], 'installed')
        self.assertFalse(r['playbackVerified'])

    def test_missing_edge_is_not_ambiguous(self):
        self.assertEqual(self.probe(edge=False)['edgeBeta']['status'], 'missing')

    def test_missing_routing_is_not_ready(self):
        self.assertEqual(self.probe(adapter=False)['windowsAppRouting']['status'], 'missing')

    def test_bad_adapter_pin_does_not_qualify(self):
        self.assertEqual(self.probe(version='1.0.0')['windowsAppRouting']['status'], 'missing')

    def test_non_windows_is_unsupported(self):
        r = self.probe(platform='linux')
        self.assertEqual(r['edgeBeta']['status'], 'unsupported')
        self.assertEqual(r['windowsAppRouting']['status'], 'unsupported')

    def test_no_program_folders_does_not_claim_missing(self):
        r = self.module.detect_mode_capabilities(platform='win32', env={}, exists=lambda _: False,
                module_exists=lambda _: True, version_lookup=lambda _: '1.1.1')
        self.assertEqual(r['edgeBeta']['status'], 'not_checked')

    def test_adapter_probe_exception_is_not_missing(self):
        r = self.module.detect_mode_capabilities(platform='win32', env={'PROGRAMFILES': 'C:/Program Files'},
                exists=lambda _: False, module_exists=lambda _: (_ for _ in ()).throw(RuntimeError('denied')))
        self.assertEqual(r['windowsAppRouting']['status'], 'not_checked')

    def test_no_windows_com_import_or_external_call(self):
        with mock.patch('subprocess.run', side_effect=AssertionError('external call')):
            self.assertEqual(self.probe()['edgeBeta']['status'], 'detected')


if __name__ == '__main__': unittest.main()
