from __future__ import annotations

import argparse
import contextlib
import hashlib
import http.client
import json
import mimetypes
import os
import re
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import uuid
import webbrowser
import zipfile
from datetime import datetime, timezone
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse
from xml.etree import ElementTree


APP_VERSION = "0.16.0"
SCHEMA_VERSION = 10
SERVER_INSTANCE_ID = uuid.uuid4().hex
BASE_DIR = Path(__file__).resolve().parent
APP_DIR = BASE_DIR / "app"
DATA_DIR = BASE_DIR / "data"
CONFIG_PATH = DATA_DIR / "config.json"
STATE_PATH = DATA_DIR / "state.json"
IMPORTS_DIR = DATA_DIR / "imports"
RECOVERY_UPLOADS_DIR = DATA_DIR / "recovery_uploads"
RECOVERY_ROLLBACKS_DIR = DATA_DIR / "recovery_rollbacks"
RECOVERY_TEMP_DIR = DATA_DIR / "recovery_temp"
NARRATION_DOCUMENTS_DIR = DATA_DIR / "narration_documents"

TEXT_EXTENSIONS = {
    ".txt", ".md", ".markdown", ".json", ".jsonl", ".csv", ".tsv",
    ".html", ".htm", ".css", ".js", ".mjs", ".cjs", ".ts", ".tsx",
    ".jsx", ".py", ".java", ".c", ".cpp", ".h", ".hpp", ".cs",
    ".xml", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".log", ".sql", ".bat", ".cmd", ".ps1", ".sh", ".properties",
    ".gradle", ".gitignore", ".gitattributes"
}
READABLE_EXTENSIONS = TEXT_EXTENSIONS | {".docx"}
NARRATION_EXTENSIONS = {".txt", ".md", ".markdown", ".html", ".htm", ".docx", ".pdf"}
MAX_REQUEST_BYTES = 100 * 1024 * 1024
MAX_RECOVERY_UPLOAD_BYTES = 8 * 1024 * 1024 * 1024
RECOVERY_FORMAT = "eve-os-world-book-full-recovery"
RECOVERY_FORMAT_VERSION = 1
MAX_SINGLE_TEXT_BYTES = 8 * 1024 * 1024
MAX_TOTAL_SNAPSHOT_CHARS = 50_000_000
MAX_TRANSFER_ENTRIES = 5_000
MAX_TRANSFER_CHARS = 30_000_000
MAX_COPY_SCOPE_ENTRIES = 20_000
MAX_COPY_SCOPE_CHARS = 20_000_000


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str) -> str:
    return f"{prefix}-{uuid.uuid4().hex[:16]}"


def atomic_write_json(path: Path, data: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(data, indent=2, ensure_ascii=False), encoding="utf-8")
    temp.replace(path)


def default_virtual_node(kind: str, name: str, status: str = "draft") -> dict:
    timestamp = now_iso()
    return {
        "id": new_id(kind),
        "type": "folder" if kind == "folder" else "file",
        "name": name,
        "status": status,
        "tags": [],
        "sharedTags": [],
        "visibleTags": [],
        "links": [],
        "content": "",
        "open": True,
        "createdAt": timestamp,
        "updatedAt": timestamp,
        "children": [] if kind == "folder" else [],
    }


def default_virtual_root() -> dict:
    root = default_virtual_node("folder", "World Book", "canon")
    root["id"] = "root"
    root["children"] = [
        default_virtual_node("folder", "Characters"),
        default_virtual_node("folder", "World"),
        default_virtual_node("folder", "Systems-and-Powers"),
        default_virtual_node("folder", "Factions"),
        default_virtual_node("folder", "Timeline"),
        default_virtual_node("folder", "Chapter-Summaries"),
        default_virtual_node("folder", "Recovered-Notes", "recovered"),
        default_virtual_node("folder", "Uncertain-Canon", "uncertain"),
    ]
    return root
