"""Installation-local proof for explicitly authorized file:// provider PCM capture.

This private JS credential is read by file:// EveOS and must never be served through
localhost HTTP. Store it only in the already-gitignored data/runtime/ directory.
"""
from __future__ import annotations
import hmac
import json
import os
from pathlib import Path
import secrets

ROOT = Path(__file__).resolve().parent.parent
SCRIPT_PATH = ROOT / 'data' / 'runtime' / 'audioflix-provider-file-auth.js'
_PREFIX = 'window.__EveOSProviderFileAuth = '
_KEY = ''


def initialize() -> None:
    """Create once or load the existing key; never overwrite the live server's key.

    Tests and other Python processes may import the bridge while EveOS is running.
    Rotating this file on every import would silently break the live file:// page.
    """
    global _KEY
    SCRIPT_PATH.parent.mkdir(parents=True, exist_ok=True)
    try:
        descriptor = os.open(str(SCRIPT_PATH), os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        pass
    else:
        chosen = secrets.token_urlsafe(48)
        with os.fdopen(descriptor, 'w', encoding='utf-8') as output:
            output.write(_PREFIX + json.dumps(chosen) + ';\n')
    contents = SCRIPT_PATH.read_text(encoding='utf-8')
    if not contents.startswith(_PREFIX) or not contents.endswith(';\n'):
        raise RuntimeError('EveOS private file-capture credential is invalid.')
    try:
        stored = json.loads(contents[len(_PREFIX):-2])
    except (ValueError, TypeError) as exc:
        raise RuntimeError('EveOS private file-capture credential is invalid.') from exc
    if not isinstance(stored, str) or len(stored) < 40:
        raise RuntimeError('EveOS private file-capture credential is invalid.')
    _KEY = stored


def verify(candidate: str) -> bool:
    return bool(candidate and _KEY and hmac.compare_digest(str(candidate), _KEY))


def is_private_static_path(value: str) -> bool:
    return os.path.normcase(os.path.realpath(value)) == os.path.normcase(os.path.realpath(SCRIPT_PATH))
