"""Immutable, non-repairable local files during an authorized TLO run."""
from __future__ import annotations

import hashlib
from pathlib import Path

from tlo_rehearsal_support import ROOT


def capture(paths: list[str], repair_files: set[str]) -> dict[str, str]:
    result: dict[str, str] = {}
    for raw in paths:
        if not isinstance(raw, str) or not raw or raw.startswith("/") or "\\" in raw:
            raise RuntimeError("Preserved files must be exact repository-relative paths.")
        if any(part in ("", ".", "..") for part in raw.split("/")):
            raise RuntimeError("Preserved file path contains traversal.")
        if raw in repair_files:
            raise RuntimeError("A preserved file cannot also be a TLO repair target.")
        item = ROOT / raw
        if item.is_symlink() or not item.is_file():
            raise RuntimeError("Preserved file is missing or unsafe: " + raw)
        if not item.resolve().is_relative_to(ROOT.resolve()):
            raise RuntimeError("Preserved path escapes EveOS.")
        if item.stat().st_size > 1_000_000:
            raise RuntimeError("Preserved file is larger than the verification budget.")
        result[raw] = hashlib.sha256(item.read_bytes()).hexdigest()
    return result


def verify(digests: dict[str, str]) -> None:
    for raw, expected in digests.items():
        item = ROOT / raw
        if item.is_symlink() or not item.is_file():
            raise RuntimeError("Protected file was removed or replaced: " + raw)
        observed = hashlib.sha256(item.read_bytes()).hexdigest()
        if observed != expected:
            raise RuntimeError("Protected file changed during TLO recovery: " + raw)
