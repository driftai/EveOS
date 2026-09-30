"""Open fixed WatchFusion extension folders from trusted EveOS local control."""

from __future__ import annotations

import os
import subprocess
from pathlib import Path


def _root() -> Path:
    return Path(__file__).resolve().parent.parent


def _folder(package: str) -> Path | None:
    if package == "official":
        return _root() / "extension"
    if package == "watchfusion":
        return _root() / "tools" / "WatchFusion" / "browser-extension"
    return None


def _prepare_official() -> tuple[bool, str]:
    from . import watchfusion_control
    script = _root() / "tools" / "extensions" / "assemble.cjs"
    try:
        result = subprocess.run(
            [watchfusion_control._node(), str(script), "--write"],
            cwd=str(_root()), capture_output=True, text=True, timeout=15,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0) if os.name == "nt" else 0,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        return False, f"Could not prepare the EveOS extension: {error}"
    if result.returncode != 0:
        detail = (result.stderr or result.stdout or "").strip()[-1200:]
        return False, f"Could not prepare the EveOS extension. {detail}".strip()
    return True, ""


def open_extension_folder(package: str = "watchfusion") -> dict:
    folder = _folder(package)
    if folder is None:
        return {"ok": False, "message": "Unknown extension package."}
    if not folder.is_dir():
        return {"ok": False, "message": f"Browser extension folder is missing: {folder}"}
    if package == "official":
        ok, message = _prepare_official()
        if not ok:
            return {"ok": False, "message": message}
    if os.name != "nt":
        return {"ok": True, "path": str(folder), "message": "Extension folder path is ready."}
    try:
        subprocess.Popen(
            ["explorer.exe", str(folder)], cwd=str(_root()),
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except OSError as error:
        return {"ok": False, "message": f"Could not open extension folder: {error}"}
    label = "EveOS extension" if package == "official" else "WatchFusion companion"
    return {"ok": True, "path": str(folder), "message": f"{label} folder opened."}
