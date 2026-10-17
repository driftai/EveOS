"""Prompt, stream parsing, and inference transport for TLO rehearsal."""

from __future__ import annotations

import http.client
import json
import re
import uuid

from tlo_rehearsal_common import (
    MAX_PROMPT_CHARS,
    MAX_TLO_JSON_ATTEMPTS,
    TRIAGE_TIMEOUT_SECONDS,
    RehearsalError,
    eveos_port,
)


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
            raise RehearsalError(
                f"TLO stream returned an error: {payload['error']}",
                state="TLO_INFERENCE_FAILURE",
            )
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
            if depth == 0 and start_index is not None:
                values.append(candidate[start_index:index + 1])
                start_index = None

    seen = set()
    for value in values:
        value = value.strip()
        if not value or value in seen:
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
        available = max(0, MAX_PROMPT_CHARS - len(retry_suffix))
        attempt_prompt = prompt[:available] + retry_suffix
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
                if exc.state == "TLO_RESPONSE_INVALID" and attempt + 1 < MAX_TLO_JSON_ATTEMPTS:
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
