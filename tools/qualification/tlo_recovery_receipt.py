"""Shared lifecycle and retry contract for TLO engineering recovery."""

from __future__ import annotations

from datetime import datetime, timezone


STATES = {
    "CREATED", "PREFLIGHT", "DISPATCHED", "FAILURE_CONFIRMED",
    "TRIAGING", "REPAIR_PROPOSED", "PATCH_APPLIED", "VERIFYING",
    "GREEN", "FAILED", "AWAITING_APPROVAL", "OUTCOME_UNKNOWN",
}
RETRY_SAFETY = {"never", "launch-only", "idempotent"}


def transition(receipt: dict, state: str, **details) -> dict:
    if state not in STATES:
        raise RuntimeError(f"Unknown recovery state: {state}")
    at = datetime.now(timezone.utc).isoformat()
    receipt["state"] = state
    receipt.setdefault("events", []).append({"state": state, "at": at, **details})
    return receipt


def retry_disposition(policy: str, result: dict) -> tuple[bool, str]:
    if policy not in RETRY_SAFETY:
        return False, "AWAITING_APPROVAL"
    if result.get("failureClass") == "timeout-outcome-unknown":
        return False, "OUTCOME_UNKNOWN"
    if policy == "idempotent":
        return True, "RETRY_ELIGIBLE"
    if policy == "launch-only" and result.get("started") is False:
        return True, "RETRY_ELIGIBLE"
    return False, "AWAITING_APPROVAL"


def create_receipt(*, run_id: str, branch: str, expected_head: str,
                   command: list[str], repair_files: list[str],
                   context_files: list[str], invariants: list[str],
                   retry_safety: str) -> dict:
    receipt = {
        "schema": "eveos.tlo-engineering-autorecovery",
        "schemaVersion": 3,
        "runId": run_id,
        "branch": branch,
        "expectedHead": expected_head,
        "command": command,
        "repairFiles": repair_files,
        "contextFiles": context_files,
        "invariants": invariants,
        "retrySafety": retry_safety,
        "attempts": [],
        "events": [],
    }
    return transition(receipt, "CREATED")
