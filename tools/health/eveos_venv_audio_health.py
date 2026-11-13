#!/usr/bin/env python3
"""Read-only native-audio environment preflight for EveOS.

Uses only Python's standard library until probing optional runtime imports.
Do not use this module to auto-install, reset the venv or modify audio devices.
"""
from __future__ import annotations

import argparse
import importlib
import json
import os
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
MODULES = ("numpy", "cffi", "_cffi_backend", "sounddevice")


def _short_error(exc: BaseException) -> str:
    return f"{type(exc).__name__}: {str(exc)[:300]}"


def inspect_audio(*, root=ROOT, executable=None, prefix=None, base_prefix=None,
                  version=None, importer=None, windows=None) -> dict:
    """Probe the exact selected Python, without writes or audio playback."""
    executable = sys.executable if executable is None else str(executable)
    prefix = sys.prefix if prefix is None else str(prefix)
    base_prefix = sys.base_prefix if base_prefix is None else str(base_prefix)
    version = tuple(sys.version_info[:2]) if version is None else tuple(version)
    importer = importlib.import_module if importer is None else importer
    windows = os.name == 'nt' if windows is None else bool(windows)
    expected = Path(root).resolve() / '.venv'
    try:
        is_venv = (Path(prefix).resolve() == expected and
                   Path(prefix).resolve() != Path(base_prefix).resolve())
    except (OSError, ValueError):
        is_venv = False
    report = {
        'schema': 'eveos.venv-audio-health.v1',
        'python': executable,
        'pythonVersion': '.'.join(map(str, version)),
        'projectVenv': is_venv,
        'imports': {},
        'playableOutputs': None,
        'cableOutputs': [],
        'status': 'PASS',
        'reason': 'native-audio-ready',
    }
    if not is_venv:
        report.update(status='FAIL', reason='wrong-python-environment')
        return report
    if version not in ((3, 10), (3, 11)):
        report.update(status='FAIL', reason='unsupported-python-version')
        return report

    loaded = {}
    for name in MODULES:
        try:
            module = importer(name)
            loaded[name] = module
            report['imports'][name] = {
                'ok': True,
                'version': str(getattr(module, '__version__', 'unknown'))[:60],
            }
        except Exception as exc:
            report['imports'][name] = {'ok': False, 'error': _short_error(exc)}

    failed = [name for name in MODULES if not report['imports'][name]['ok']]
    if failed:
        if '_cffi_backend' in failed:
            reason = 'cffi-backend-import-failed'
        elif 'cffi' in failed:
            reason = 'cffi-import-failed'
        elif 'sounddevice' in failed:
            reason = 'sounddevice-import-failed'
        else:
            reason = 'numpy-import-failed'
        report.update(status='FAIL', reason=reason)
        return report

    # Every invocation is a fresh process; query_devices cannot invalidate a
    # running EveOS audio stream, and does not play or change endpoint settings.
    try:
        raw = loaded['sounddevice'].query_devices()
        outputs = [d for d in raw if int(d.get('max_output_channels') or 0) > 0]
        report['playableOutputs'] = len(outputs)
        report['cableOutputs'] = [
            str(d.get('name') or '')[:160] for d in outputs
            if 'cable input' in str(d.get('name') or '').lower()
        ][:12]
    except Exception as exc:
        report.update(status='FAIL', reason='portaudio-enumeration-failed',
                      deviceError=_short_error(exc))
        return report

    if windows and not outputs:
        report.update(status='WARN', reason='no-windows-playable-outputs')
    return report


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--json', action='store_true', help='Full machine-readable health result')
    parser.add_argument('--compact', action='store_true', help='Single-line boot diagnostic')
    args = parser.parse_args(argv)
    report = inspect_audio()
    if args.json:
        print(json.dumps(report, indent=2))
    else:
        marker = 'EVEOS_VENV_AUDIO_' + report['status']
        print(f"{marker} reason={report['reason']} outputs={report['playableOutputs']} "
              f"cable={len(report['cableOutputs'])}")
        if report['status'] != 'PASS' and not args.compact:
            for name, detail in report['imports'].items():
                if not detail['ok']:
                    print(f"  {name}: {detail['error']}")
            if report.get('deviceError'):
                print(f"  PortAudio: {report['deviceError']}")
            print('  Read-only repair: powershell -NoProfile -ExecutionPolicy Bypass '
                  '-File tools\\health\\Repair-EveOS-VenvAudio.ps1')
    return 0 if report['status'] == 'PASS' else (2 if report['status'] == 'WARN' else 1)


if __name__ == '__main__':
    raise SystemExit(main())
