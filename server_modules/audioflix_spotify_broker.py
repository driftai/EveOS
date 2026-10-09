"""Authorized local broker between ordinary EveOS tabs and one managed Spotify engine."""
from __future__ import annotations

import hashlib
import json
import re
import secrets
import threading
import time
from collections import OrderedDict
from urllib.parse import urlsplit

from server_modules import audioflix_spotify_browser_rpc as engine
from server_modules import audioflix_spotify_connections as connections

_PROTOCOL_VERSION = 1
_PAIR_TTL_S = 300.0
_CLIENT_TTL_S = 12 * 60 * 60.0
_OWNER_GRACE_S = 15 * 60.0
_MAX_RECEIPTS = 128
_COMMAND_WAIT_S = 195.0


def _now() -> float:
    return time.monotonic()


def _safe(value, limit=240) -> str:
    return str(value or "").strip()[:limit]


def _fingerprint(action: str, payload: dict) -> str:
    raw = json.dumps({"action": action, "payload": payload}, sort_keys=True, separators=(",", ":"), default=str)
    return hashlib.sha256(raw.encode("utf-8")).hexdigest()


def _spotify_id(value) -> str:
    match = re.search(
        r"(?:spotify:track:|open\.spotify\.com/(?:embed/)?track/)?([A-Za-z0-9]{22})(?:[?/#]|$)?",
        str(value or ""), re.I,
    )
    return match.group(1) if match else ""


def _origin(value) -> str:
    try:
        parsed = urlsplit(str(value or ""))
    except ValueError:
        return ""
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or not parsed.port:
        return ""
    host = parsed.hostname.lower()
    if host not in {"127.0.0.1", "localhost", "::1"}:
        return ""
    shown = f"[{host}]" if ":" in host else host
    return f"{parsed.scheme}://{shown}:{parsed.port}"


