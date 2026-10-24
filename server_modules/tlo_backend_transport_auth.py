"""Fail-closed authentication for Nexus-owned TLO backend inference."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import threading
import time


AUTH_SCHEMA = "eveos.tlo-backend-transport.v1"
AUTH_HEADER = "X-EveOS-TLO-Backend-Authorization"
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$")
_SCOPE = re.compile(r"^[a-z][a-z0-9_-]{0,63}$")
MAX_CLOCK_SKEW_MS = 30_000
MAX_NONCES = 256


class BackendTransportAuthError(ValueError):
    """The request did not prove the configured Nexus backend identity."""


def _text(value, label: str, pattern=_ID) -> str:
    result = str(value or "").strip()
    if not pattern.fullmatch(result):
        raise BackendTransportAuthError(f"Invalid {label}.")
    return result


def _history_json(value) -> str:
    if not isinstance(value, list) or len(value) > 40:
        raise BackendTransportAuthError("Invalid backend TLO history.")
    clean = []
    for item in value:
        if not isinstance(item, dict) or item.get("role") not in {"user", "assistant"}:
            raise BackendTransportAuthError("Invalid backend TLO history item.")
        content = str(item.get("content") or "").strip()
        if not content or len(content) > 32_000:
            raise BackendTransportAuthError("Invalid backend TLO history content.")
        clean.append({"role": item["role"], "content": content})
    return json.dumps(clean, ensure_ascii=False, separators=(",", ":"))


def canonical(envelope: dict) -> str:
    fields = (
        "schema", "serverSessionId", "scopeId", "ownerId", "ownerGeneration",
        "requestId", "roomId", "sourceMessageId", "dispatchId", "nonce",
        "issuedAt", "messageSha256", "historySha256",
    )
    return "\n".join(str(envelope.get(field, "")) for field in fields)


class BackendTransportAuthorizer:
    def __init__(self, *, secret: str, server_session_id: str, owner_id: str,
                 owner_generation: int, scope_id: str = "default", now_ms=None):
        if not isinstance(secret, str) or len(secret) < 32:
            raise TypeError("Backend transport secret must contain at least 32 characters.")
        self._secret = secret.encode("utf-8")
        self._server_session_id = _text(server_session_id, "server session ID")
        self._owner_id = _text(owner_id, "owner ID")
        if not isinstance(owner_generation, int) or owner_generation <= 0:
            raise TypeError("Backend owner generation is invalid.")
        self._owner_generation = owner_generation
        self._scope_id = _text(scope_id, "scope", _SCOPE)
        self._now_ms = now_ms or (lambda: int(time.time() * 1000))
        self._nonces: dict[str, int] = {}
        self._lock = threading.RLock()

    def _prune(self, stamp: int) -> None:
        cutoff = stamp - MAX_CLOCK_SKEW_MS
        self._nonces = {nonce: seen for nonce, seen in self._nonces.items() if seen >= cutoff}
        if len(self._nonces) > MAX_NONCES:
            for nonce, _seen in sorted(self._nonces.items(), key=lambda item: item[1])[:-MAX_NONCES]:
                self._nonces.pop(nonce, None)

    def authorize(self, headers, payload: dict) -> dict:
        if not isinstance(payload, dict) or not isinstance(payload.get("backendAuth"), dict):
            raise BackendTransportAuthError("Backend authorization envelope is required.")
        envelope = dict(payload["backendAuth"])
        message = str(payload.get("message") or "").strip()
        history_json = _history_json(payload.get("history"))
        expected = {
            "schema": AUTH_SCHEMA,
            "serverSessionId": self._server_session_id,
            "scopeId": self._scope_id,
            "ownerId": self._owner_id,
            "ownerGeneration": self._owner_generation,
            "requestId": _text(payload.get("requestId"), "request ID"),
        }
        for key, value in expected.items():
            if envelope.get(key) != value:
                raise BackendTransportAuthError(f"Backend authorization {key} mismatch.")
        for key in ("roomId", "sourceMessageId", "dispatchId", "nonce"):
            envelope[key] = _text(envelope.get(key), key)
        issued_at = envelope.get("issuedAt")
        if not isinstance(issued_at, int):
            raise BackendTransportAuthError("Backend authorization timestamp is invalid.")
        stamp = int(self._now_ms())
        if abs(stamp - issued_at) > MAX_CLOCK_SKEW_MS:
            raise BackendTransportAuthError("Backend authorization expired.")
        message_digest = hashlib.sha256(message.encode("utf-8")).hexdigest()
        history_digest = hashlib.sha256(history_json.encode("utf-8")).hexdigest()
        if envelope.get("messageSha256") != message_digest or envelope.get("historySha256") != history_digest:
            raise BackendTransportAuthError("Backend request content digest mismatch.")
        received = str(headers.get(AUTH_HEADER, "") if headers else "").strip().lower()
        expected_signature = hmac.new(self._secret, canonical(envelope).encode("utf-8"), hashlib.sha256).hexdigest()
        if not received or not hmac.compare_digest(received, expected_signature):
            raise BackendTransportAuthError("Backend transport signature is invalid.")
        with self._lock:
            self._prune(stamp)
            if envelope["nonce"] in self._nonces:
                raise BackendTransportAuthError("Backend authorization nonce was already used.")
            self._nonces[envelope["nonce"]] = stamp
        return envelope

