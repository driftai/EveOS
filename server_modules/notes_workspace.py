"""Filesystem-backed Notes workspace for local EveOS surfaces."""

from __future__ import annotations

import base64
import binascii
import io
import json
import os
import secrets
import zipfile
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urlparse

from . import gemini_control, notes_workspace_ops


NOTE_EXTENSIONS = {".txt", ".md"}
MAX_TEXT_BYTES = 2 * 1024 * 1024
MAX_ARCHIVE_BYTES = 12 * 1024 * 1024
MAX_REQUEST_BYTES = 18 * 1024 * 1024
MAX_ARCHIVE_MEMBERS = 2000
MAX_ARCHIVE_EXPANDED_BYTES = 64 * 1024 * 1024
SPATIAL_ROOT_ID = "spatial"


def _project_root() -> Path:
    return Path(__file__).resolve().parent.parent


def _spatial_root() -> Path:
    root = _project_root() / "data" / "spatial-notes"
    root.mkdir(parents=True, exist_ok=True)
    return root.resolve()


def _state_path() -> Path:
    return _project_root() / "data" / "runtime" / "notes-workspace.json"


def _default_state() -> dict:
    return {"version": 1, "tracked": [], "favorites": [], "recent": [], "links": {}}


def _load_state() -> dict:
    try:
        payload = json.loads(_state_path().read_text(encoding="utf-8"))
        if not isinstance(payload, dict):
            raise ValueError
    except (OSError, ValueError, TypeError):
        payload = _default_state()
    payload.setdefault("tracked", [])
    payload.setdefault("favorites", [])
    payload.setdefault("recent", [])
    payload.setdefault("links", {})
    return payload


def _save_state(state: dict) -> None:
    path = _state_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(".tmp")
    temporary.write_text(json.dumps(state, indent=2, ensure_ascii=False), encoding="utf-8")
    temporary.replace(path)


def _root_record(root_id: str, state: dict | None = None) -> dict:
    if root_id == SPATIAL_ROOT_ID:
        return {"id": SPATIAL_ROOT_ID, "name": "Spatial Notes", "path": str(_spatial_root()), "kind": "folder", "spatial": True}
    state = state or _load_state()
    for record in state["tracked"]:
        if str(record.get("id")) == root_id:
            return record
    raise FileNotFoundError("Tracked note location was not found.")


def _root_path(record: dict) -> Path:
    path = Path(str(record.get("path") or "")).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Tracked path no longer exists: {path}")
    return path


def _resolve(root_id: str, relative_path: str = "") -> tuple[Path, str, dict]:
    record = _root_record(root_id)
    root = _root_path(record)
    relative = str(relative_path or "").replace("\\", "/").strip("/")
    if root.is_file():
        if relative and relative != root.name:
            raise PermissionError("Path is outside the tracked note file.")
        return root, "", record
    target = (root / relative).resolve()
    try:
        common = Path(os.path.commonpath([str(root), str(target)]))
    except ValueError as exc:
        raise PermissionError("Path is outside the tracked note location.") from exc
    if common != root:
        raise PermissionError("Path is outside the tracked note location.")
    normalized = "" if target == root else target.relative_to(root).as_posix()
    return target, normalized, record


def _is_note(path: Path) -> bool:
    return path.is_file() and path.suffix.lower() in NOTE_EXTENSIONS


def _revision(path: Path) -> str:
    stat = path.stat()
    return f"{stat.st_mtime_ns}:{stat.st_size}"


def _note_key(root_id: str, relative_path: str) -> str:
    return f"{root_id}:{relative_path}"


def _entry(path: Path, relative_path: str, root_id: str, state: dict) -> dict:
    key = _note_key(root_id, relative_path)
    stat = path.stat()
    return {
        "name": path.name,
        "path": relative_path,
        "kind": "folder" if path.is_dir() else "file",
        "extension": path.suffix.lower(),
        "size": stat.st_size if path.is_file() else None,
        "modifiedAt": datetime.fromtimestamp(stat.st_mtime, timezone.utc).isoformat(),
        "revision": _revision(path),
        "favorite": key in state["favorites"],
        "linkCount": len(state["links"].get(key, [])),
        "noteRef": key if path.is_file() else "",
    }


