"""Shared support for the bounded, version-bound TLO engineering rehearsal."""

from __future__ import annotations

import hashlib
import http.client
import json
import re
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[2]
ROOT_TEXT = str(ROOT)
if ROOT_TEXT not in sys.path:
    sys.path.insert(0, ROOT_TEXT)

BINDING_PATH = ROOT / "config" / "agents" / "tlo" / "RUNTIME.json"
PACKAGE_PATH = ROOT / "package.json"
TLO_PROFILE_PATH = ROOT / "config" / "agents" / "tlo" / "AGENT.md"
LOCAL_MOE_CONFIG = ROOT / "tools" / "Local-MoE-Harness" / "config"
LOCAL_MOE_SETTINGS_PATH = LOCAL_MOE_CONFIG / "settings.json"
LOCAL_MOE_LOCK_PATH = LOCAL_MOE_CONFIG / "runtime-lock.json"
LOCAL_MOE_MODELS_PATH = LOCAL_MOE_CONFIG / "models.json"
PORTS_PATH = ROOT / "config" / "eveos-ports.json"
SERVER_STATUS_PATH = ROOT / "server_modules" / "eveos_server_status.py"
RESULT_DIR = ROOT / "data" / "runtime" / "smoke-results"
MAX_CAPTURE_CHARS = 160_000
MAX_PROMPT_CHARS = 12_000
TRIAGE_TIMEOUT_SECONDS = 360
MAX_TLO_JSON_ATTEMPTS = 3


class RehearsalError(RuntimeError):
    def __init__(self, message: str, *, state: str = "ERROR"):
        super().__init__(message)
        self.state = state


