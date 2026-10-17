#!/usr/bin/env python3
"""Run the first bounded Gemini retry qualification with version-bound TLO triage."""

from __future__ import annotations

import argparse
import json
import sys
import uuid
from datetime import datetime, timezone

from tlo_rehearsal_support import (
    MAX_PROMPT_CHARS,
    RESULT_DIR,
    ROOT,
    RehearsalError,
    bounded_lines,
    git_preflight,
    git_text,
    git_worktree_paths,
    http_json,
    local_web_fingerprint,
    repository_binding,
    request_tlo_triage,
    run_process,
    worktree_digest,
    safe_test_path,
    triage_prompt,
    validate_live_tlo,
    validate_running_eveos,
)


DEFAULT_BRANCH = "eve/nexus-machine-spaces"
DEFAULT_TEST = "tools/Nexus-Browser/tests/gemini-background-poll-delivery-retry.test.js"


def utc_now() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def write_json(path, payload: dict) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(payload, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def self_test() -> None:
    binding = repository_binding()
    if binding["status"] != "MATCH":
        raise RehearsalError(f"Repository TLO binding mismatch: {binding['mismatches']}", state="VERSION_MISMATCH")

    fingerprint = local_web_fingerprint()
    if len(fingerprint) != 64:
        raise RehearsalError(
            "Local EveOS web fingerprint self-test returned an invalid digest.",
            state="SELF_TEST_FAILED",
        )

    fake_tlo = {
        "state": "ready",
        "canChat": True,
        "agent": {
            "provider": binding["expected"]["provider"],
            "configuredModelId": "",
            "activeModelId": binding["expected"]["runtime"]["modelId"],
            "definition": {"source": "starter-file", "revision": binding["expected"]["profileSeedRevision"]},
        },
        "localMoe": {"state": "running", "runtimeReady": True, "owned": True},
    }
    if validate_live_tlo(fake_tlo, binding)["status"] != "MATCH":
        raise RehearsalError("Matching synthetic TLO status was rejected.", state="SELF_TEST_FAILED")

    fake_eveos = {
        "service": "eveos-local-server",
        "version": binding["expected"]["serverStatusVersion"],
        "port": 8765,
        "instanceId": "self-test-instance",
        "sourceFingerprint": "self-test-fingerprint",
    }
    if validate_running_eveos(fake_eveos, binding, expected_fingerprint="self-test-fingerprint")["status"] != "MATCH":
        raise RehearsalError("Matching synthetic running EveOS identity was rejected.", state="SELF_TEST_FAILED")

    fake_eveos["version"] = "wrong-version"
    if validate_running_eveos(fake_eveos, binding, expected_fingerprint="self-test-fingerprint")["status"] != "VERSION_MISMATCH":
        raise RehearsalError("Mismatched synthetic EveOS version was accepted.", state="SELF_TEST_FAILED")

    fake_tlo["agent"]["activeModelId"] = "wrong-model"
    if validate_live_tlo(fake_tlo, binding)["status"] != "VERSION_MISMATCH":
        raise RehearsalError("Mismatched synthetic TLO model was accepted.", state="SELF_TEST_FAILED")
    print("TLO_HANDOFF_REHEARSAL_SELF_TEST_OK")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--branch", default=DEFAULT_BRANCH)
    parser.add_argument("--test", default=DEFAULT_TEST)
    parser.add_argument("--self-test", action="store_true")
    parser.add_argument("--allow-detached", action="store_true")
    parser.add_argument(
        "--allow-dirty-path",
        action="append",
        default=[],
        help="Permit only this exact dirty repository path during candidate triage; repeat as needed.",
    )
    args = parser.parse_args()
    if args.self_test:
        self_test()
        return 0

    binding = repository_binding()
    if binding["status"] != "MATCH":
        raise RehearsalError(
            f"EveOS/TLO repository binding mismatch: {binding['mismatches']}",
            state="VERSION_MISMATCH",
        )
    git_state = git_preflight(
        args.branch,
        allow_detached=args.allow_detached,
        allowed_dirty_paths=args.allow_dirty_path or None,
    )
    test_path = safe_test_path(args.test)

    eveos_status_code, eveos_status = http_json("GET", "/api/status")
    if eveos_status_code >= 400:
        raise RehearsalError(
            f"Running EveOS status failed ({eveos_status_code}): {eveos_status}", state="UNAVAILABLE"
        )
    running_eveos = validate_running_eveos(eveos_status, binding)
    if running_eveos["status"] != "MATCH":
        raise RehearsalError(
            f"Running EveOS does not match this checkout/binding: {running_eveos['mismatches']}",
            state="VERSION_MISMATCH",
        )

    status_code, status = http_json("GET", "/api/eve-state/modular/tlo/status?scopeId=default")
    if status_code >= 400:
        raise RehearsalError(f"Running EveOS TLO status failed ({status_code}): {status}", state="UNAVAILABLE")
    live_tlo = validate_live_tlo(status, binding)
    if live_tlo["status"] != "MATCH":
        raise RehearsalError(
            f"Running TLO does not match EveOS binding: {live_tlo['mismatches']}",
            state="VERSION_MISMATCH",
        )

    run_id = (
        f"tlo-rehearsal-{datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')}-"
        f"{uuid.uuid4().hex[:8]}"
    )
    started_at = utc_now()
    test = run_process(["node", "--test", str(test_path)], timeout=300)
    post_head = git_text("rev-parse", "HEAD")
    post_worktree = git_text("status", "--short")
    post_worktree_paths = git_worktree_paths()
    post_candidate_digest = worktree_digest(post_worktree_paths)
    candidate_unchanged = (
        post_worktree_paths == git_state.get("worktreePaths", [])
        and post_candidate_digest == git_state.get("candidateDigest")
    )
    combined = "\n".join(part for part in (test["stdout"], test["stderr"], test["error"]) if part)
    test_record = {
        "path": test_path.relative_to(ROOT).as_posix(),
        "status": test["status"],
        "durationMs": test["durationMs"],
        "importantLines": bounded_lines(combined),
    }
    receipt = {
        "schema": "eveos.tlo-engineering-rehearsal",
        "schemaVersion": 1,
        "runId": run_id,
        "startedAt": started_at,
        "completedAt": utc_now(),
        "git": git_state,
        "binding": binding,
        "runningEveOS": running_eveos,
        "liveTlo": live_tlo,
        "test": test_record,
        "postState": {
            "head": post_head,
            "headUnchanged": post_head == git_state["head"],
            "worktreeClean": not bool(post_worktree_paths),
            "worktreeStatus": post_worktree.splitlines() if post_worktree else [],
            "worktreePaths": post_worktree_paths,
            "candidateDigest": post_candidate_digest,
            "candidateUnchanged": candidate_unchanged,
        },
        "deterministicOutcome": "GREEN" if test["status"] == 0 else "RED",
        "authority": {
            "deterministicTestOwnsOutcome": True,
            "tloMayChangeOutcome": False,
            "tloMayModifySourceOrGit": False,
        },
    }
    RESULT_DIR.mkdir(parents=True, exist_ok=True)
    receipt_path = RESULT_DIR / f"{run_id}.json"
    write_json(receipt_path, receipt)
    if post_head != git_state["head"] or not candidate_unchanged:
        raise RehearsalError(
            "Focused test changed the authorized candidate state; inspect the receipt before any TLO triage.",
            state="POST_STATE_CHANGED",
        )

    # Re-check the bounded live dependency immediately before triage.
    status_code, status = http_json("GET", "/api/eve-state/modular/tlo/status?scopeId=default")
    if status_code >= 400:
        raise RehearsalError(f"TLO became unavailable after qualification ({status_code}).", state="UNAVAILABLE")
    live_tlo = validate_live_tlo(status, binding)
    triage_path = RESULT_DIR / f"{run_id}.tlo.json"
    if live_tlo["status"] != "MATCH":
        write_json(triage_path, {
            "schema": "eveos.tlo-engineering-triage",
            "schemaVersion": 1,
            "runId": run_id,
            "status": "VERSION_MISMATCH",
            "runningEveOS": running_eveos,
            "liveTlo": live_tlo,
            "deterministicOutcome": receipt["deterministicOutcome"],
        })
        print(f"TLO_REHEARSAL {receipt['deterministicOutcome']} | TLO VERSION_MISMATCH")
        print(f"RECEIPT {receipt_path.relative_to(ROOT).as_posix()}")
        print(f"TRIAGE {triage_path.relative_to(ROOT).as_posix()}")
        return 4

    parsed, raw_text, metadata = request_tlo_triage(triage_prompt(receipt, live_tlo))
    write_json(triage_path, {
        "schema": "eveos.tlo-engineering-triage",
        "schemaVersion": 1,
        "runId": run_id,
        "status": "MATCH",
        "runningEveOS": running_eveos,
        "liveTlo": live_tlo,
        "deterministicOutcome": receipt["deterministicOutcome"],
        "analysis": parsed,
        "rawText": raw_text[:MAX_PROMPT_CHARS],
        "streamMetadata": metadata[-4:],
        "authority": receipt["authority"],
    })
    print(
        f"TLO_REHEARSAL {receipt['deterministicOutcome']} | "
        f"TLO {parsed.get('classification', 'UNCLASSIFIED')}"
    )
    print(f"HEAD {git_state['head']}")
    print(f"BINDING {binding['bindingRevision']} MATCH")
    print(f"RECEIPT {receipt_path.relative_to(ROOT).as_posix()}")
    print(f"TRIAGE {triage_path.relative_to(ROOT).as_posix()}")
    return 0 if test["status"] == 0 else 1


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except RehearsalError as exc:
        print(f"TLO_REHEARSAL_REFUSED {exc.state}: {exc}", file=sys.stderr)
        raise SystemExit(4 if exc.state in {"VERSION_MISMATCH", "UNAVAILABLE"} else 2)
