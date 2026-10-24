"""Default-disabled authenticated HTTP boundary for backend-owned TLO turns."""

from __future__ import annotations

from http import HTTPStatus

from server_modules.eve_state_store_api_helpers import send_json
from server_modules.tlo_backend_transport_auth import BackendTransportAuthError


BACKEND_PATH_SUFFIX = "/backend/chat/stream"
_authorizer = None
_browser_owner_check = None


def configure(*, backend_authorizer=None, browser_owner_check=None) -> None:
    global _authorizer, _browser_owner_check
    if backend_authorizer is not None and not callable(getattr(backend_authorizer, "authorize", None)):
        raise TypeError("backend_authorizer must expose authorize()")
    if browser_owner_check is not None and not callable(browser_owner_check):
        raise TypeError("browser_owner_check must be callable")
    _authorizer = backend_authorizer
    _browser_owner_check = browser_owner_check


def browser_owner_allowed(scope_id: str) -> bool:
    return _browser_owner_check is None or _browser_owner_check(scope_id) is True


def handle(handler, *, read_body, stream_chat) -> bool:
    if _authorizer is None:
        send_json(handler, HTTPStatus.SERVICE_UNAVAILABLE, {
            "ok": False, "state": "backend_disabled", "error": "TLO backend transport is disabled."
        })
        return True
    payload = read_body(handler)
    try:
        _authorizer.authorize(getattr(handler, "headers", None), payload)
    except BackendTransportAuthError as exc:
        send_json(handler, HTTPStatus.FORBIDDEN, {
            "ok": False, "state": "backend_forbidden", "error": str(exc)
        })
        return True
    stream_chat(handler, payload)
    return True
