import unittest
from server_modules.audioflix_bridge_devices import spotify_mode_prerequisites


class ModePrerequisiteTests(unittest.TestCase):
    def test_windows_detects_only_edge_beta(self):
        env = {'PROGRAMFILES': 'C:/Apps', 'LOCALAPPDATA': 'C:/Local'}
        result = spotify_mode_prerequisites(
            platform='win32', environ=env,
            exists=lambda p: str(p).replace('\\', '/').endswith('Microsoft/Edge Beta/Application/msedge.exe')
                and str(p).replace('\\', '/').startswith('C:/Apps'),
            module_exists=lambda name: name == 'winappaudiorouter')
        self.assertTrue(result['edgeBetaInstalled'])
        self.assertTrue(result['windowsRoutingAdapterInstalled'])

    def test_absence_and_non_windows_fail_safe(self):
        env = {'PROGRAMFILES': 'C:/Apps'}
        missing = spotify_mode_prerequisites(
            platform='win32', environ=env, exists=lambda p: False, module_exists=lambda n: False)
        self.assertFalse(missing['edgeBetaInstalled'])
        self.assertFalse(missing['windowsRoutingAdapterInstalled'])
        linux = spotify_mode_prerequisites(
            platform='linux', environ=env, exists=lambda p: True, module_exists=lambda n: True)
        self.assertFalse(linux['edgeBetaInstalled'])
        self.assertFalse(linux['windowsRoutingAdapterInstalled'])

    def test_empty_environment_is_safe(self):
        result = spotify_mode_prerequisites(platform='win32', environ={},
            exists=lambda p: True, module_exists=lambda n: False)
        self.assertFalse(result['edgeBetaInstalled'])


if __name__ == '__main__':
    unittest.main()
