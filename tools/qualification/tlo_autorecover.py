#!/usr/bin/env python3
"""Bounded, evidence-aware TLO engineering autorecovery.

Deterministic commands own pass/fail truth.
TLO may propose exact text replacements only.
The supervisor validates scope and applies permitted edits.
No TLO-provided shell command or Git command is ever executed.
"""

from __future__ import annotations

import argparse
import codecs
import json
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path

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
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "status": 125,
            "stdout": "",
            "stderr": str(exc),
            "durationMs": round((time.monotonic() - started) * 1000),
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


def terms_from(*values: str) -> list[str]:
    terms: list[str] = []

    for value in values:
        # Backtick identifiers are especially useful.
        terms.extend(
            re.findall(r"`([^`]{3,80})`", value or "")
        )
        terms.extend(
            re.findall(
                r"\b[A-Za-z_$][A-Za-z0-9_$]{4,50}\b",
                value or "",
            )
        )

    blocked = {
        "error", "expected", "actual", "failed",
        "failure", "assertion", "string", "object",
        "repair", "source", "current", "return",
        "without", "seeing", "cannot", "because",
    }

    result: list[str] = []

    for term in terms:
        value = term.strip()

        if (
            not value
            or value.lower() in blocked
            or value in result
        ):
            continue

        result.append(value)

    return result[:24]


def snippet(
    relative: str,
    terms: list[str],
) -> tuple[int, str]:
    path = ROOT / relative

    if not path.is_file():
        return 0, ""

    try:
        text, _, _ = decode(path)
    except Exception:
        return 0, ""

    lower_terms = [
        value.lower()
        for value in terms
        if value
    ]

    if len(text) <= PER_FILE_CONTEXT:
        score = sum(
            text.lower().count(value)
            for value in lower_terms
        )
        return score + 1, text

    lines = text.splitlines()

    best_index = None
    best_score = 0

    for index, line in enumerate(lines):
        lowered = line.lower()
        score = 0

        for term in lower_terms:
            if term not in lowered:
                continue

            score += 2

            # Definitions are better evidence than call sites.
            if (
                f"function {term}" in lowered
                or f"def {term}" in lowered
                or f"const {term}" in lowered
                or f"class {term}" in lowered
            ):
                score += 12

        if score > best_score:
            best_score = score
            best_index = index

    if best_index is None:
        return 0, ""

    first = max(
        0,
        best_index - 16,
    )

    last = min(
        len(lines),
        best_index + 42,
    )

    rendered = "\r\n".join(
        f"{index + 1}: {lines[index]}"
        for index in range(first, last)
    )

    return best_score, rendered[:PER_FILE_CONTEXT]


def evidence_pack(
    paths: list[str],
    failure: str,
    request: str,
    invariants: list[str],
) -> str:
    terms = terms_from(
        failure,
        request,
        "\r\n".join(invariants),
    )

    ranked = []

    for relative in paths:
        score, content = snippet(
            relative,
            terms,
        )

        if content:
            ranked.append(
                (score, relative, content)
            )

    ranked.sort(
        key=lambda item: (-item[0], item[1])
    )

    chunks: list[str] = []

    for _, relative, content in ranked:
        chunk = (
            f"\r\n--- EXACT/RELEVANT SOURCE: {relative} ---\r\n"
            + content
        )

        candidate = "".join(chunks) + chunk

        if len(candidate) > MAX_CONTEXT_CHARS:
            remaining = (
                MAX_CONTEXT_CHARS
                - len("".join(chunks))
            )

            if remaining > 250:
                chunks.append(chunk[:remaining])

            break

        chunks.append(chunk)

    return "".join(chunks)


def current_diff(paths: list[str]) -> str:
    if not paths:
        return ""

    result = run(
        ["git", "diff", "--", *paths],
        timeout=120,
    )

    return (
        result["stdout"] or ""
    )[-MAX_DIFF_CHARS:]


