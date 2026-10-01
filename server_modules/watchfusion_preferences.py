"""Persist the explicit WatchFusion lifecycle preference."""

from __future__ import annotations

import json
import time
from pathlib import Path


def write_desired(root: Path, port: int, enabled: bool) -> None:
    path = root / "data" / "runtime" / "watchfusion-service.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps({
        "desiredRunning": bool(enabled),
        "port": port,
        "updatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
    }, indent=2), encoding="utf-8")
    temporary.replace(path)
