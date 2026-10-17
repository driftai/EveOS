#!/usr/bin/env python3
"""Bounded, evidence-aware TLO engineering autorecovery.

This compatibility facade preserves the original import and CLI surface while
responsibility-specific modules own authority, evidence, policy, and workflow.
"""

from __future__ import annotations

import sys

from tlo_autorecover_core import (
    MAX_CONTEXT_CHARS,
    MAX_DIFF_CHARS,
    MAX_EDITS,
    MAX_EDIT_CHARS,
    MAX_FAILURE_CHARS,
    MAX_PROPOSALS,
    MAX_WORKER_REPAIRS,
    PER_FILE_CONTEXT,
    RepairProposalRejected,
    authority_guard,
    decode,
    encode,
    fetch,
    rel,
    run,
    validate_tlo,
    write_json,
)
from tlo_autorecover_evidence import (
    current_diff,
    evidence_deficit,
    evidence_pack,
    repair_prompt,
    snippet,
    terms_from,
)
from tlo_autorecover_policy import apply_edits, validate_plan
from tlo_autorecover_workflow import main
from tlo_rehearsal_support import (
    MAX_PROMPT_CHARS,
    RESULT_DIR,
    ROOT,
    RehearsalError,
    git_text,
    git_worktree_paths,
    http_json,
    repository_binding,
    request_tlo_triage,
    validate_live_tlo,
    validate_running_eveos,
)


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, RehearsalError) as exc:
        print(
            f"TLO_AUTORECOVERY_STOP: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(2)
