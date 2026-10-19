#!/usr/bin/env python3
"""User-started disposable failure proving script-side bounded TLO recovery."""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
import uuid
from datetime import datetime, timezone
from pathlib import Path

from tlo_autorecover_core import validate_tlo
from tlo_rehearsal_support import ROOT, git_text, git_worktree_paths

BRANCH = "eve/nexus-machine-spaces"
DOCS = [
    "docs/EVEOS-V0.7.5-DE-MIDDLEMAN-LEDGER.md",
    "docs/NEXUS-PHASE3-AUTONOMOUS-RECOVERY.md",
]
FIXTURE = '''"""Disposable TLO Phase 3 engineering exercise; never run in production."""
def expected_state():
    return "READY"

def observed_state():
    return "BROKEN"

if __name__ == "__main__":
    if observed_state() != expected_state():
        raise SystemExit("TLO_DISPOSABLE_ASSERTION_FAILED expected READY got BROKEN")
    print("TLO_DISPOSABLE_RECOVERY_GREEN")
'''


def checks() -> tuple[str, dict[str, str]]:
    if git_text("branch", "--show-current") != BRANCH:
        raise RuntimeError("STOP: switch to the authorized machine-spaces branch first.")
    head = git_text("rev-parse", "HEAD")
    remote = git_text("ls-remote", "--heads", "origin", BRANCH).split()
    if not remote or remote[0] != head:
        raise RuntimeError("STOP: local HEAD differs from the published remote branch.")
    dirty = set(git_worktree_paths())
    if dirty != set(DOCS):
        raise RuntimeError("STOP: unexpected dirty paths: " + ", ".join(sorted(dirty)))
    hashes = {}
    for name in DOCS:
        path = ROOT / name
        if path.is_symlink() or not path.is_file():
            raise RuntimeError("STOP: protected document is unavailable: " + name)
        hashes[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    validate_tlo()  # readiness check, no inference or machine command
    return head, hashes


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run", action="store_true", help="Execute one controlled failed test and authorize TLO repair")
    options = parser.parse_args()
    head, hashes = checks()
    print("TLO_PHASE3_SCRIPT_PREFLIGHT_GREEN", head, "protected", len(hashes))
    if not options.run:
        print("CHECK_ONLY: no disposable script created, no TLO inference, no job started.")
        return 0

    token = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid.uuid4().hex[:8]
    relative = f"data/runtime/smoke-results/tlo-phase3-disposable-{token}/fixture.py"
    fixture = ROOT / relative
    fixture.parent.mkdir(parents=True, exist_ok=False)
    fixture.write_text(FIXTURE, encoding="utf-8", newline="\n")
    command = [
        sys.executable, "-B", "tools/qualification/eve_run.py",
        "--branch", BRANCH, "--expected-head", head,
        "--repair-file", relative,
        "--context-file", relative,
        "--retry-safety", "idempotent", "--max-attempts", "1",
        "--invariant", "Only change the disposable observed_state result from BROKEN to READY.",
        *[argument for document in DOCS for argument in ("--preserve-file", document)],
        "--", sys.executable, "-B", relative,
    ]
    print("DISPOSABLE_FAILURE_START", relative, flush=True)
    result = subprocess.run(command, cwd=ROOT, check=False)
    for name, digest in hashes.items():
        if hashlib.sha256((ROOT / name).read_bytes()).hexdigest() != digest:
            raise RuntimeError("PROTECTED_WIP_CHANGED: " + name)
    if git_text("rev-parse", "HEAD") != head or set(git_worktree_paths()) != set(DOCS):
        raise RuntimeError("REPO_STATE_CHANGED: inspect before proceeding; do not replay")
    if result.returncode != 0:
        print("TLO_DISPOSABLE_RECOVERY_STOP: inspect the unique receipt. Do not blindly rerun.")
        return result.returncode
    print("TLO_PHASE3_SCRIPT_RECOVERY_GREEN", relative, "protected=2/2", "NO_COMMIT NO_PUSH")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, RuntimeError, ValueError) as error:
        print("TLO_PHASE3_DISPOSABLE_SAFE_STOP:", error, file=sys.stderr)
        raise SystemExit(1)
