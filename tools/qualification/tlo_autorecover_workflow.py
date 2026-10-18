"""CLI workflow orchestration for bounded TLO autorecovery."""

from __future__ import annotations

import argparse
import sys
import time
import uuid

from tlo_autorecover_core import (
    MAX_PROPOSALS,
    MAX_WORKER_REPAIRS,
    RepairProposalRejected,
    authority_guard,
    rel,
    run,
    validate_tlo,
    write_json,
)
from tlo_autorecover_evidence import evidence_deficit, repair_prompt
from tlo_autorecover_policy import apply_edits, validate_plan
from tlo_rehearsal_support import (
    MAX_PROMPT_CHARS,
    RESULT_DIR,
    ROOT,
    git_text,
    request_tlo_triage,
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
            authority_guard(args.branch, args.expected_head, allowed_dirty)
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
