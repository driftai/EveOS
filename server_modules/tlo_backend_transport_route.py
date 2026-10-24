"""Default-disabled authenticated HTTP boundary for backend-owned TLO turns."""

from __future__ import annotations

from http import HTTPStatus

from server_modules.eve_state_store_api_helpers import send_json
from server_modules.tlo_backend_transport_auth import BackendTransportAuthError
from server_modules.tlo_backend_runtime_config import RUNTIME_AUTHORITY


BACKEND_PATH_SUFFIX = "/backend/chat/stream"
_authorizer = None
_browser_owner_check = None
_UNSET = object()


def configure(*, backend_authorizer=_UNSET, browser_owner_check=_UNSET) -> None:
    global _authorizer, _browser_owner_check
    if backend_authorizer is _UNSET and browser_owner_check is _UNSET:
        _authorizer = None
        _browser_owner_check = None
        return
    if backend_authorizer is not _UNSET and backend_authorizer is not None and not callable(getattr(backend_authorizer, "authorize", None)):
        raise TypeError("backend_authorizer must expose authorize()")
    if browser_owner_check is not _UNSET and browser_owner_check is not None and not callable(browser_owner_check):
        raise TypeError("browser_owner_check must be callable")
    if backend_authorizer is not _UNSET:
        _authorizer = backend_authorizer
    if browser_owner_check is not _UNSET:
        _browser_owner_check = browser_owner_check


def browser_owner_allowed(scope_id: str) -> bool:
    return (_browser_owner_check(scope_id) is True) if _browser_owner_check is not None \
        else RUNTIME_AUTHORITY.browser_owner_allowed(scope_id)


def handle(handler, *, read_body, stream_chat) -> bool:
    authorizer = _authorizer or RUNTIME_AUTHORITY
    if _authorizer is None and not RUNTIME_AUTHORITY.backend_enabled():
        send_json(handler, HTTPStatus.SERVICE_UNAVAILABLE, {
            "ok": False, "state": "backend_disabled", "error": "TLO backend transport is disabled."
        })
        return True
    payload = read_body(handler)
    try:
        authorizer.authorize(getattr(handler, "headers", None), payload)
    except BackendTransportAuthError as exc:
        send_json(handler, HTTPStatus.FORBIDDEN, {
            "ok": False, "state": "backend_forbidden", "error": str(exc)
        })
        return True
    stream_chat(handler, payload)
    return True