def workspace() -> dict:
    state = _load_state()
    roots = [_root_record(SPATIAL_ROOT_ID, state)]
    for record in state["tracked"]:
        item = dict(record)
        item["available"] = Path(str(item.get("path") or "")).expanduser().exists()
        roots.append(item)
    return {"ok": True, "roots": roots, "spatialRoot": str(_spatial_root())}


def track(path_value: str) -> dict:
    if not str(path_value or "").strip():
        raise ValueError("Enter a note file or folder path.")
    path = Path(path_value).expanduser().resolve()
    if not path.exists():
        raise FileNotFoundError(f"Note path does not exist: {path}")
    if path.is_file() and path.suffix.lower() not in NOTE_EXTENSIONS:
        raise ValueError("Tracked files must use .txt or .md.")
    state = _load_state()
    existing = next((item for item in state["tracked"] if Path(item["path"]).resolve() == path), None)
    if existing:
        return {"ok": True, "root": existing, "message": "That note location is already tracked."}
    record = {"id": secrets.token_hex(6), "name": path.name, "path": str(path), "kind": "folder" if path.is_dir() else "file"}
    state["tracked"].append(record)
    _save_state(state)
    return {"ok": True, "root": record, "message": "Note location added."}


def untrack(root_id: str) -> dict:
    if root_id == SPATIAL_ROOT_ID:
        raise ValueError("Spatial Notes is a permanent EveOS workspace.")
    state = _load_state()
    before = len(state["tracked"])
    state["tracked"] = [item for item in state["tracked"] if str(item.get("id")) != root_id]
    if len(state["tracked"]) == before:
        raise FileNotFoundError("Tracked note location was not found.")
    prefix = f"{root_id}:"
    state["favorites"] = [key for key in state["favorites"] if not key.startswith(prefix)]
    state["links"] = {key: [value for value in values if not value.startswith(prefix)] for key, values in state["links"].items() if not key.startswith(prefix)}
    _save_state(state)
    return {"ok": True, "message": "Tracked location removed. No files were deleted."}


def list_entries(root_id: str, relative_path: str, include_markdown: bool) -> dict:
    target, normalized, record = _resolve(root_id, relative_path)
    state = _load_state()
    if target.is_file():
        entries = [_entry(target, "", root_id, state)]
    else:
        entries = []
        for child in target.iterdir():
            if child.name.startswith(".") or (child.is_file() and child.suffix.lower() not in NOTE_EXTENSIONS):
                continue
            if child.is_file() and child.suffix.lower() == ".md" and not include_markdown:
                continue
            try:
                relative = child.relative_to(_root_path(record)).as_posix()
                entries.append(_entry(child, relative, root_id, state))
            except (OSError, PermissionError):
                continue
        entries.sort(key=lambda item: (item["kind"] != "folder", not item["favorite"], item["name"].casefold()))
    return {"ok": True, "rootId": root_id, "path": normalized, "entries": entries}


def read_note(root_id: str, relative_path: str) -> dict:
    target, normalized, _record = _resolve(root_id, relative_path)
    if not _is_note(target):
        raise ValueError("Select a .txt or .md note file.")
    if target.stat().st_size > MAX_TEXT_BYTES:
        raise ValueError("This note is too large to edit in EveOS.")
    state = _load_state()
    key = _note_key(root_id, normalized)
    state["recent"] = [key, *[value for value in state["recent"] if value != key]][:50]
    _save_state(state)
    return {"ok": True, "entry": _entry(target, normalized, root_id, state), "content": target.read_text(encoding="utf-8-sig")}


def write_note(root_id: str, relative_path: str, content: str, expected_revision: str) -> tuple[dict, int]:
    target, normalized, _record = _resolve(root_id, relative_path)
    if not _is_note(target):
        raise ValueError("Only .txt and .md notes can be saved.")
    current_revision = _revision(target)
    if expected_revision and expected_revision != current_revision:
        return {"ok": False, "conflict": True, "revision": current_revision, "message": "This note changed on disk. Revert to review it before saving."}, 409
    encoded = content.encode("utf-8")
    if len(encoded) > MAX_TEXT_BYTES:
        raise ValueError("This note is too large to save in EveOS.")
    temporary = target.with_name(target.name + ".eve-notes-tmp")
    temporary.write_bytes(encoded)
    temporary.replace(target)
    return {"ok": True, "entry": _entry(target, normalized, root_id, _load_state()), "message": "Note saved to disk."}, 200


