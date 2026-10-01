"""Resolve WatchFusion's live Local, LAN, or Cloudflare browser surface."""

from __future__ import annotations


def reconcile_status(decorated: dict, *, local_url: str, remote_url: str = "",
                     network: dict | None = None) -> dict:
    """Prefer live runtime evidence when persisted exposure metadata is stale."""
    if remote_url:
        host_url = str((network or {}).get("localEmbedHost") or local_url).strip()
        decorated.update(exposureMode="cloudflare", publicUrl=remote_url, url=remote_url, hostUrl=host_url)
        return decorated
    if network and network.get("localOnly") is False:
        lan_url = str(
            network.get("canonicalLanHost")
            or network.get("preferredLanHost")
            or network.get("preferredLanAddress")
            or ""
        ).strip()
        if lan_url:
            decorated.update(exposureMode="lan", publicUrl=lan_url, url=lan_url)
        return decorated
    if network and network.get("localOnly") is True:
        host_url = str(network.get("localEmbedHost") or local_url).strip()
        decorated.update(exposureMode="local", publicUrl="", url=host_url, hostUrl=host_url)
    return decorated
