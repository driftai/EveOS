"""Read-only tracked Markdown catalog with private, revision-checked local overrides.

Browsing a document never grants an agent access to it. Only the explicit
TLO Nexus guide is included in TLO's next-turn context.
"""
from __future__ import annotations

import hashlib
import os
import subprocess
import tempfile
import threading
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OVERRIDES = ROOT / "data" / "runtime" / "agent-management" / "documents"
GUIDE = "config/agents/tlo/NEXUS.md"
AGENT = "config/agents/tlo/AGENT.md"
MAX_CHARS = 64000
_LOCK = threading.RLock()


class DocumentError(ValueError):
    pass


def _tracked() -> list[str]:
    try:
        result = subprocess.run(["git", "ls-files", "-z", "--", "*.md", "**/*.md"],
                                cwd=ROOT, capture_output=True, check=True)
        names = result.stdout.decode("utf-8").split("\0")
    except (OSError, UnicodeError, subprocess.CalledProcessError) as exc:
        raise DocumentError("The tracked Markdown catalog is unavailable.") from exc
    return sorted({name.replace("\\", "/") for name in names
                   if name.endswith(".md") and not name.startswith("data/")})


def _seed(name: str) -> Path:
    if not isinstance(name, str) or name not in _tracked():
        raise DocumentError("Select a tracked Markdown document from the library.")
    candidate = ROOT / name
    if candidate.is_symlink() or not candidate.is_file():
        raise DocumentError("This document is not a regular tracked file.")
    resolved = candidate.resolve()
    if not resolved.is_relative_to(ROOT.resolve()):
        raise DocumentError("Document path leaves EveOS.")
    if candidate.stat().st_size > MAX_CHARS * 4:
        raise DocumentError("This document exceeds the safe reading limit.")
    return candidate


def _private(name: str) -> Path:
    return OVERRIDES / name


def _revision(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:24]


def catalog() -> list[dict]:
    result = []
    for name in _tracked():
        try:
            path = _seed(name)
        except DocumentError:
            continue
        group = "/".join(name.split("/")[:-1]) or "Repository root"
        result.append({"path": name, "group": group, "title": path.stem,
                       "hasOverride": _private(name).is_file()})
    return result


def read(name: str) -> dict:
    seed = _seed(name)
    if name == AGENT:
        from server_modules import agent_management_store, tlo_definition
        store, _ = agent_management_store.load_store()
        agent = next((a for a in store["agents"] if a["id"] == "tlo"), None)
        value = tlo_definition.load(agent)
        text, source = value["text"], value["source"]
    else:
        override = _private(name)
        source = "private-override" if override.is_file() else "tracked"
        path = override if source == "private-override" else seed
        if path.is_symlink() or not path.is_file() or path.stat().st_size > MAX_CHARS * 4:
            raise DocumentError("This document cannot be read safely.")
        try:
            text = path.read_text(encoding="utf-8")
        except (OSError, UnicodeError) as exc:
            raise DocumentError("Document is not valid UTF-8.") from exc
    if len(text) > MAX_CHARS:
        raise DocumentError("Document exceeds the safe reading limit.")
    return {"path": name, "text": text, "revision": _revision(text),
            "source": source, "editable": True}


def _atomic(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, temp = tempfile.mkstemp(prefix="document-", suffix=".tmp", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
            stream.flush()
            os.fsync(stream.fileno())
        if path.is_file():
            backup = path.with_name(path.name + ".backup")
            backup.write_bytes(path.read_bytes())
        os.replace(temp, path)
    finally:
        if os.path.exists(temp):
            os.unlink(temp)


def save(name: str, text: str, expected_revision: str) -> dict:
    if not isinstance(text, str) or not text.strip() or len(text) > MAX_CHARS or "\0" in text:
        raise DocumentError(f"Provide a Markdown document of 1–{MAX_CHARS} characters.")
    if not isinstance(expected_revision, str) or len(expected_revision) != 24:
        raise DocumentError("A document revision is required before saving.")
    with _LOCK:
        current = read(name)
        if current["revision"] != expected_revision:
            raise DocumentError("This document changed. Refresh before saving; no edit was written.")
        normalized = text.replace("\r\n", "\n").replace("\r", "\n")
        if name == AGENT:
            from server_modules import tlo_definition
            tlo_definition.save(normalized)
        else:
            _atomic(_private(name), normalized)
        return read(name)


def tlo_guide() -> dict:
    return read(GUIDE)
