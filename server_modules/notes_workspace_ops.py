"""Search, link navigation, and guarded file mutations for EveOS Notes."""

from __future__ import annotations

import os
import shutil
import time
from pathlib import Path


MAX_SEARCH_FILES = 5000
MAX_SEARCH_RESULTS = 200


def _core():
    from . import notes_workspace
    return notes_workspace


def _validate_revision(path: Path, expected: str) -> None:
    core = _core()
    if path.is_file() and expected and core._revision(path) != expected:
        raise RuntimeError("revision-conflict")


def _safe_name(value: str, *, extension: str = "") -> str:
    name = str(value or "").strip()
    if not name or name in {".", ".."} or "/" in name or "\\" in name:
        raise ValueError("Use a valid single file or folder name.")
    if extension and not Path(name).suffix:
        name += extension
    return name


def _remap_state(root_id: str, old_path: str, new_path: str) -> None:
    core = _core()
    state = core._load_state()
    old_key = core._note_key(root_id, old_path)
    new_key = core._note_key(root_id, new_path)

    def remap(value: str) -> str:
        if value == old_key:
            return new_key
        prefix = old_key.rstrip("/") + "/"
        return new_key.rstrip("/") + "/" + value[len(prefix):] if value.startswith(prefix) else value

    state["favorites"] = list(dict.fromkeys(remap(value) for value in state["favorites"]))
    state["recent"] = list(dict.fromkeys(remap(value) for value in state["recent"]))
    links = {}
    for key, values in state["links"].items():
        links[remap(key)] = list(dict.fromkeys(remap(value) for value in values))
    state["links"] = links
    core._save_state(state)


def _drop_state(root_id: str, relative_path: str) -> None:
    core = _core()
    state = core._load_state()
    key = core._note_key(root_id, relative_path)
    prefix = key.rstrip("/") + "/"
    removed = lambda value: value == key or value.startswith(prefix)
    state["favorites"] = [value for value in state["favorites"] if not removed(value)]
    state["recent"] = [value for value in state["recent"] if not removed(value)]
    state["links"] = {
        source: [target for target in targets if not removed(target)]
        for source, targets in state["links"].items() if not removed(source)
    }
    core._save_state(state)


def search(root_id: str, query: str, include_content: bool = True) -> dict:
    core = _core()
    root, _normalized, record = core._resolve(root_id, "")
    needle = str(query or "").strip().casefold()
    if not needle:
        raise ValueError("Enter text to search for.")
    candidates = [root] if root.is_file() else root.rglob("*")
    state = core._load_state()
    results = []
    scanned = 0
    for path in candidates:
        if scanned >= MAX_SEARCH_FILES or len(results) >= MAX_SEARCH_RESULTS:
            break
        if not core._is_note(path) or any(part.startswith(".") for part in path.parts):
            continue
        scanned += 1
        relative = "" if root.is_file() else path.relative_to(core._root_path(record)).as_posix()
        name_match = needle in path.name.casefold()
        content_match = False
        if include_content and not name_match and path.stat().st_size <= core.MAX_TEXT_BYTES:
            try:
                content_match = needle in path.read_text(encoding="utf-8-sig").casefold()
            except (OSError, UnicodeError):
                pass
        if name_match or content_match:
            item = core._entry(path, relative, root_id, state)
            item["match"] = "name" if name_match else "content"
            results.append(item)
    return {"ok": True, "entries": results, "scanned": scanned, "truncated": scanned >= MAX_SEARCH_FILES or len(results) >= MAX_SEARCH_RESULTS}


def related(note_ref: str) -> dict:
    core = _core()
    state = core._load_state()
    refs = list(dict.fromkeys(state["links"].get(note_ref, [])))
    entries = []
    for value in refs:
        try:
            root_id, relative = value.split(":", 1)
            path, normalized, _record = core._resolve(root_id, relative)
            item = core._entry(path, normalized, root_id, state)
            item["rootId"] = root_id
            entries.append(item)
        except (OSError, ValueError):
            entries.append({"noteRef": value, "name": value, "path": "", "kind": "broken", "broken": True})
    return {"ok": True, "entries": entries}


def collection(kind: str) -> dict:
    core = _core()
    if kind not in {"favorites", "recent"}:
        raise ValueError("Unknown Notes collection.")
    state = core._load_state()
    entries = []
    for value in state[kind]:
        try:
            root_id, relative = value.split(":", 1)
            path, normalized, _record = core._resolve(root_id, relative)
            item = core._entry(path, normalized, root_id, state)
            item["rootId"] = root_id
            entries.append(item)
        except (OSError, ValueError):
            continue
    return {"ok": True, "entries": entries, "kind": kind}


def rename(root_id: str, relative_path: str, name: str, revision: str = "") -> dict:
    core = _core()
    target, normalized, record = core._resolve(root_id, relative_path)
    _validate_revision(target, revision)
    clean = _safe_name(name, extension=target.suffix if target.is_file() else "")
    destination = target.with_name(clean).resolve()
    root = core._root_path(record)
    if Path(os.path.commonpath([str(root), str(destination)])) != root or destination.exists():
        raise FileExistsError("The rename target already exists or is outside the Notes root.")
    target.rename(destination)
    next_path = "" if root.is_file() else destination.relative_to(root).as_posix()
    _remap_state(root_id, normalized, next_path)
    return {"ok": True, "path": next_path, "message": f'Renamed to "{clean}".'}


def move(root_id: str, relative_path: str, destination_path: str, revision: str = "") -> dict:
    core = _core()
    target, normalized, record = core._resolve(root_id, relative_path)
    destination, destination_normalized, _ = core._resolve(root_id, destination_path)
    _validate_revision(target, revision)
    if not destination.is_dir():
        raise NotADirectoryError("Choose an existing destination folder.")
    next_target = (destination / target.name).resolve()
    root = core._root_path(record)
    if Path(os.path.commonpath([str(root), str(next_target)])) != root or next_target.exists():
        raise FileExistsError("The move target already exists or is outside the Notes root.")
    if target.is_dir() and target in next_target.parents:
        raise ValueError("A folder cannot be moved inside itself.")
    shutil.move(str(target), str(next_target))
    next_path = next_target.relative_to(root).as_posix()
    _remap_state(root_id, normalized, next_path)
    return {"ok": True, "path": next_path, "folder": destination_normalized, "message": f'Moved "{target.name}".'}


def delete(root_id: str, relative_path: str, confirmation: str, revision: str = "") -> dict:
    core = _core()
    target, normalized, _record = core._resolve(root_id, relative_path)
    _validate_revision(target, revision)
    if confirmation != target.name:
        raise ValueError(f'Type "{target.name}" exactly to confirm deletion.')
    trash = core._project_root() / "data" / "runtime" / "notes-trash" / str(int(time.time() * 1000))
    trash.mkdir(parents=True, exist_ok=False)
    backup = trash / target.name
    shutil.copytree(target, backup) if target.is_dir() else shutil.copy2(target, backup)
    shutil.rmtree(target) if target.is_dir() else target.unlink()
    _drop_state(root_id, normalized)
    return {"ok": True, "backupPath": str(backup), "message": f'Deleted "{target.name}". Recovery copy: {backup}' }
