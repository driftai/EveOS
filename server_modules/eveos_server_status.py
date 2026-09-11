"""Verified status contract for the canonical EveOS localhost server."""

from . import eveos_exposure


SERVICE_NAME = "eveos-local-server"
SERVICE_VERSION = "0.6.0"


def _public_exposure(service: str) -> dict:
    state = eveos_exposure.read_state(service)
    if not state:
        return {"active": False, "mode": "local", "publicUrl": ""}
    return {
        "active": True,
        "mode": str(state.get("mode") or "local"),
        "publicUrl": str(state.get("publicUrl") or ""),
    }


def build_status(server):
    bound_port = int(server.server_address[1])
    return {
        "ok": True,
        "status": "ok",
        "service": SERVICE_NAME,
        "version": SERVICE_VERSION,
        "port": bound_port,
        "url": f"http://127.0.0.1:{bound_port}/EveOS.html",
        # Safe, read-only exposure discovery for an EveOS page that is itself
        # being viewed remotely. Never publish PIDs, local control URLs, paths,
        # credentials, or internal diagnostics here.
        "exposures": {
            "piano": _public_exposure("piano"),
            "worldBook": _public_exposure("world-book"),
            "watchFusion": _public_exposure("watchfusion"),
        },
    }