def evidence_deficit(plan: dict) -> bool:
    classification = str(
        plan.get("classification") or ""
    ).strip()

    reason = str(
        plan.get("reason") or ""
    ).lower()

    request = str(
        plan.get("evidenceRequest") or ""
    ).lower()

    combined = reason + "\r\n" + request

    signals = (
        "without seeing",
        "need to see",
        "need full",
        "need the full",
        "not enough context",
        "insufficient context",
        "missing context",
        "source evidence is cut off",
        "source is cut off",
        "source evidence is truncated",
        "source is truncated",
        "cannot safely determine",
        "cannot determine",
        "need implementation",
        "need the implementation",
        "need source",
        "need the source",
        "need evidence",
        "need more evidence",
    )

    if classification == "REQUEST_MORE_EVIDENCE":
        return True

    # A non-empty explicit evidence request wins even when the
    # model accidentally labels itself SAFE_SMALL_RECOVERY.
    if request.strip():
        return True

    return any(
        signal in combined
        for signal in signals
    )


def repair_prompt(
    *,
    command: list[str],
    failure: str,
    repair_files: list[str],
    context_paths: list[str],
    invariants: list[str],
    evidence_request: str,
    attempt: int,
) -> str:
    context = evidence_pack(
        context_paths,
        failure,
        evidence_request,
        invariants,
    )

    diff = current_diff(repair_files)

    prompt = f"""
You are TLO acting as a bounded junior EveOS engineer.

The deterministic engineering command failed.
Tests own pass/fail truth.

You may propose source edits ONLY in:
{json.dumps(repair_files, indent=2)}

You may READ evidence from:
{json.dumps(context_paths, indent=2)}

Authoritative task invariants:
{json.dumps(invariants, indent=2)}

Rules:
- At most {MAX_EDITS} exact text edits.
- `old` must occur exactly once.
- No shell commands.
- No Git commands.
- No branch/history/publication operations.
- Do not broaden scope.
- Never hardcode transient wall-clock output to make a test pass.
- For time-derived behavior, prefer an injected deterministic clock.
- If more evidence is needed, ask for it rather than guessing.
- If the issue is truly architecture/security/destructive/authority-sensitive,
  STOP_FOR_HUMAN.
- Worker repair attempt: {attempt}.

Return EXACTLY one JSON object:
{{
  "classification":
    "SAFE_SMALL_RECOVERY" |
    "REQUEST_MORE_EVIDENCE" |
    "STOP_FOR_HUMAN" |
    "NO_REPAIR",
  "confidence": "low" | "medium" | "high",
  "reason": "concise",
  "evidenceRequest": "specific missing evidence, or empty string",
  "edits": [
    {{
      "path": "authorized repair file",
      "old": "exact current text",
      "new": "replacement"
    }}
  ],
  "rerunSameCommand": true
}}

Relevant source evidence:
{context}

Deterministic failure:
{failure[-MAX_FAILURE_CHARS:]}

Current candidate diff:
{diff}

Previous evidence request/rejection:
{evidence_request[-800:]}
""".strip()

    return prompt[:MAX_PROMPT_CHARS]


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


