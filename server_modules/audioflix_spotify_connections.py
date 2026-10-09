"""Relay attachment leases; callers serialize lifecycle changes with the transport lock."""
from __future__ import annotations

import secrets

from server_modules import audioflix_spotify_browser_rpc as engine


def grant(client: dict) -> dict:
    if not client.get("connectionId"):
        client.update(connectionId=secrets.token_urlsafe(24), detached=False)
    return {"connectionId": client["connectionId"], "sequenceBase": max(client["seq"], client["jobSeq"])}


def current(client: dict | None, connection_id: str, *, detach=False) -> bool:
    return bool(client and connection_id and connection_id == client.get("connectionId")
                and (detach or not client.get("detached")))


def rejected() -> dict:
    return {"ok": False, "disconnected": True, "reason": "Spotify relay attachment was closed or replaced."}


def release(broker, client_id: str, connection_id: str, *, reset=False) -> dict:
    # The transport lock prevents a new Play from interleaving stop and ownership retirement.
    with broker._lock:
        client = broker._clients.get(client_id)
        if not current(client, connection_id, detach=reset):
            return rejected()
        if reset:
            client["detached"] = True
        owns = broker._owner_client_id == client_id
    if not owns:
        return {"ok": True, "detached": reset, "idle": True}
    response = engine.transport({"action": "stop" if reset else "pause"})
    if not response.get("ok"):
        return response
    with broker._lock:
        if broker._owner_client_id == client_id:
            broker._owner_client_id = ""
            broker._owner_epoch += 1
    return {"ok": True, "detached": reset, "engine": response.get("state") or {}, "ownerClientId": ""}


def reconnect(broker, client: dict) -> None:
    result = release(broker, client["clientId"], grant(client)["connectionId"], reset=True)
    if not result.get("ok"):
        raise RuntimeError(result.get("reason") or "Spotify could not reset the previous file-tab playback.")
    client.update(connectionId=secrets.token_urlsafe(24), detached=False)


def matching_file(broker, document_id: str, library_scope_id: str, now, ttl: float) -> dict | None:
    if not document_id or not library_scope_id:
        return None
    for client in broker._clients.values():
        if (client.get("mode") == "file" and client.get("documentId") == document_id
                and client.get("libraryScopeId") == library_scope_id):
            reconnect(broker, client)
            client["lastSeen"] = now()
            client["expiresAt"] = client["lastSeen"] + ttl
            return client
    return None
