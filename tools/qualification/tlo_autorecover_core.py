"""Authority, process, and file primitives for bounded TLO autorecovery."""

from __future__ import annotations

import codecs
import json
import subprocess
import time
from pathlib import Path

from tlo_rehearsal_support import (
    ROOT,
    git_text,
    git_worktree_paths,
    http_json,
    repository_binding,
    validate_live_tlo,
    validate_running_eveos,
)


MAX_EDITS = 4
MAX_EDIT_CHARS = 24000
MAX_WORKER_REPAIRS = 3
MAX_PROPOSALS = 3
MAX_FAILURE_CHARS = 1400
MAX_DIFF_CHARS = 700
MAX_CONTEXT_CHARS = 6000
PER_FILE_CONTEXT = 3000


class RepairProposalRejected(RuntimeError):
    pass


def run(command: list[str], timeout: int = 900) -> dict:
    started = time.monotonic()
    try:
        result = subprocess.run(
            command,
            cwd=str(ROOT),
            text=True,
            capture_output=True,
            errors="replace",
            timeout=timeout,
            check=False,
        )
        return {
            "status": result.returncode,
            "stdout": result.stdout or "",
            "stderr": result.stderr or "",
            "durationMs": round((time.monotonic() - started) * 1000),
            "started": True,
            "failureClass": "process-exit" if result.returncode else None,
        }
    except subprocess.TimeoutExpired as exc:
        return {
            "status": 124,
            "stdout": str(exc.stdout or ""),
            "stderr": str(exc.stderr or exc),
            "durationMs": round((time.monotonic() - started) * 1000),
            "started": True,
            "failureClass": "timeout-outcome-unknown",
        }
    except OSError as exc:
        return {
            "status": 125,
            "stdout": "",
            "stderr": str(exc),
            "durationMs": round((time.monotonic() - started) * 1000),
            "started": False,
            "failureClass": "launch-failure",
        }


def rel(value: str) -> str:
    candidate = (ROOT / value).resolve()
    try:
        return candidate.relative_to(ROOT).as_posix()
    except ValueError as exc:
        raise RuntimeError(
            f"Path escapes repository: {value}"
        ) from exc


def fetch(branch: str) -> None:
    result = run(
        ["git", "fetch", "--quiet", "origin", branch],
        timeout=180,
    )
    if result["status"] != 0:
        raise RuntimeError(
            "Could not fetch origin branch: "
            + (result["stderr"] or result["stdout"])
        )


def authority_guard(
    branch: str,
    expected_head: str,
    allowed_dirty: set[str],
) -> None:
    fetch(branch)

    actual_branch = git_text("branch", "--show-current")
    head = git_text("rev-parse", "HEAD")
    remote = git_text("rev-parse", f"origin/{branch}")

    if actual_branch != branch:
        raise RuntimeError(
            f"Expected branch {branch}, found {actual_branch}."
        )

    if head != expected_head or remote != expected_head:
        raise RuntimeError(
            "HEAD authority changed. "
            f"local={head} remote={remote} expected={expected_head}"
        )

    unexpected = (
        set(git_worktree_paths())
        - allowed_dirty
    )

    if unexpected:
        raise RuntimeError(
            "Unauthorized dirty paths: "
            + ", ".join(sorted(unexpected))
        )


def validate_tlo() -> None:
    binding = repository_binding()

    if binding["status"] != "MATCH":
        raise RuntimeError(
            f"TLO binding mismatch: {binding['mismatches']}"
        )

    code, status = http_json("GET", "/api/status")

    if code >= 400:
        raise RuntimeError(f"EveOS unavailable: HTTP {code}")

    running = validate_running_eveos(
        status,
        binding,
    )

    if running["status"] != "MATCH":
        raise RuntimeError(
            f"Running EveOS mismatch: {running['mismatches']}"
        )

    code, status = http_json(
        "GET",
        "/api/eve-state/modular/tlo/status?scopeId=default",
    )

    if code >= 400:
        raise RuntimeError(f"TLO unavailable: HTTP {code}")

    live = validate_live_tlo(
        status,
        binding,
    )

    if live["status"] != "MATCH":
        raise RuntimeError(
            f"Live TLO mismatch: {live['mismatches']}"
        )


def decode(path: Path) -> tuple[str, bool, bool]:
    raw = path.read_bytes()
    bom = raw.startswith(codecs.BOM_UTF8)

    if bom:
        raw = raw[len(codecs.BOM_UTF8):]

    crlf = b"\r\r\n" in raw

    text = (
        raw.decode("utf-8")
        .replace("\r\r\n", "\r\n")
        .replace("\r", "\r\n")
    )

    return text, crlf, bom


def encode(
    path: Path,
    text: str,
    crlf: bool,
    bom: bool,
) -> None:
    if crlf:
        text = text.replace("\r\n", "\r\r\n")

    raw = text.encode("utf-8")

    if bom:
        raw = codecs.BOM_UTF8 + raw

    path.write_bytes(raw)
def write_json(path: Path, payload: dict) -> None:
    path.parent.mkdir(
        parents=True,
        exist_ok=True,
    )

    path.write_text(
        json.dumps(
            payload,
            indent=2,
            ensure_ascii=False,
        ) + "\r\n",
        encoding="utf-8",
    )
