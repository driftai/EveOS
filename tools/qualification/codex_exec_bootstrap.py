#!/usr/bin/env python3
"""Version-aware, fail-closed Codex exec handoff with optional local TLO triage.

Does not publish, mutate providers, or retry an unknown execution outcome.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable


APPROVAL_FLAG = "--ask-for-approval"
APPROVAL_MODE = "never"
SANDBOX_MODE = "workspace-write"
EXEC_FLAGS = ("--cd", "--sandbox", "--output-last-message")
TRIAGE_FIELDS = (
    "classification", "firstCausalFailure", "confidence", "nextCheck", "reason",
)


class BootstrapBlocked(RuntimeError):
    """A fail-closed bootstrap refusal with a stable receipt classification."""

    def __init__(self, message: str, failure_class: str) -> None:
        super().__init__(message)
        self.failure_class = failure_class


def version_probe_argv(executable: str) -> list[str]:
    # Approval is a GLOBAL option, not an `exec` option.
    return [executable, APPROVAL_FLAG, APPROVAL_MODE, "exec", "--version"]


def build_argv(executable: str, repo: Path, final: Path) -> list[str]:
    return [
        executable, APPROVAL_FLAG, APPROVAL_MODE, "exec", "--cd", str(repo),
        "--sandbox", SANDBOX_MODE, "--output-last-message", str(final), "-",
    ]


def _redact_sensitive(text: str) -> str:
    value = re.sub(r"(?i)bearer\s+\S+", "Bearer [REDACTED]", str(text))
    value = re.sub(
        r"(?i)(authorization|api[_-]?key|token|password|secret)\s*[:=]\s*(?:Bearer\s+)?\S+",
        r"\1=[REDACTED]",
        value,
    )
    value = re.sub(r"(?i)(https?://)[^/@\s:]+:[^/@\s]+@", r"\1[REDACTED]@", value)
    value = re.sub(r"\b(?:sk[-_]|ghp_|github_pat_)[A-Za-z0-9_-]{12,}\b", "[REDACTED]", value)
    return value


def _safe_cli_lines(raw: str, limit: int = 1400) -> str:
    allowed = re.compile(
        r"(?i)^\s*(?:error:|fatal:|usage:|unexpected argument|unknown "
        r"(?:option|argument)|unrecognized (?:option|argument)|permission denied|"
        r"authentication failed|sandbox (?:error|failure)|for more information)"
    )
    text = "\n".join(
        line[:240] for line in str(raw).splitlines() if allowed.search(line)
    )[-limit:]
    return _redact_sensitive(text)


def classify_cli_error(error: str) -> str:
    parser_error = re.compile(
        r"(?im)^\s*(?:error:\s*)?(?:unexpected argument|unknown "
        r"(?:option|argument)|unrecognized (?:option|argument))\b"
    )
    return (
        "CLI_PARSER_REJECTED"
        if parser_error.search(str(error))
        else "UNKNOWN_EXECUTION_OUTCOME"
    )


def _has_flag(usage: str, flag: str) -> bool:
    return bool(re.search(rf"(?<![\w-]){re.escape(flag)}(?=$|[\s=<,\[])", usage))


def _probe(executable: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [executable, *args], capture_output=True, text=True, timeout=15,
    )


def _probe_failure(label: str, result: subprocess.CompletedProcess[str]) -> BootstrapBlocked:
    raw = (result.stderr or "") + "\n" + (result.stdout or "")
    detail = _safe_cli_lines(raw, 800) or "no recognized CLI diagnostic"
    failure_class = classify_cli_error(detail)
    if failure_class == "UNKNOWN_EXECUTION_OUTCOME":
        failure_class = "CLI_PREFLIGHT_FAILED"
    return BootstrapBlocked(f"{label}: {detail}", failure_class)


def check_contract(executable: str) -> tuple[str, dict]:
    global_help = _probe(executable, "--help")
    if global_help.returncode != 0:
        raise _probe_failure("Codex global --help is unavailable", global_help)
    global_usage = (global_help.stdout or "") + "\n" + (global_help.stderr or "")
    if not _has_flag(global_usage, APPROVAL_FLAG):
        raise BootstrapBlocked(
            f"Codex global flag drift: required {APPROVAL_FLAG}",
            "SUPPORTED_FLAG_DRIFT",
        )

    exec_help = _probe(executable, "exec", "--help")
    if exec_help.returncode != 0:
        raise _probe_failure("Codex exec --help is unavailable", exec_help)
    exec_usage = (exec_help.stdout or "") + "\n" + (exec_help.stderr or "")
    missing = [flag for flag in EXEC_FLAGS if not _has_flag(exec_usage, flag)]
    if missing:
        raise BootstrapBlocked(
            "Codex exec lacks required safe flags: " + ", ".join(missing),
            "SUPPORTED_FLAG_DRIFT",
        )

    version = subprocess.run(
        version_probe_argv(executable), capture_output=True, text=True, timeout=15,
    )
    if version.returncode != 0:
        raise _probe_failure("Codex rejected the safe global approval flag", version)
    identity = (version.stdout or version.stderr).strip()
    return identity, {
        "approvalMode": APPROVAL_MODE,
        "sandboxMode": SANDBOX_MODE,
        "noUnsafeFallback": True,
    }


def triage_with_tlo(
    error: str,
    *,
    validate: Callable[[], None] | None = None,
    request: Callable[[str], tuple[dict, str, list[dict]]] | None = None,
) -> dict:
    """Request advisory triage only after the existing passive readiness gate."""
    try:
        if validate is None:
            from tlo_autorecover_core import validate_tlo
            validate = validate_tlo
        validate()  # Does not start or download a model; fails if unavailable/mismatched.
    except Exception as exc:
        return {
            "status": "LIVE_TLO_BLOCKED",
            "mode": "READ_ONLY",
            "executionAuthorized": False,
            "reason": _redact_sensitive(str(exc))[:200],
        }

    try:
        if request is None:
            from tlo_rehearsal_support import request_tlo_triage
            request = request_tlo_triage
        prompt = (
            "You are TLO, a read-only engineering triage analyst. Codex CLI launch failed. "
            "Return one JSON object: classification, firstCausalFailure, confidence, nextCheck, reason. "
            "No shell commands. No retries. No mutations, new permissions, or publication. "
            "Do not infer that execution did not begin unless evidence proves pre-dispatch parser failure.\n"
            "Bounded redacted local error:\n" + _redact_sensitive(error)[:1700]
        )
        plan, _, _ = request(prompt)
        if not isinstance(plan, dict):
            raise TypeError("TLO triage result is not an object")
        analysis = {
            key: _redact_sensitive(str(plan.get(key) or ""))[:500]
            for key in TRIAGE_FIELDS
        }
        return {
            "status": "TRIAGED_READ_ONLY",
            "mode": "READ_ONLY",
            "executionAuthorized": False,
            "analysis": analysis,
        }
    except Exception as exc:
        return {
            "status": "LIVE_TLO_BLOCKED",
            "mode": "READ_ONLY",
            "executionAuthorized": False,
            "reason": _redact_sensitive(str(exc))[:200],
        }


def find_codex_executable() -> str | None:
    candidates = ["codex.cmd" if os.name == "nt" else "codex", "codex.exe", "codex"]
    return next((found for name in candidates if (found := shutil.which(name))), None)


def _git_value(repo: Path, *args: str) -> str:
    result = subprocess.run(
        ["git", "-C", str(repo), *args],
        capture_output=True,
        text=True,
        timeout=15,
    )
    if result.returncode != 0:
        raise BootstrapBlocked(
            "Could not inspect repository identity",
            "GIT_STATE_UNAVAILABLE",
        )
    return result.stdout.strip()


def read_git_state(repo: Path) -> dict[str, str]:
    return {
        "branch": _git_value(repo, "branch", "--show-current"),
        "head": _git_value(repo, "rev-parse", "HEAD"),
    }


def run(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", type=Path, required=True)
    parser.add_argument("--mission", type=Path, required=True)
    parser.add_argument("--result-dir", type=Path, required=True)
    parser.add_argument("--expected-branch", default="eve/nexus-machine-spaces")
    parser.add_argument("--expected-head", required=True)
    parser.add_argument("--preflight-only", action="store_true")
    args = parser.parse_args(argv)
    result = args.result_dir.resolve()
    result.mkdir(parents=True, exist_ok=True)
    log_file, final_file = result / "codex-run.log", result / "codex-final.txt"
    outcome = {
        "schema": "eveos.codex-cli-bootstrap.v1",
        "startedAt": datetime.now(timezone.utc).isoformat(),
        "expectedBranch": args.expected_branch,
        "expectedHead": args.expected_head,
        "resultDir": str(result),
        "commandPolicy": "approval-never + workspace-write",
        "publication": "NOT_AUTHORIZED",
        "automaticRetry": "FORBIDDEN",
    }
    return_code = 2
    try:
        repo = args.repo.resolve(strict=True)
        mission = args.mission.resolve(strict=True)
        outcome["missionSha256"] = hashlib.sha256(mission.read_bytes()).hexdigest()

        git_state = read_git_state(repo)
        outcome.update({
            "observedBranch": git_state["branch"],
            "observedHead": git_state["head"],
        })
        if git_state["branch"] != args.expected_branch:
            raise BootstrapBlocked(
                "Unauthorized branch; no Codex execution",
                "UNEXPECTED_BRANCH",
            )
        if git_state["head"] != args.expected_head:
            raise BootstrapBlocked(
                "Unexpected local HEAD; no Codex execution",
                "UNEXPECTED_HEAD",
            )

        executable = find_codex_executable()
        if not executable:
            raise BootstrapBlocked(
                "Codex CLI not found; no execution",
                "CLI_NOT_FOUND",
            )

        version, policy = check_contract(executable)
        outcome.update({"cliVersion": version, "policy": policy})
        if args.preflight_only:
            outcome["status"] = "PREFLIGHT_GREEN_NO_EXECUTION"
            return_code = 0
        else:
            command = build_argv(executable, repo, final_file)
            print("CODEX_EXEC_COMPAT PREFLIGHT_GREEN - RUNNING", flush=True)
            with mission.open("rb") as input_file, log_file.open("wb") as log:
                proc = subprocess.run(
                    command,
                    stdin=input_file,
                    stdout=log,
                    stderr=subprocess.STDOUT,
                    cwd=repo,
                )
            return_code = proc.returncode
            outcome["exitCode"] = return_code
            if return_code:
                # After mission dispatch, combined output can contain model/tool text.
                # It cannot establish parser provenance or prove that execution never began.
                outcome["failureClass"] = "UNKNOWN_EXECUTION_OUTCOME"
                outcome["status"] = "EXECUTION_FAILED_OR_UNCERTAIN"
                outcome["localLogReviewRequired"] = True
                outcome["tlo"] = triage_with_tlo(
                    f"Codex returned exit code {return_code} after mission dispatch. "
                    "Execution outcome is unknown and no retry is authorized."
                )
            else:
                outcome["status"] = "EXIT_ZERO_NOT_PROOF_OF_QUALIFICATION"
    except BootstrapBlocked as exc:
        return_code = 2
        outcome["status"] = "PREFLIGHT_BLOCKED_NO_EXECUTION"
        outcome["failureClass"] = exc.failure_class
        outcome["error"] = _redact_sensitive(str(exc))[-900:]
        if exc.failure_class in {
            "CLI_PARSER_REJECTED", "SUPPORTED_FLAG_DRIFT", "CLI_PREFLIGHT_FAILED",
        }:
            outcome["tlo"] = triage_with_tlo(outcome["error"])
    except (OSError, RuntimeError, subprocess.TimeoutExpired) as exc:
        return_code = 2
        outcome["status"] = "PREFLIGHT_BLOCKED_NO_EXECUTION"
        outcome["failureClass"] = "PREFLIGHT_ERROR"
        outcome["error"] = _redact_sensitive(str(exc))[-900:]
    finally:
        outcome["finishedAt"] = datetime.now(timezone.utc).isoformat()
        (result / "codex-cli-bootstrap.json").write_text(
            json.dumps(outcome, indent=2) + "\n",
            encoding="utf-8",
        )
        print("CODEX_EXEC_COMPAT", outcome["status"])
        print("REPORT", result / "codex-cli-bootstrap.json")
    return return_code


if __name__ == "__main__":
    sys.exit(run())