def main() -> int:
    parser = argparse.ArgumentParser()

    parser.add_argument("--branch", required=True)
    parser.add_argument("--expected-head", required=True)
    parser.add_argument(
        "--allow-dirty-path",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--repair-file",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--context-file",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--invariant",
        action="append",
        default=[],
    )
    parser.add_argument(
        "--max-attempts",
        type=int,
        default=MAX_WORKER_REPAIRS,
    )
    parser.add_argument(
        "command",
        nargs=argparse.REMAINDER,
    )

    args = parser.parse_args()

    command = list(args.command)

    if command and command[0] == "--":
        command = command[1:]

    if not command:
        raise RuntimeError(
            "No worker command supplied."
        )

    if not 1 <= args.max_attempts <= MAX_WORKER_REPAIRS:
        raise RuntimeError(
            "Invalid worker repair budget."
        )

    allowed_dirty = {
        rel(path)
        for path in args.allow_dirty_path
    }

    repair_files = [
        rel(path)
        for path in args.repair_file
    ]

    repair_set = set(repair_files)

    if not repair_set:
        raise RuntimeError(
            "No repair files authorized."
        )

    if not repair_set.issubset(allowed_dirty):
        raise RuntimeError(
            "Repair files must also be allowed dirty paths."
        )

    context_paths = []

    for path in (
        args.context_file
        or repair_files
    ):
        relative = rel(path)

        if relative not in context_paths:
            context_paths.append(relative)

    invariants = [
        str(value).strip()
        for value in args.invariant
        if str(value).strip()
    ]

    run_id = (
        "tlo-autorecover-"
        + time.strftime("%Y%m%dT%H%M%S")
        + "-"
        + uuid.uuid4().hex[:8]
    )

    root = RESULT_DIR / run_id

    receipt = {
        "schema": "eveos.tlo-engineering-autorecovery",
        "schemaVersion": 2,
        "runId": run_id,
        "branch": args.branch,
        "expectedHead": args.expected_head,
        "command": command,
        "repairFiles": repair_files,
        "contextFiles": context_paths,
        "invariants": invariants,
        "attempts": [],
    }

    validate_tlo()

    authority_guard(
        args.branch,
        args.expected_head,
        allowed_dirty,
    )

    for worker_attempt in range(
        args.max_attempts + 1
    ):
        print()
        print("=" * 60)
        print(
            f"TLO AUTORECOVERY WORKER RUN {worker_attempt + 1}"
        )
        print("=" * 60)

        result = run(
            command,
            timeout=1800,
        )

        if result["stdout"]:
            print(
                result["stdout"],
                end="" if result["stdout"].endswith("\r\n") else "\r\n",
            )

        if result["stderr"]:
            print(
                result["stderr"],
                file=sys.stderr,
                end="" if result["stderr"].endswith("\r\n") else "\r\n",
            )

        attempt_record = {
            "run": worker_attempt + 1,
            "exitStatus": result["status"],
            "durationMs": result["durationMs"],
            "proposals": [],
        }

        receipt["attempts"].append(
            attempt_record
        )

        write_json(
            root / "receipt.json",
            receipt,
        )

        if result["status"] == 0:
            receipt["outcome"] = "GREEN"

            write_json(
                root / "receipt.json",
                receipt,
            )

            print()
            print("TLO_AUTORECOVERY GREEN")
            print(
                "RECEIPT "
                + (root / "receipt.json")
                .relative_to(ROOT)
                .as_posix()
            )

            return 0

        head = git_text(
            "rev-parse",
            "HEAD",
        )

        if head != args.expected_head:
            receipt["outcome"] = (
                "STOPPED_AFTER_HEAD_CHANGE"
            )

            write_json(
                root / "receipt.json",
                receipt,
            )

            raise RuntimeError(
                "Worker failed after HEAD changed; autorepair forbidden."
            )

        authority_guard(
            args.branch,
            args.expected_head,
            allowed_dirty,
        )

        if worker_attempt >= args.max_attempts:
            receipt["outcome"] = (
                "WORKER_REPAIR_BUDGET_EXHAUSTED"
            )

            write_json(
                root / "receipt.json",
                receipt,
            )

            raise RuntimeError(
                "Worker repair budget exhausted."
            )

        failure = "\r\n".join(
            value
            for value in (
                result["stdout"],
                result["stderr"],
            )
            if value
        )

        evidence_request = ""
        applied = None
        accepted_plan = None

        for proposal in range(
            1,
            MAX_PROPOSALS + 1,
        ):
            validate_tlo()

            prompt = repair_prompt(
                command=command,
                failure=failure,
                repair_files=repair_files,
                context_paths=context_paths,
                invariants=invariants,
                evidence_request=evidence_request,
                attempt=worker_attempt + 1,
            )

            plan, raw_text, _ = (
                request_tlo_triage(prompt)
            )

            plan_path = (
                root
                / (
                    f"worker-{worker_attempt + 1}"
                    f"-proposal-{proposal}.json"
                )
            )

            proposal_record = {
                "proposal": proposal,
                "classification": plan.get("classification"),
                "confidence": plan.get("confidence"),
                "reason": plan.get("reason"),
                "evidenceRequest": plan.get("evidenceRequest"),
                "plan": plan_path.relative_to(ROOT).as_posix(),
            }

            attempt_record["proposals"].append(
                proposal_record
            )

            write_json(
                plan_path,
                {
                    "plan": plan,
                    "rawText": raw_text[:MAX_PROMPT_CHARS],
                },
            )

            write_json(
                root / "receipt.json",
                receipt,
            )

            print()
            print("---------------- TLO AUTOREPAIR ----------------")
            print("PROPOSAL:      ", proposal)
            print("CLASSIFICATION:", plan.get("classification"))
            print("CONFIDENCE:    ", plan.get("confidence"))
            print("REASON:        ", plan.get("reason"))
            print("------------------------------------------------")

            if evidence_deficit(plan):
                if proposal >= MAX_PROPOSALS:
                    raise RuntimeError(
                        "TLO still lacks evidence after bounded expansion."
                    )

                evidence_request = (
                    str(plan.get("evidenceRequest") or "")
                    + "\r\n"
                    + str(plan.get("reason") or "")
                ).strip()

                print(
                    "TLO requested more evidence; "
                    "rebuilding evidence packet automatically..."
                )

                continue

            if plan.get("classification") != "SAFE_SMALL_RECOVERY":
                raise RuntimeError(
                    "TLO reached a genuine semantic/authority boundary: "
                    f"{plan.get('classification')} — "
                    f"{plan.get('reason', '')}"
                )

            try:
                edits = validate_plan(
                    plan,
                    repair_set,
                )

                applied = apply_edits(
                    edits,
                    root
                    / (
                        f"backup-worker-{worker_attempt + 1}"
                        f"-proposal-{proposal}"
                    ),
                )

                accepted_plan = plan_path
                break

            except RepairProposalRejected as exc:
                rejection = str(exc)

                proposal_record[
                    "rejected"
                ] = rejection

                write_json(
                    root / "receipt.json",
                    receipt,
                )

                if proposal >= MAX_PROPOSALS:
                    raise RuntimeError(
                        "Repair proposal correction budget exhausted."
                    )

                evidence_request = (
                    "Previous bounded repair proposal was safely rejected: "
                    + rejection
                    + "\r\nRe-read the exact current source evidence and "
                    + "return a corrected SAFE_SMALL_RECOVERY JSON plan. "
                    + "Use only authorized paths and exact current old text."
                )

                print(
                    "TLO_REPAIR_PROPOSAL_REJECTED:",
                    rejection,
                )
                print(
                    "Requesting corrected proposal automatically..."
                )

        if not applied or accepted_plan is None:
            raise RuntimeError(
                "No bounded repair was safely applicable."
            )

        authority_guard(
            args.branch,
            args.expected_head,
            allowed_dirty,
        )

        attempt_record["repairPlan"] = (
            accepted_plan.relative_to(ROOT).as_posix()
        )

        attempt_record["repairedFiles"] = applied

        write_json(
            root / "receipt.json",
            receipt,
        )

        print(
            "TLO applied bounded repair to: "
            + ", ".join(applied)
        )
        print(
            "Rerunning the same worker automatically..."
        )

    return 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (RuntimeError, RehearsalError) as exc:
        print(
            f"TLO_AUTORECOVERY_STOP: {exc}",
            file=sys.stderr,
        )
        raise SystemExit(2)
