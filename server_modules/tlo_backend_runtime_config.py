"""Machine-local Phase 3D activation and durable-owner enforcement."""

from __future__ import annotations

import hashlib
import hmac
import json
import re
import threading
import time
from pathlib import Path

from server_modules.tlo_backend_transport_auth import BackendTransportAuthorizer, BackendTransportAuthError


SCHEMA = "eveos.tlo-production-activation.v1"
MANIFEST_SCHEMA = "eveos.tlo-phase3d-source-manifest.v1"
_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{7,159}$")
_HASH = re.compile(r"^[a-f0-9]{64}$")
_ROOT = Path(__file__).resolve().parents[1]
_DEFAULT_ACTIVATION = _ROOT / "data" / "runtime" / "nexus-browser" / "tlo-backend-activation.json"
_DEFAULT_OWNERS = _ROOT / "data" / "runtime" / "nexus-browser" / "tlo-ownership"
_MAX_BYTES = 32 * 1024


def _canonical(record: dict) -> str:
    fields = ("schema", "protocolVersion", "mode", "serverSessionId", "sourceFingerprint",
              "scopeId", "ownerId", "ownerGeneration", "browserWorkspaceId",
              "browserGeneration", "browserDigest", "revision", "createdAt", "expiresAt")
    return "\n".join(f"{key}={record.get(key, '')}" for key in fields)


def source_identity(root: Path = _ROOT) -> tuple[str, str]:
    manifest_path = root / "config" / "tlo-phase3d-source-manifest.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    paths = sorted(set(str(item) for item in manifest.get("paths", [])))
    if (manifest.get("schema") != MANIFEST_SCHEMA or not manifest.get("protocolVersion")
            or "config/tlo-phase3d-source-manifest.json" not in paths):
        raise BackendTransportAuthError("Phase 3D source manifest is invalid.")
    aggregate = hashlib.sha256()
    for relative in paths:
        candidate = (root / Path(relative)).resolve()
        if not relative or ".." in Path(relative).parts or root not in candidate.parents:
            raise BackendTransportAuthError("Phase 3D source manifest contains an unsafe path.")
        digest = hashlib.sha256(candidate.read_bytes()).hexdigest()
        aggregate.update(f"{relative}\0{digest}\n".encode("utf-8"))
    return str(manifest["protocolVersion"]), aggregate.hexdigest()


class RuntimeBackendAuthority:
    """Reloads only exact, protected, current-source activation and owner records."""

    def __init__(self, *, activation_path: Path = _DEFAULT_ACTIVATION,
                 ownership_dir: Path = _DEFAULT_OWNERS, now_ms=None):
        self._activation_path = Path(activation_path)
        self._ownership_dir = Path(ownership_dir)
        self._now_ms = now_ms
        self._lock = threading.RLock()
        self._cached_revision = None
        self._cached_authorizer = None

    @staticmethod
    def _regular_json(path: Path, maximum: int) -> dict | None:
        try:
            stat = path.lstat()
        except FileNotFoundError:
            return None
        if path.is_symlink() or not path.is_file() or stat.st_size <= 0 or stat.st_size > maximum:
            raise BackendTransportAuthError("Phase 3D runtime record is not a bounded regular file.")
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, ValueError) as exc:
            raise BackendTransportAuthError("Phase 3D runtime record cannot be decoded.") from exc

    def _activation(self, *, require_active: bool) -> dict | None:
        record = self._regular_json(self._activation_path, _MAX_BYTES)
        if record is None:
            if require_active:
                raise BackendTransportAuthError("TLO backend transport is disabled.")
            return None
        protocol, fingerprint = source_identity()
        required = (record.get("schema") == SCHEMA and record.get("protocolVersion") == protocol
                    and record.get("sourceFingerprint") == fingerprint
                    and _ID.fullmatch(str(record.get("serverSessionId") or ""))
                    and _ID.fullmatch(str(record.get("ownerId") or ""))
                    and isinstance(record.get("ownerGeneration"), int)
                    and record["ownerGeneration"] > 0 and isinstance(record.get("secret"), str)
                    and len(record["secret"]) >= 32 and isinstance(record.get("expiresAt"), (int, float))
                    and _HASH.fullmatch(str(record.get("integrity") or "")))
        if not required:
            raise BackendTransportAuthError("TLO activation is incomplete or mixed-version.")
        expected = hmac.new(record["secret"].encode(), _canonical(record).encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, record["integrity"]):
            raise BackendTransportAuthError("TLO activation integrity failed.")
        stamp = int(self._now_ms()) if self._now_ms else int(time.time() * 1000)
        if stamp > int(record["expiresAt"]):
            raise BackendTransportAuthError("TLO activation lease expired.")
        if require_active and record.get("mode") != "active":
            raise BackendTransportAuthError("TLO backend transport is disabled.")
        return record

    def _owner(self, scope_id: str) -> dict | None:
        payload = self._regular_json(self._ownership_dir / f"{scope_id}.json", 16 * 1024)
        if payload is None:
            return None
        state = payload.get("state") if payload.get("schema") == "eveos.tlo-ownership-durable-cas.v1" else None
        if not isinstance(state, dict) or state.get("scopeId") != scope_id:
            raise BackendTransportAuthError("Durable TLO owner record is invalid.")
        return state

    def browser_owner_allowed(self, scope_id: str) -> bool:
        try:
            activation = self._activation(require_active=False)
            owner = self._owner(scope_id)
            if activation is not None and activation.get("mode") in {"handed_off", "active"}:
                return False
            return owner is None or (owner.get("owner", {}).get("kind") == "browser"
                                     and owner.get("handoff") is None)
        except BackendTransportAuthError:
            return False

    def backend_enabled(self) -> bool:
        try:
            return self._activation(require_active=True) is not None
        except BackendTransportAuthError:
            return False

    def authorize(self, headers, payload: dict) -> dict:
        with self._lock:
            record = self._activation(require_active=True)
            if self._cached_revision != record.get("revision"):
                self._cached_authorizer = BackendTransportAuthorizer(
                    secret=record["secret"], server_session_id=record["serverSessionId"],
                    owner_id=record["ownerId"], owner_generation=record["ownerGeneration"],
                    scope_id=record.get("scopeId", "default"), now_ms=self._now_ms)
                self._cached_revision = record.get("revision")
            envelope = self._cached_authorizer.authorize(headers, payload)
            owner = self._owner(str(envelope["scopeId"]))
            identity = owner.get("owner") if isinstance(owner, dict) else None
            turn = owner.get("turn") if isinstance(owner, dict) else None
            if (identity != {"kind": "backend", "id": record["ownerId"]}
                    or owner.get("generation") != record["ownerGeneration"]
                    or owner.get("handoff") is not None or not isinstance(turn, dict)
                    or turn.get("phase") != "dispatched" or turn.get("requestId") != envelope["requestId"]):
                raise BackendTransportAuthError("Durable TLO owner or dispatched request does not match.")
            return envelope


RUNTIME_AUTHORITY = RuntimeBackendAuthority()