def load_json(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RehearsalError(f"Could not read JSON: {path}", state="CONFIG_INVALID") from exc
    if not isinstance(payload, dict):
        raise RehearsalError(f"Expected JSON object: {path}", state="CONFIG_INVALID")
    return payload


def profile_revision(path: Path = TLO_PROFILE_PATH) -> str:
    try:
        text = path.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise RehearsalError(f"Could not read TLO profile seed: {path}", state="CONFIG_INVALID") from exc
    normalized = text.replace("\r\n", "\n").replace("\r", "\n").strip() + "\n"
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()[:16]


def port_value(registry: dict, key: str) -> int:
    try:
        return int(registry["ports"][key]["port"])
    except (KeyError, TypeError, ValueError) as exc:
        raise RehearsalError(f"Missing EveOS port registry entry: {key}", state="CONFIG_INVALID") from exc


def server_status_version() -> str:
    try:
        source = SERVER_STATUS_PATH.read_text(encoding="utf-8")
    except (OSError, UnicodeError) as exc:
        raise RehearsalError(f"Could not read EveOS server status source: {SERVER_STATUS_PATH}", state="CONFIG_INVALID") from exc
    match = re.search(r'^SERVICE_VERSION\s*=\s*["\']([^"\']+)["\']', source, re.M)
    if not match:
        raise RehearsalError("EveOS server status version is not declared.", state="CONFIG_INVALID")
    return match.group(1)


def repository_binding() -> dict:
    binding = load_json(BINDING_PATH)
    package = load_json(PACKAGE_PATH)
    settings = load_json(LOCAL_MOE_SETTINGS_PATH)
    runtime_lock = load_json(LOCAL_MOE_LOCK_PATH)
    models = load_json(LOCAL_MOE_MODELS_PATH)
    ports = load_json(PORTS_PATH)
    expected_runtime = binding.get("runtime") if isinstance(binding.get("runtime"), dict) else {}
    freetoken_lock = runtime_lock.get("freetoken") if isinstance(runtime_lock.get("freetoken"), dict) else {}
    default_model_id = str(models.get("default_model_id") or "")
    registry = [item for item in models.get("models") or [] if isinstance(item, dict)]
    default_model = next((item for item in registry if str(item.get("id") or "") == default_model_id), {})

    observed = {
        "eveosVersion": str(package.get("version") or ""),
        "serverStatusVersion": server_status_version(),
        "profileSeedRevision": profile_revision(),
        "provider": "local-moe",
        "triageProtocol": str(binding.get("triageProtocol") or ""),
        "runtime": {
            "backend": str(settings.get("runtime") or ""),
            "baseUrl": str(settings.get("runtime_base_url") or ""),
            "modelId": default_model_id,
            "servedModelName": str(default_model.get("served_model_name") or ""),
            "runtimeVersion": str(freetoken_lock.get("version") or ""),
            "runtimeSourceCommit": str(freetoken_lock.get("source_commit") or ""),
            "harnessPort": port_value(ports, "LOCAL_MOE_HARNESS_PORT"),
            "runtimePort": port_value(ports, "FREETOKEN_PORT"),
        },
    }
    expected = {
        "eveosVersion": str(binding.get("eveosVersion") or ""),
        "serverStatusVersion": str(binding.get("serverStatusVersion") or ""),
        "profileSeedRevision": str(binding.get("profileSeedRevision") or ""),
        "provider": str(binding.get("provider") or ""),
        "triageProtocol": str(binding.get("triageProtocol") or ""),
        "runtime": {
            key: expected_runtime.get(key)
            for key in (
                "backend", "baseUrl", "modelId", "servedModelName",
                "runtimeVersion", "runtimeSourceCommit", "harnessPort", "runtimePort",
            )
        },
    }
    mismatches: list[dict[str, Any]] = []
    for key in ("eveosVersion", "serverStatusVersion", "profileSeedRevision", "provider", "triageProtocol"):
        if observed[key] != expected[key]:
            mismatches.append({"field": key, "expected": expected[key], "observed": observed[key]})
    for key, expected_value in expected["runtime"].items():
        if observed["runtime"].get(key) != expected_value:
            mismatches.append({
                "field": f"runtime.{key}",
                "expected": expected_value,
                "observed": observed["runtime"].get(key),
            })
    configured_served = str(settings.get("runtime_model") or "")
    if configured_served != observed["runtime"]["servedModelName"]:
        mismatches.append({
            "field": "runtime.settingsModel",
            "expected": observed["runtime"]["servedModelName"],
            "observed": configured_served,
        })
    return {
        "status": "MATCH" if not mismatches else "VERSION_MISMATCH",
        "bindingRevision": str(binding.get("bindingRevision") or ""),
        "expected": expected,
        "observed": observed,
        "mismatches": mismatches,
    }


def run_process(command: list[str], *, timeout: int = 120, cwd: Path = ROOT) -> dict:
    started = time.monotonic()
    try:
        result = subprocess.run(
            command, cwd=str(cwd), text=True, capture_output=True, timeout=timeout,
            check=False, errors="replace",
        )
        return {
            "command": command,
            "status": result.returncode,
            "stdout": (result.stdout or "")[-MAX_CAPTURE_CHARS:],
            "stderr": (result.stderr or "")[-MAX_CAPTURE_CHARS:],
            "durationMs": round((time.monotonic() - started) * 1000),
            "error": "",
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {
            "command": command, "status": None, "stdout": "", "stderr": "",
            "durationMs": round((time.monotonic() - started) * 1000), "error": str(exc),
        }


def git_text(*args: str) -> str:
    result = run_process(["git", *args], timeout=120)
    if result["status"] != 0:
        raise RehearsalError(
            f"git {' '.join(args)} failed: {result['stderr'] or result['error']}",
            state="GIT_ERROR",
        )
    return result["stdout"].strip()


def git_worktree_paths() -> list[str]:
    paths: set[str] = set()
    for args in (
        ("diff", "--name-only", "HEAD", "--"),
        ("ls-files", "--others", "--exclude-standard"),
    ):
        text = git_text(*args)
        for line in text.splitlines():
            relative = line.strip().replace("\\", "/")
            if not relative:
                continue
            candidate = (ROOT / relative).resolve()
            try:
                candidate.relative_to(ROOT)
            except ValueError as exc:
                raise RehearsalError(
                    f"Dirty path escapes repository root: {relative}",
                    state="DIRTY_WORKTREE",
                ) from exc
            paths.add(relative)
    return sorted(paths)


def worktree_digest(paths: list[str]) -> str:
    digest = hashlib.sha256()
    for relative in sorted(set(paths)):
        candidate = (ROOT / relative).resolve()
        digest.update(relative.encode("utf-8"))
        digest.update(b"\0")
        if candidate.is_file():
            digest.update(candidate.read_bytes())
        elif candidate.exists():
            digest.update(b"<non-file>")
        else:
            digest.update(b"<missing>")
        digest.update(b"\0")
    return digest.hexdigest()


def git_preflight(
    expected_branch: str,
    *,
    allow_detached: bool = False,
    allowed_dirty_paths: list[str] | None = None,
) -> dict:
    fetch = run_process(["git", "fetch", "--quiet", "origin", expected_branch], timeout=180)
    if fetch["status"] != 0:
        raise RehearsalError(
            f"Could not fetch origin/{expected_branch}: {fetch['stderr'] or fetch['error']}",
            state="REMOTE_UNAVAILABLE",
        )
    branch = git_text("branch", "--show-current")
    head = git_text("rev-parse", "HEAD")
    remote_ref = f"origin/{expected_branch}"
    remote_head = git_text("rev-parse", remote_ref)
    worktree = git_text("status", "--short")
    worktree_paths = git_worktree_paths()
    candidate_digest = worktree_digest(worktree_paths)
    detached = not branch
    if branch != expected_branch and not (allow_detached and detached and head == remote_head):
        found = "detached HEAD" if detached else repr(branch)
        raise RehearsalError(
            f"Expected branch {expected_branch!r}, found {found}.", state="BRANCH_MISMATCH"
        )
    if head != remote_head:
        raise RehearsalError(
            f"Local HEAD {head} does not match {remote_ref} {remote_head}.", state="HEAD_MISMATCH"
        )
    allowed = None
    if allowed_dirty_paths is not None:
        allowed = {
            str(path).replace("\\", "/").strip("/")
            for path in allowed_dirty_paths
            if str(path).strip()
        }

    if worktree_paths and allowed is None:
        raise RehearsalError(
            "Worktree is dirty; preserve/reconcile local edits before this rehearsal.",
            state="DIRTY_WORKTREE",
        )

    if allowed is not None:
        unexpected = sorted(set(worktree_paths) - allowed)
        if unexpected:
            raise RehearsalError(
                "Candidate worktree contains unauthorized dirty paths: "
                + ", ".join(unexpected),
                state="DIRTY_WORKTREE",
            )

    return {
        "branch": branch or "(detached)",
        "authorizedBranch": expected_branch,
        "detached": detached,
        "head": head,
        "remoteRef": remote_ref,
        "remoteHead": remote_head,
        "worktreeClean": not bool(worktree_paths),
        "worktreeStatus": worktree.splitlines() if worktree else [],
        "worktreePaths": worktree_paths,
        "candidateDigest": candidate_digest,
    }


def bounded_lines(text: str, limit: int = 36) -> list[str]:
    lines = [
        line.rstrip() for line in re.sub(r"\x1b\[[0-9;]*m", "", str(text or "")).splitlines()
        if line.strip()
    ]
    important = [
        line for line in lines
        if re.search(r"error|fail|assert|expected|received|timeout|exception|not found|blocked|conflict|pass|ok", line, re.I)
    ]
    return (important if important else lines)[-limit:]


def safe_test_path(relative: str) -> Path:
    candidate = (ROOT / relative).resolve()
    allowed_root = (ROOT / "tools" / "Nexus-Browser" / "tests").resolve()
    try:
        candidate.relative_to(allowed_root)
    except ValueError as exc:
        raise RehearsalError(
            "First TLO rehearsal only permits Nexus Browser test files.", state="TEST_INVALID"
        ) from exc
    if not candidate.is_file() or candidate.suffix != ".js":
        raise RehearsalError(f"Test file is unavailable: {relative}", state="TEST_INVALID")
    return candidate


def eveos_port() -> int:
    return port_value(load_json(PORTS_PATH), "EVEOS_WEB_PORT")


def http_json(method: str, path: str, *, timeout: int = 10) -> tuple[int, dict]:
    connection = http.client.HTTPConnection("127.0.0.1", eveos_port(), timeout=timeout)
    try:
        connection.request(method, path, headers={"Connection": "close"})
        response = connection.getresponse()
        payload = json.loads(response.read(2_000_000).decode("utf-8"))
        return int(response.status), payload if isinstance(payload, dict) else {"value": payload}
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise RehearsalError(
            f"Running EveOS did not provide usable TLO status: {exc}", state="UNAVAILABLE"
        ) from exc
    finally:
        connection.close()



def local_web_fingerprint() -> str:
    try:
        from server_modules import eveos_web_fingerprint
        return eveos_web_fingerprint.capture_web_fingerprint()
    except Exception as exc:
        raise RehearsalError(f"Could not fingerprint local EveOS server source: {exc}", state="CONFIG_INVALID") from exc


def validate_running_eveos(status: dict, binding: dict, *, expected_fingerprint: str | None = None) -> dict:
    expected = binding["expected"]
    expected_port = eveos_port()
    expected_fingerprint = expected_fingerprint or local_web_fingerprint()
    mismatches = []
    checks = (
        ("eveos.service", status.get("service"), "eveos-local-server"),
        ("eveos.version", status.get("version"), expected.get("serverStatusVersion")),
        ("eveos.port", status.get("port"), expected_port),
        ("eveos.sourceFingerprint", status.get("sourceFingerprint"), expected_fingerprint),
    )
    for field, observed, wanted in checks:
        if observed != wanted:
            mismatches.append({"field": field, "expected": wanted, "observed": observed})
    return {
        "status": "MATCH" if not mismatches else "VERSION_MISMATCH",
        "mismatches": mismatches,
        "service": status.get("service"),
        "version": status.get("version"),
        "instanceId": status.get("instanceId"),
        "sourceFingerprint": status.get("sourceFingerprint"),
        "expectedSourceFingerprint": expected_fingerprint,
        "port": status.get("port"),
    }

def validate_live_tlo(status: dict, binding: dict) -> dict:
    expected = binding["expected"]
    expected_model = str(expected["runtime"]["modelId"] or "")
    agent = status.get("agent") if isinstance(status.get("agent"), dict) else {}
    local_moe = status.get("localMoe") if isinstance(status.get("localMoe"), dict) else {}
    mismatches = []
    if status.get("canChat") is not True or status.get("state") != "ready":
        mismatches.append({
            "field": "tlo.state", "expected": "ready/canChat",
            "observed": f"{status.get('state')}/{status.get('canChat')}",
        })
    for field, observed, wanted in (
        ("tlo.provider", agent.get("provider"), expected["provider"]),
        ("tlo.activeModelId", agent.get("activeModelId"), expected_model),
    ):
        if observed != wanted:
            mismatches.append({"field": field, "expected": wanted, "observed": observed})
    configured = str(agent.get("configuredModelId") or "")
    if configured and configured != expected_model:
        mismatches.append({"field": "tlo.configuredModelId", "expected": expected_model, "observed": configured})
    if local_moe.get("runtimeReady") is not True:
        mismatches.append({"field": "localMoe.runtimeReady", "expected": True, "observed": local_moe.get("runtimeReady")})
    definition = agent.get("definition") if isinstance(agent.get("definition"), dict) else {}
    if not definition.get("revision"):
        mismatches.append({"field": "tlo.definition.revision", "expected": "non-empty", "observed": definition.get("revision")})
    return {
        "status": "MATCH" if not mismatches else "VERSION_MISMATCH",
        "mismatches": mismatches,
        "state": status.get("state"),
        "canChat": status.get("canChat") is True,
        "agent": {
            "provider": agent.get("provider"), "configuredModelId": configured,
            "activeModelId": agent.get("activeModelId"), "definition": definition,
        },
        "localMoe": {
            "state": local_moe.get("state"), "runtimeReady": local_moe.get("runtimeReady") is True,
            "owned": local_moe.get("owned") is True,
        },
    }


def triage_prompt(receipt: dict, live_tlo: dict) -> str:
    test = receipt["test"]
    summary = {
        "runId": receipt["runId"],
        "eveosVersion": receipt["binding"]["expected"]["eveosVersion"],
        "eveosSha": receipt["git"]["head"],
        "branch": receipt["git"]["branch"],
        "bindingRevision": receipt["binding"]["bindingRevision"],
        "tloDefinitionRevision": live_tlo["agent"]["definition"].get("revision"),
        "deterministicOutcome": receipt["deterministicOutcome"],
        "test": test["path"],
        "exitStatus": test["status"],
        "durationMs": test["durationMs"],
        "importantLines": test["importantLines"],
    }
    prompt = (
        "You are TLO acting only as a bounded EveOS engineering triage analyst. "
        "The deterministic test outcome below is authoritative. Do not claim to modify source, Git, "
        "branches, services, or the pass/fail result.\n\n"
        "Return one JSON object and nothing else with exactly these keys:\n"
        'classification: "PASSING_EVIDENCE" | "FAILURE_FOUND" | "INSUFFICIENT_EVIDENCE"\n'
        'firstCausalFailure: string\nlikelyInvariant: string\n'
        "importantLines: array of at most 8 strings\n"
        'confidence: "low" | "medium" | "high"\nnextCheck: string\n\nReceipt summary:\n'
        + json.dumps(summary, ensure_ascii=False, indent=2)
    )
    return prompt[:MAX_PROMPT_CHARS]


def extract_stream_text(raw: bytes) -> tuple[str, list[dict]]:
    parts: list[str] = []
    metadata: list[dict] = []
    for raw_line in raw.decode("utf-8", errors="replace").splitlines():
        line = raw_line.strip()
        if not line.startswith("data:"):
            continue
        data = line[5:].strip()
        if not data or data == "[DONE]":
            continue
        try:
            payload = json.loads(data)
        except json.JSONDecodeError:
            continue
        if not isinstance(payload, dict):
            continue
        if payload.get("error"):
            raise RehearsalError(f"TLO stream returned an error: {payload['error']}", state="TLO_INFERENCE_FAILURE")
        choices = payload.get("choices")
        if isinstance(choices, list):
            for choice in choices:
                if not isinstance(choice, dict):
                    continue
                delta = choice.get("delta") if isinstance(choice.get("delta"), dict) else {}
                if isinstance(delta.get("content"), str):
                    parts.append(delta["content"])
                elif isinstance(choice.get("text"), str):
                    parts.append(choice["text"])
        else:
            metadata.append(payload)
    return "".join(parts).strip(), metadata


def parse_json_object(text: str) -> dict:
    candidate = re.sub(
        r"^```(?:json)?\s*",
        "",
        text.strip(),
        flags=re.I,
    )

    candidate = re.sub(
        r"\s*```$",
        "",
        candidate,
    )

    values = []

    if candidate:
        values.append(candidate)

    start_index = None
    depth = 0
    in_string = False
    escaped = False

    for index, char in enumerate(candidate):
        if in_string:
            if escaped:
                escaped = False
                continue

            if char == "\\":
                escaped = True
                continue

            if char == '"':
                in_string = False

            continue

        if char == '"':
            in_string = True
            continue

        if char == "{":
            if depth == 0:
                start_index = index

            depth += 1
            continue

        if char == "}" and depth:
            depth -= 1

            if (
                depth == 0
                and start_index is not None
            ):
                values.append(
                    candidate[
                        start_index:index + 1
                    ]
                )

                start_index = None

    seen = set()

    for value in values:
        value = value.strip()

        if (
            not value
            or value in seen
        ):
            continue

        seen.add(value)

        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            continue

        if isinstance(parsed, dict):
            return parsed

    raise RehearsalError(
        "TLO triage did not return a parseable JSON object.",
        state="TLO_RESPONSE_INVALID",
    )


def request_tlo_triage(prompt: str) -> tuple[dict, str, list[dict]]:
    last_invalid = None
    last_invalid_text = ""

    for attempt in range(MAX_TLO_JSON_ATTEMPTS):
        retry_suffix = ""

        if attempt:
            retry_suffix = (
                "\n\nFORMAT RECOVERY RETRY. "
                "Your previous response could not be parsed as JSON. "
                "Return exactly one valid JSON object matching the requested schema. "
                "No markdown fences, no preamble, no explanation, no trailing text."
            )

            if last_invalid_text:
                retry_suffix += (
                    "\n\nPrevious invalid response excerpt:\n"
                    + last_invalid_text[-1200:]
                )

        available = max(
            0,
            MAX_PROMPT_CHARS - len(retry_suffix)
        )

        attempt_prompt = (
            prompt[:available]
            + retry_suffix
        )

        body = json.dumps({
            "requestId": f"tlo-triage-{uuid.uuid4().hex[:20]}",
            "scopeId": "default",
            "message": attempt_prompt,
            "history": [],
        }, ensure_ascii=False).encode("utf-8")

        connection = http.client.HTTPConnection(
            "127.0.0.1",
            eveos_port(),
            timeout=TRIAGE_TIMEOUT_SECONDS,
        )

        try:
            connection.request(
                "POST",
                "/api/eve-state/modular/tlo/chat/stream",
                body=body,
                headers={
                    "Content-Type": "application/json",
                    "Content-Length": str(len(body)),
                    "Connection": "close",
                },
            )

            response = connection.getresponse()
            raw = response.read(4_000_000)

            if response.status >= 400:
                raise RehearsalError(
                    f"TLO triage request failed ({response.status}): {raw[:1000]!r}",
                    state="TLO_INFERENCE_FAILURE",
                )

            response_text, metadata = extract_stream_text(raw)

            try:
                parsed = parse_json_object(response_text)
            except RehearsalError as exc:
                if (
                    exc.state == "TLO_RESPONSE_INVALID"
                    and attempt + 1 < MAX_TLO_JSON_ATTEMPTS
                ):
                    last_invalid = exc
                    last_invalid_text = response_text
                    continue

                raise

            return parsed, response_text, metadata

        except OSError as exc:
            raise RehearsalError(
                f"TLO triage stream is unavailable: {exc}",
                state="UNAVAILABLE",
            ) from exc

        finally:
            connection.close()

    raise last_invalid or RehearsalError(
        "TLO triage exhausted JSON recovery attempts.",
        state="TLO_RESPONSE_INVALID",
    )
