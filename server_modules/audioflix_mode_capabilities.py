"""Read-only AudioFlix prerequisite *presence* checks.

Presence is not proof of a playable Spotify session or a verified Windows audio route.
No imports of Windows COM or device re-enumeration occur here.
"""
from __future__ import annotations

import importlib.util
import os
import sys
from importlib import metadata
from pathlib import Path

_EDGE_SUBPATH = Path('Microsoft') / 'Edge Beta' / 'Application' / 'msedge.exe'
_REQUIRED = ('winappaudiorouter', 'pycaw', 'sounddevice', 'psutil')
_PIN = '1.1.1'


def detect_mode_capabilities(platform=None, env=None, exists=None,
                             module_exists=None, version_lookup=None):
    platform = sys.platform if platform is None else platform
    env = os.environ if env is None else env
    exists = (lambda p: p.is_file()) if exists is None else exists
    module_exists = (lambda name: importlib.util.find_spec(name) is not None) if module_exists is None else module_exists
    version_lookup = metadata.version if version_lookup is None else version_lookup
    if platform != 'win32':
        return {
            'schemaVersion': 1,
            'platform': platform,
            'edgeBeta': {'status': 'unsupported', 'detail': 'This dependency check is Windows-only.'},
            'windowsAppRouting': {'status': 'unsupported', 'detail': 'Windows per-app routing is Windows-only.'},
            'playbackVerified': False,
        }
    roots = [env.get('PROGRAMFILES(X86)'), env.get('PROGRAMFILES'), env.get('LOCALAPPDATA')]
    candidates = [Path(root) / _EDGE_SUBPATH for root in roots if root]
    try:
        edge = next((candidate for candidate in candidates if exists(candidate)), None)
        edge_data = {'status': 'detected' if edge else ('missing' if candidates else 'not_checked'),
                     'detail': 'Edge Beta executable present; Spotify playback not tested.' if edge
                     else ('Edge Beta not found in supported locations.' if candidates
                           else 'Windows program directories were unavailable.')}
    except (OSError, PermissionError):
        edge_data = {'status': 'not_checked', 'detail': 'Edge Beta paths could not be inspected.'}

    try:
        missing = [name for name in _REQUIRED if not module_exists(name)]
        if missing:
            adapter_data = {'status': 'missing', 'detail': 'Missing Python packages: ' + ', '.join(missing)}
        else:
            try:
                installed = version_lookup('winappaudiorouter')
            except metadata.PackageNotFoundError:
                installed = None
            if installed != _PIN:
                adapter_data = {'status': 'missing', 'detail': 'Windows adapter requires winappaudiorouter==1.1.1.'}
            else:
                adapter_data = {'status': 'installed', 'detail':
                                'Required Python modules and adapter pin detected; live COM/route readback not tested.'}
    except Exception:
        adapter_data = {'status': 'not_checked', 'detail': 'Could not inspect routing dependencies.'}
    return {'schemaVersion': 1, 'platform': platform, 'edgeBeta': edge_data,
            'windowsAppRouting': adapter_data, 'playbackVerified': False}