def create_entry(root_id: str, parent_path: str, name: str, kind: str) -> dict:
    parent, _normalized, _record = _resolve(root_id, parent_path)
    if not parent.is_dir():
        raise NotADirectoryError("Choose a folder before creating a note.")
    clean = str(name or "").strip()
    if not clean or clean in {".", ".."} or "/" in clean or "\\" in clean:
        raise ValueError("Use a valid single file or folder name.")
    if kind not in {"file", "folder"}:
        raise ValueError("Entry kind must be file or folder.")
    if kind == "file" and Path(clean).suffix.lower() not in NOTE_EXTENSIONS:
        clean += ".txt"
    target = (parent / clean).resolve()
    _resolve(root_id, target.relative_to(_root_path(_root_record(root_id))).as_posix())
    if target.exists():
        raise FileExistsError(f'"{clean}" already exists.')
    target.mkdir() if kind == "folder" else target.write_text("", encoding="utf-8")
    return {"ok": True, "message": f"{('Folder' if kind == 'folder' else 'Note')} created."}


def toggle_favorite(root_id: str, relative_path: str) -> dict:
    target, normalized, _record = _resolve(root_id, relative_path)
    if not _is_note(target):
        raise ValueError("Only note files can be favorited.")
    state = _load_state()
    key = _note_key(root_id, normalized)
    favorite = key not in state["favorites"]
    state["favorites"] = ([*state["favorites"], key] if favorite else [item for item in state["favorites"] if item != key])
    _save_state(state)
    return {"ok": True, "favorite": favorite}


def link_notes(source_ref: str, target_ref: str) -> dict:
    if ":" not in source_ref or ":" not in target_ref:
        raise ValueError("Use two different EveOS note references.")
    canonical = []
    for note_ref in (source_ref, target_ref):
        root_id, relative = note_ref.split(":", 1)
        target, normalized, _record = _resolve(root_id, relative)
        if not _is_note(target):
            raise ValueError("Both note references must point to existing notes.")
        canonical.append(_note_key(root_id, normalized))
    source_ref, target_ref = canonical
    if source_ref == target_ref:
        raise ValueError("Use two different EveOS note references.")
    state = _load_state()
    for left, right in ((source_ref, target_ref), (target_ref, source_ref)):
        values = state["links"].setdefault(left, [])
        if right not in values:
            values.append(right)
    _save_state(state)
    return {"ok": True, "links": state["links"].get(source_ref, [])}


def export_spatial() -> dict:
    root = _spatial_root()
    memory = io.BytesIO()
    with zipfile.ZipFile(memory, "w", zipfile.ZIP_DEFLATED) as archive:
        for path in root.rglob("*"):
            if path.is_file() and path.suffix.lower() in NOTE_EXTENSIONS:
                archive.write(path, path.relative_to(root).as_posix())
    raw = memory.getvalue()
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise ValueError("Spatial Notes backup is too large for browser export.")
    return {"ok": True, "filename": f"EveOS-Spatial-Notes-{datetime.now().date().isoformat()}.zip", "base64": base64.b64encode(raw).decode("ascii")}


def import_spatial(encoded: str) -> dict:
    raw = base64.b64decode(encoded, validate=True)
    if len(raw) > MAX_ARCHIVE_BYTES:
        raise ValueError("Spatial Notes backup is too large.")
    root = _spatial_root()
    imported = 0
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        members = archive.infolist()
        if len(members) > MAX_ARCHIVE_MEMBERS:
            raise ValueError("Spatial Notes backup contains too many files.")
        expanded = sum(max(0, member.file_size) for member in members)
        if expanded > MAX_ARCHIVE_EXPANDED_BYTES:
            raise ValueError("Spatial Notes backup expands beyond the safe import limit.")
        for member in members:
            relative = Path(member.filename.replace("\\", "/"))
            if member.is_dir() or relative.is_absolute() or ".." in relative.parts or relative.suffix.lower() not in NOTE_EXTENSIONS:
                continue
            target = (root / relative).resolve()
            if Path(os.path.commonpath([str(root), str(target)])) != root:
                continue
            target.parent.mkdir(parents=True, exist_ok=True)
            if target.exists():
                counter = 1
                while target.exists():
                    suffix = " (imported)" if counter == 1 else f" (imported {counter})"
                    target = (root / relative).with_name(f"{relative.stem}{suffix}{relative.suffix}")
                    counter += 1
            data = archive.read(member)
            if len(data) > MAX_TEXT_BYTES:
                continue
            data.decode("utf-8-sig")
            target.write_bytes(data)
            imported += 1
    return {"ok": True, "imported": imported, "message": f"Imported {imported} note files."}


