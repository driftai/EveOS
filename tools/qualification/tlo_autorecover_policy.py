"""Validation and transactional application of TLO repair proposals."""

from __future__ import annotations

from pathlib import Path

from tlo_autorecover_core import (
    MAX_EDIT_CHARS,
    MAX_EDITS,
    RepairProposalRejected,
    decode,
    encode,
    rel,
)
from tlo_rehearsal_support import ROOT


def validate_plan(
    plan: dict,
    allowed: set[str],
) -> list[dict]:
    if plan.get("classification") != "SAFE_SMALL_RECOVERY":
        raise RepairProposalRejected(
            "Proposal is not SAFE_SMALL_RECOVERY."
        )

    if plan.get("confidence") not in {"medium", "high"}:
        raise RepairProposalRejected(
            "TLO repair confidence is too low."
        )

    if plan.get("rerunSameCommand") is not True:
        raise RepairProposalRejected(
            "TLO SAFE repair did not request same-command rerun."
        )

    raw_edits = plan.get("edits")

    if (
        not isinstance(raw_edits, list)
        or not raw_edits
        or len(raw_edits) > MAX_EDITS
    ):
        raise RepairProposalRejected(
            "TLO returned an invalid edit count."
        )

    total = 0
    edits = []

    for raw in raw_edits:
        if not isinstance(raw, dict):
            raise RepairProposalRejected(
                "Malformed TLO edit."
            )

        relative = rel(
            str(raw.get("path") or "")
        )

        if relative not in allowed:
            raise RepairProposalRejected(
                f"TLO attempted unauthorized path: {relative}"
            )

        old = raw.get("old")
        new = raw.get("new")

        if not isinstance(old, str) or not old:
            raise RepairProposalRejected(
                "TLO edit has invalid old text."
            )

        if not isinstance(new, str):
            raise RepairProposalRejected(
                "TLO edit has invalid new text."
            )

        old = (
            old.replace("\r\r\n", "\r\n")
            .replace("\r", "\r\n")
        )

        new = (
            new.replace("\r\r\n", "\r\n")
            .replace("\r", "\r\n")
        )

        total += len(old) + len(new)

        edits.append({
            "path": relative,
            "old": old,
            "new": new,
        })

    if total > MAX_EDIT_CHARS:
        raise RepairProposalRejected(
            "TLO repair exceeds character budget."
        )

    return edits


def apply_edits(
    edits: list[dict],
    backup_root: Path,
) -> list[str]:
    states = {}
    changed = set()

    for edit in edits:
        relative = edit["path"]
        path = ROOT / relative

        if relative not in states:
            states[relative] = decode(path)

        text, crlf, bom = states[relative]

        count = text.count(edit["old"])

        if count != 1:
            raise RepairProposalRejected(
                f"Exact anchor in {relative} occurs {count} times, not once."
            )

        text = text.replace(
            edit["old"],
            edit["new"],
            1,
        )

        states[relative] = (
            text,
            crlf,
            bom,
        )

        changed.add(relative)

    backup_root.mkdir(
        parents=True,
        exist_ok=True,
    )

    # Only write after every proposed anchor validates.
    for relative in sorted(changed):
        src = ROOT / relative
        dst = backup_root / relative

        dst.parent.mkdir(
            parents=True,
            exist_ok=True,
        )

        dst.write_bytes(
            src.read_bytes()
        )

    for relative, state in states.items():
        encode(
            ROOT / relative,
            *state,
        )

    return sorted(changed)
