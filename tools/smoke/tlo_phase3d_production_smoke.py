"""Deterministic Gate 3B cross-process activation/owner contract."""

from __future__ import annotations

import hashlib
import hmac
import json
import tempfile
import uuid
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules.tlo_backend_runtime_config import RuntimeBackendAuthority, _canonical, source_identity
from server_modules.tlo_backend_transport_auth import AUTH_HEADER, AUTH_SCHEMA, BackendTransportAuthError, canonical


def require(value, message):
    if not value:
        raise AssertionError(message)


def main():
    with tempfile.TemporaryDirectory(prefix="eveos-tlo-gate3b-") as raw:
        root = Path(raw)
        activation_path, owners = root / "activation.json", root / "owners"
        owners.mkdir()
        protocol, fingerprint = source_identity()
        secret = "gate3b-production-secret-00000000000000000001"
        owner_id, request_id = "nexus-backend-gate3b-smoke", "dex-turn-gate3b-smoke"
        record = {
            "schema": "eveos.tlo-production-activation.v1", "protocolVersion": protocol,
            "mode": "active", "serverSessionId": "nexus-session-gate3b-smoke",
            "sourceFingerprint": fingerprint, "scopeId": "default", "ownerId": owner_id,
            "ownerGeneration": 2, "browserWorkspaceId": "search-monitor-gate3b-smoke",
            "browserGeneration": 1, "browserDigest": "a" * 64,
            "revision": "tlo-activation-gate3b-smoke", "createdAt": 1000,
            "expiresAt": 9007199254740991, "secret": secret,
        }
        record["integrity"] = hmac.new(secret.encode(), _canonical(record).encode(), hashlib.sha256).hexdigest()
        activation_path.write_text(json.dumps(record), encoding="utf-8")
        owner_record = {"schema": "eveos.tlo-ownership-durable-cas.v1", "revision": str(uuid.uuid4()),
            "state": {"schema": "eveos.tlo-ownership-fence.v1", "scopeId": "default",
                "generation": 2, "owner": {"kind": "backend", "id": owner_id}, "handoff": None,
                "turn": {"requestId": request_id, "ownerGeneration": 2,
                    "phase": "dispatched", "at": 1000}}}
        (owners / "default.json").write_text(json.dumps(owner_record), encoding="utf-8")
        message, history = "hello", [{"role": "user", "content": "before"}]
        history_json = json.dumps(history, ensure_ascii=False, separators=(",", ":"))
        envelope = {"schema": AUTH_SCHEMA, "serverSessionId": record["serverSessionId"],
            "scopeId": "default", "ownerId": owner_id, "ownerGeneration": 2,
            "requestId": request_id, "roomId": "room-gate3b-smoke",
            "sourceMessageId": "message-gate3b-smoke", "dispatchId": "dispatch-gate3b-smoke",
            "nonce": "nonce-gate3b-smoke-0001", "issuedAt": 5000,
            "messageSha256": hashlib.sha256(message.encode()).hexdigest(),
            "historySha256": hashlib.sha256(history_json.encode()).hexdigest()}
        signature = hmac.new(secret.encode(), canonical(envelope).encode(), hashlib.sha256).hexdigest()
        payload = {"requestId": request_id, "scopeId": "default", "message": message,
            "history": history, "backendAuth": envelope}
        authority = RuntimeBackendAuthority(activation_path=activation_path,
            ownership_dir=owners, now_ms=lambda: 5000)
        require(authority.backend_enabled(), "exact active source was not enabled")
        require(authority.authorize({AUTH_HEADER: signature}, payload)["requestId"] == request_id,
                "exact authenticated dispatch was rejected")
        try:
            authority.authorize({AUTH_HEADER: signature}, payload)
            raise AssertionError("replayed HMAC nonce was accepted")
        except BackendTransportAuthError:
            pass
        owner_record["state"]["generation"] = 3
        (owners / "default.json").write_text(json.dumps(owner_record), encoding="utf-8")
        envelope["nonce"] = "nonce-gate3b-smoke-0002"
        signature = hmac.new(secret.encode(), canonical(envelope).encode(), hashlib.sha256).hexdigest()
        try:
            authority.authorize({AUTH_HEADER: signature}, payload)
            raise AssertionError("stale backend generation was accepted")
        except BackendTransportAuthError:
            pass
        activation_path.unlink()
        owner_record["state"].update({"generation": 1,
            "owner": {"kind": "browser", "id": "search-monitor-gate3b-smoke"}, "turn": None})
        (owners / "default.json").write_text(json.dumps(owner_record), encoding="utf-8")
        require(authority.browser_owner_allowed("default"), "idle durable browser owner was rejected")
        require(not authority.backend_enabled(), "missing activation did not disable backend")
    print("TLO_PHASE3D_PRODUCTION_OK scenarios=auth,replay,stale-generation,browser-owner,disabled")


if __name__ == "__main__":
    main()