def _read_body(handler) -> dict:
    length = int(handler.headers.get("Content-Length", "0") or 0)
    if length > MAX_REQUEST_BYTES:
        raise ValueError("Notes request is too large.")
    payload = json.loads(handler.rfile.read(length).decode("utf-8") if length else "{}")
    if not isinstance(payload, dict):
        raise ValueError("Request body must be an object.")
    return payload


def _send(handler, payload: dict, status: int = 200) -> bool:
    gemini_control.send_json(handler, payload, status)
    return True


def _allowed(handler) -> bool:
    return gemini_control.request_can_control(handler)


def handle_get_request(handler, path: str) -> bool:
    if path not in {"/api/notes/workspace", "/api/notes/export"}:
        return False
    if not _allowed(handler):
        return _send(handler, {"ok": False, "message": "Notes files are available only to local EveOS pages."}, 403)
    try:
        return _send(handler, workspace() if path.endswith("workspace") else export_spatial())
    except (OSError, ValueError, zipfile.BadZipFile) as exc:
        return _send(handler, {"ok": False, "message": str(exc)}, 400)


def handle_post_request(handler, path: str) -> bool:
    if not path.startswith("/api/notes/"):
        return False
    if not _allowed(handler):
        return _send(handler, {"ok": False, "message": "Notes files are available only to local EveOS pages."}, 403)
    try:
        body = _read_body(handler)
        actions = {
            "/api/notes/track": lambda: track(str(body.get("path") or "")),
            "/api/notes/untrack": lambda: untrack(str(body.get("rootId") or "")),
            "/api/notes/list": lambda: list_entries(str(body.get("rootId") or ""), str(body.get("path") or ""), body.get("includeMarkdown") is True),
            "/api/notes/read": lambda: read_note(str(body.get("rootId") or ""), str(body.get("path") or "")),
            "/api/notes/create": lambda: create_entry(str(body.get("rootId") or ""), str(body.get("path") or ""), str(body.get("name") or ""), str(body.get("kind") or "file")),
            "/api/notes/favorite": lambda: toggle_favorite(str(body.get("rootId") or ""), str(body.get("path") or "")),
            "/api/notes/link": lambda: link_notes(str(body.get("source") or ""), str(body.get("target") or "")),
            "/api/notes/import": lambda: import_spatial(str(body.get("base64") or "")),
            "/api/notes/search": lambda: notes_workspace_ops.search(str(body.get("rootId") or ""), str(body.get("query") or ""), body.get("includeContent") is not False),
            "/api/notes/related": lambda: notes_workspace_ops.related(str(body.get("noteRef") or "")),
            "/api/notes/collection": lambda: notes_workspace_ops.collection(str(body.get("kind") or "favorites")),
            "/api/notes/rename": lambda: notes_workspace_ops.rename(str(body.get("rootId") or ""), str(body.get("path") or ""), str(body.get("name") or ""), str(body.get("revision") or "")),
            "/api/notes/move": lambda: notes_workspace_ops.move(str(body.get("rootId") or ""), str(body.get("path") or ""), str(body.get("destination") or ""), str(body.get("revision") or "")),
            "/api/notes/delete": lambda: notes_workspace_ops.delete(str(body.get("rootId") or ""), str(body.get("path") or ""), str(body.get("confirmation") or ""), str(body.get("revision") or "")),
        }
        if path == "/api/notes/write":
            payload, status = write_note(str(body.get("rootId") or ""), str(body.get("path") or ""), str(body.get("content") or ""), str(body.get("revision") or ""))
            return _send(handler, payload, status)
        action = actions.get(path)
        if not action:
            return False
        return _send(handler, action())
    except RuntimeError as exc:
        if str(exc) == "revision-conflict":
            return _send(handler, {"ok": False, "conflict": True, "message": "This note changed on disk."}, 409)
        return _send(handler, {"ok": False, "message": str(exc)}, 400)
    except (OSError, ValueError, TypeError, json.JSONDecodeError, zipfile.BadZipFile, binascii.Error) as exc:
        return _send(handler, {"ok": False, "message": str(exc)}, 400)