class SpotifyClientBroker:
    def __init__(self):
        self._lock = threading.RLock()
        self._transport_lock = threading.RLock()
        self._pairings: dict[str, dict] = {}
        self._clients: dict[str, dict] = {}
        self._tokens: dict[str, str] = {}
        self._owner_client_id = ""
        self._owner_epoch = 0
        self._track_generation = 0
        self._engine_epoch = 0
        self._engine_started_at = 0

    def _expire_locked(self) -> None:
        now = _now()
        for pair_id, pair in list(self._pairings.items()):
            if pair["expiresAt"] <= now:
                self._pairings.pop(pair_id, None)
        for client_id, client in list(self._clients.items()):
            has_pending = any(receipt.get("result") is None for receipt in client["receipts"].values())
            if client["expiresAt"] <= now and not has_pending:
                self._clients.pop(client_id, None)
                self._tokens.pop(client["token"], None)
                if self._owner_client_id == client_id:
                    self._owner_client_id = ""
                    self._owner_epoch += 1
        owner = self._clients.get(self._owner_client_id)
        if owner and now - owner["lastSeen"] > _OWNER_GRACE_S:
            self._owner_client_id = ""
            self._owner_epoch += 1
            threading.Thread(target=lambda: engine.transport({"action": "pause"}), daemon=True).start()

    def _new_client_locked(self, mode: str, parent_origin: str, document_id: str, library_scope_id: str) -> dict:
        client_id = f"afc-{secrets.token_hex(8)}"
        token = secrets.token_urlsafe(32)
        now = _now()
        client = {
            "clientId": client_id, "token": token, "mode": mode, "parentOrigin": parent_origin,
            "documentId": _safe(document_id, 120), "libraryScopeId": _safe(library_scope_id, 160),
            "createdAt": now, "lastSeen": now, "expiresAt": now + _CLIENT_TTL_S,
            "seq": 0, "jobSeq": 0, "receipts": OrderedDict(),
        }
        self._clients[client_id] = client
        self._tokens[token] = client_id
        return client

    def _matching_file_client_locked(self, document_id: str, library_scope_id: str) -> dict | None:
        return connections.matching_file(self, document_id, library_scope_id, _now, _CLIENT_TTL_S)

    def connect(self, payload: dict, context: dict) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        context = context if isinstance(context, dict) else {}
        with self._transport_lock, self._lock:
            self._expire_locked()
            server_origin = _origin(context.get("serverOrigin"))
            parent_origin = _safe(payload.get("parentOrigin"), 300)
            mode = _safe(payload.get("mode"), 20).lower()
            document_id = _safe(payload.get("documentId"), 120)
            library_scope_id = _safe(payload.get("libraryScopeId"), 160)
            if not server_origin:
                return {"ok": False, "reason": "Spotify relay requires a loopback EveOS server origin."}
            if mode == "localhost":
                if _origin(parent_origin) != server_origin:
                    return {"ok": False, "reason": "The parent EveOS origin does not match this relay origin."}
                return self._client_grant(self._new_client_locked(mode, parent_origin, document_id, library_scope_id))
            if mode != "file" or parent_origin != "null":
                return {"ok": False, "reason": "Unsupported Spotify relay parent origin."}
            try:
                existing = self._matching_file_client_locked(document_id, library_scope_id)
            except RuntimeError as exc:
                return {"ok": False, "reason": _safe(exc)}
            if existing:
                return self._client_grant(existing)
            pair_id = secrets.token_urlsafe(18)
            code = f"{secrets.randbelow(1000000):06d}"
            now = _now()
            self._pairings[pair_id] = {
                "pairId": pair_id, "code": code, "csrf": secrets.token_urlsafe(24),
                "documentId": document_id, "libraryScopeId": library_scope_id,
                "parentOrigin": parent_origin, "serverOrigin": server_origin,
                "approved": False, "clientId": "", "createdAt": now,
                "expiresAt": now + _PAIR_TTL_S,
            }
            return {
                "ok": True, "pairingRequired": True, "pairId": pair_id, "code": code,
                "approvalUrl": f"{server_origin}/api/audioflix/spotify-approval?pair={pair_id}",
                "expiresIn": int(_PAIR_TTL_S),
            }

    def pairing_view(self, pair_id: str) -> dict:
        with self._lock:
            self._expire_locked()
            pair = self._pairings.get(_safe(pair_id, 120))
            if not pair:
                return {"ok": False, "reason": "Pairing request expired or was not found."}
            return {
                "ok": True, "pairId": pair["pairId"], "code": pair["code"], "csrf": pair["csrf"],
                "approved": pair["approved"], "expiresIn": max(0, int(pair["expiresAt"] - _now())),
            }

    def approve(self, payload: dict) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        with self._lock:
            self._expire_locked()
            pair = self._pairings.get(_safe(payload.get("pairId"), 120))
            csrf = _safe(payload.get("csrf"), 200)
            if not pair or not csrf or not secrets.compare_digest(csrf, pair["csrf"]):
                return {"ok": False, "reason": "Invalid or expired pairing approval."}
            if not pair["approved"]:
                client = self._new_client_locked(
                    "file", pair["parentOrigin"], pair["documentId"], pair["libraryScopeId"]
                )
                pair["approved"] = True
                pair["clientId"] = client["clientId"]
            return {"ok": True, "approved": True, "code": pair["code"]}

    def pair_status(self, payload: dict) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        with self._lock:
            self._expire_locked()
            pair = self._pairings.get(_safe(payload.get("pairId"), 120))
            if not pair:
                return {"ok": False, "reason": "Pairing request expired or was not found."}
            if not pair["approved"]:
                return {"ok": True, "approved": False, "code": pair["code"]}
            client = self._clients.get(pair["clientId"])
            if not client:
                return {"ok": False, "reason": "Approved client expired."}
            return {**self._client_grant(client), "approved": True}

    def _client_grant(self, client: dict) -> dict:
        return {
            "ok": True, "connected": True, "protocolVersion": _PROTOCOL_VERSION,
            "clientId": client["clientId"], "clientToken": client["token"], "mode": client["mode"],
            "expiresIn": max(0, int(client["expiresAt"] - _now())),
            **connections.grant(client),
        }

    def _authorized_client_locked(self, token: str) -> dict | None:
        client_id = self._tokens.get(_safe(token, 200))
        client = self._clients.get(client_id or "")
        if not client:
            return None
        client["lastSeen"] = _now()
        client["expiresAt"] = client["lastSeen"] + _CLIENT_TTL_S
        return client

    def _sync_engine_epoch_locked(self, managed: dict) -> None:
        started = int(managed.get("engineStartedAt") or 0)
        if started and started != self._engine_started_at:
            self._engine_started_at = started
            self._engine_epoch += 1
            self._owner_client_id = ""
            self._owner_epoch += 1

    def _acquire_locked(self, client: dict) -> None:
        if self._owner_client_id != client["clientId"]:
            self._owner_client_id = client["clientId"]
            self._owner_epoch += 1

    def _owner_block(self, client_id: str, action: str) -> dict | None:
        with self._lock: owner = self._owner_client_id
        if not owner or owner == client_id: return None
        return {**self._state(client_id), "ok": False, "observer": True,
                "reason": f"Another EveOS tab owns Spotify playback. Take control before {action}."}

    def _state(self, client_id: str, transport_state: dict | None = None) -> dict:
        managed = engine.status()
        state = transport_state
        if state is None and managed.get("helperReachable"):
            response = engine.transport({"action": "status"})
            state = response.get("state") if response.get("ok") else None
        with self._lock:
            self._sync_engine_epoch_locked(managed)
            engine_generation = max(0, int((state or {}).get("generation") or 0))
            if engine_generation > self._track_generation:
                self._track_generation = engine_generation
            return {
                "ok": True, "connected": True, "clientId": client_id,
                "isOwner": self._owner_client_id == client_id, "ownerClientId": self._owner_client_id,
                "ownerEpoch": self._owner_epoch, "engineEpoch": self._engine_epoch,
                "trackGeneration": self._track_generation, "engine": state or {},
                "managed": {
                    "browserRunning": bool(managed.get("browserRunning")),
                    "helperReachable": bool(managed.get("helperReachable")),
                    "authState": managed.get("authState") or "unknown",
                    "state": managed.get("state") or "stopped",
                    "presentation": managed.get("presentation") or "hidden",
                    "lastError": managed.get("lastError") or "",
                    "importing": bool(managed.get("importing")),
                },
            }

    def _start_engine(self, server_origin: str) -> dict:
        result = engine.ensure_engine(f"{server_origin}/audioflix-spotify-engine.html")
        with self._lock:
            self._sync_engine_epoch_locked(result)
        return result

    def command(self, payload: dict, context: dict) -> dict:
        payload = payload if isinstance(payload, dict) else {}
        context = context if isinstance(context, dict) else {}
        wait_event = None
        with self._lock:
            self._expire_locked()
            client = self._authorized_client_locked(payload.get("clientToken"))
            if not client:
                return {"ok": False, "reason": "Spotify client authorization is missing or expired."}
            command = payload.get("command") if isinstance(payload.get("command"), dict) else {}
            action = _safe(command.get("action"), 40).lower()
            connection_id = _safe(command.get("connectionId"), 120)
            if not connections.current(client, connection_id, detach=action == "detach"):
                return connections.rejected()
            args = command.get("payload") if isinstance(command.get("payload"), dict) else {}
            command_id = _safe(command.get("commandId"), 120)
            try:
                seq = max(0, int(command.get("clientCommandSeq") or 0))
            except (TypeError, ValueError):
                seq = 0
            if not command_id or seq <= 0:
                return {"ok": False, "reason": "commandId and clientCommandSeq are required."}
            fp = _fingerprint(action, args)
            prior = client["receipts"].get(command_id)
            if prior:
                if prior["fingerprint"] != fp:
                    return {"ok": False, "reason": "commandId was reused with different input."}
                if prior.get("result") is not None:
                    return prior["result"]
                wait_event = prior["event"]
            else:
                seq_key = "jobSeq" if action in {"import", "auth"} else "seq"
                if action not in {"status", "detach"} and seq <= client[seq_key]:
                    return {"ok": False, "resyncRequired": True, "reason": "Stale Spotify client command sequence."}
                if action not in {"status", "detach"}:
                    client[seq_key] = seq
                client["receipts"][command_id] = {
                    "fingerprint": fp, "result": None, "event": threading.Event()
                }
                server_origin = _origin(context.get("serverOrigin"))
                client_id = client["clientId"]

        if wait_event is not None:
            wait_event.wait(_COMMAND_WAIT_S)
            with self._lock:
                client = self._clients.get(self._tokens.get(_safe(payload.get("clientToken"), 200), ""))
                receipt = client and client["receipts"].get(command_id)
                if receipt and receipt.get("result") is not None:
                    return receipt["result"]
            return {"ok": False, "pending": True, "reason": "The matching Spotify command is still running."}

        try:
            if action == "import":
                started = self._start_engine(server_origin)
                result = started if not started.get("helperReachable") else engine.import_playlist(_safe(args.get("url"), 2400))
            elif action == "auth":
                started = self._start_engine(server_origin)
                result = started if not started.get("helperReachable") else engine.auth(
                    bool(args.get("openLogin", True)), _safe(args.get("url"), 2400)
                )
            else:
                with self._transport_lock:
                    result = self._execute_transport(client_id, action, args, server_origin, connection_id)
        except Exception as exc:
            result = {"ok": False, "reason": _safe(exc, 300)}

        with self._lock:
            client = self._clients.get(client_id)
            receipt = client and client["receipts"].get(command_id)
            if receipt:
                receipt["result"] = result
                receipt["event"].set()
                while len(client["receipts"]) > _MAX_RECEIPTS:
                    first_key, first_value = next(iter(client["receipts"].items()))
                    if first_value.get("result") is None:
                        break
                    client["receipts"].pop(first_key, None)
        return result

    def _execute_transport(self, client_id: str, action: str, args: dict, server_origin: str, connection_id: str) -> dict:
        if action in {"release", "detach"}:
            return connections.release(self, client_id, connection_id, reset=action == "detach")
        with self._lock:
            if not connections.current(self._clients.get(client_id), connection_id):
                return connections.rejected()
        if action == "status":
            return self._state(client_id)
        if action == "take-control":
            with self._lock:
                client = self._clients.get(client_id)
                if not client:
                    return {"ok": False, "reason": "Spotify client expired."}
                self._acquire_locked(client)
            return self._state(client_id)
        if action == "engine-presentation":
            blocked = self._owner_block(client_id, "changing the engine mode")
            if blocked: return blocked
            mode = _safe(args.get("mode"), 20).lower()
            result = engine.set_presentation(mode, f"{server_origin}/audioflix-spotify-engine.html")
            return {**self._state(client_id), "presentationResult": result, "ok": bool(result.get("ok"))}
        if action == "engine-stop":
            blocked = self._owner_block(client_id, "stopping the engine")
            if blocked: return blocked
            stopped = engine.stop_engine()
            with self._lock:
                self._owner_client_id = ""
                self._owner_epoch += 1
            return {**self._state(client_id), "engineStopResult": stopped, "ok": bool(stopped.get("ok"))}
        if action == "play":
            spotify_id = _spotify_id(args.get("spotifyId") or args.get("url"))
            if not spotify_id:
                return {"ok": False, "reason": "A valid Spotify track ID is required."}
            started = self._start_engine(server_origin)
            if not started.get("ok") or not started.get("helperReachable"):
                return {"ok": False, "reason": started.get("reason") or "Managed Spotify engine did not start."}
            with self._lock:
                client = self._clients.get(client_id)
                if not client:
                    return {"ok": False, "reason": "Spotify client expired."}
                self._acquire_locked(client)
                self._track_generation += 1
                generation = self._track_generation
            loaded = engine.transport({
                "action": "load", "spotifyId": spotify_id, "title": _safe(args.get("title"), 240),
                "duration": max(0, float(args.get("duration") or 0)), "generation": generation,
            })
            if not loaded.get("ok"):
                return loaded
            gain = max(0.0, min(1.0, float(args.get("effectiveVolume") if args.get("effectiveVolume") is not None else 1)))
            volume = engine.set_effective_volume(gain, spotify_id)
            if not volume.get("ok"):
                return volume
            played = engine.transport({"action": "play"})
            return self._state(client_id, played.get("state")) if played.get("ok") else played

        with self._lock:
            owner = self._owner_client_id
            client = self._clients.get(client_id)
            if not owner and action in {"resume", "volume", "seek", "restart"} and client:
                self._acquire_locked(client)
                owner = client_id
        if owner and owner != client_id:
            state = self._state(client_id)
            return {**state, "ok": False, "observer": True,
                    "reason": "Another EveOS tab owns Spotify playback. Use Take control or Play to transfer it."}
        if not owner and action in {"pause", "stop", "release"}:
            state = self._state(client_id)
            return {**state, "ok": True, "idle": True,
                    "reason": "Spotify engine has no active owner. Press Play to begin playback."}
        if action == "volume":
            gain = max(0.0, min(1.0, float(args.get("effectiveVolume") if args.get("effectiveVolume") is not None else 1)))
            volume = engine.set_effective_volume(gain, _spotify_id(args.get("spotifyId") or ""))
            return {**self._state(client_id), "volumeResult": volume, "ok": bool(volume.get("ok"))}
        if action in {"pause", "resume", "stop", "restart"}:
            mapped = "play" if action == "resume" else action
            command = {"action": mapped}
            if action == "restart":
                with self._lock:
                    self._track_generation += 1
                    command["generation"] = self._track_generation
            response = engine.transport(command)
            if action == "stop" and response.get("ok"):
                with self._lock:
                    if self._owner_client_id == client_id:
                        self._owner_client_id = ""
                        self._owner_epoch += 1
            return self._state(client_id, response.get("state")) if response.get("ok") else response
        if action == "seek":
            response = engine.transport({"action": "seek", "seconds": max(0.0, float(args.get("seconds") or 0))})
            return self._state(client_id, response.get("state")) if response.get("ok") else response
        return {"ok": False, "reason": f"Unsupported Spotify client action: {action or '(empty)'}"}


_broker = SpotifyClientBroker()
def connect(payload: dict, context: dict) -> dict: return _broker.connect(payload, context)
def pairing_view(pair_id: str) -> dict: return _broker.pairing_view(pair_id)
def approve(payload: dict) -> dict: return _broker.approve(payload)
def pair_status(payload: dict) -> dict: return _broker.pair_status(payload)
def command(payload: dict, context: dict) -> dict: return _broker.command(payload, context)
