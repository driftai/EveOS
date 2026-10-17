"""Evidence selection and prompt construction for TLO autorecovery."""

from __future__ import annotations

import json
import re

from tlo_autorecover_core import (
    MAX_CONTEXT_CHARS,
    MAX_DIFF_CHARS,
    MAX_EDITS,
    MAX_FAILURE_CHARS,
    PER_FILE_CONTEXT,
    decode,
    run,
)
from tlo_rehearsal_support import MAX_PROMPT_CHARS, ROOT


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
