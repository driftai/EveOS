"""Shared response policy: persistent static assets, private close-framed APIs."""

from http import HTTPStatus
from pathlib import Path

from .eveos_http_cors import eveos_cors_origin
from .audioflix_provider_file_auth import is_private_static_path


_PRIVATE_ROOTS = {
    (".git",), (".codex",), (".claude",), (".gemini",), (".cursor",),
    (".agents-private",), (".openclaw",), (".hermes",), ("data", "runtime"),
    ("data", "modular-state"), ("data", "modular-packs"), ("data", "spatial-notes"),
}
_PRIVATE_DOCS = {
    "agents.override.md", "agents.local.md", "claude.local.md", "gemini.local.md",
    "soul.md", "memory.md", "user.md", "identity.md",
}
_PUBLIC_AGENT_SEED = {"agent.md", "nexus.md", "origin.md", "runtime.json"}


def is_private_repo_path(relative):
    parts = tuple(part.casefold() for part in Path(relative).parts)
    if len(parts) > 2 and parts[:2] == ("config", "agents"):
        if parts[2] == "tlo":
            return len(parts) > 3 and (len(parts) != 4 or parts[3] not in _PUBLIC_AGENT_SEED)
        if parts[2] != "capabilities":
            return True
    return bool(parts) and (
        any(parts[:len(root)] == root for root in _PRIVATE_ROOTS)
        or any((part,) in _PRIVATE_ROOTS for part in parts)
        or parts[-1] in _PRIVATE_DOCS
        or parts == ("data", "agent-management.json")
    )


class EveOSHTTPHeadersMixin:
    """Keep legacy API framing isolated from HTTP/1.1 static connection reuse."""

    protocol_version = "HTTP/1.1"

    def send_head(self):
        # The static handler serves both GET and HEAD. Check the URL path and
        # resolved file so aliases cannot expose runtime state.
        root = Path(self.directory).absolute()
        target = Path(self.translate_path(self.path)).absolute()
        try:
            resolved_root = root.resolve()
            candidates = [target]
            if target.is_dir():
                indexes = getattr(self, "index_pages", ("index.html", "index.htm"))
                candidates.extend(target / name for name in indexes if (target / name).is_file())
            private = any(
                is_private_repo_path(file.relative_to(root))
                or is_private_repo_path(file.resolve().relative_to(resolved_root))
                or is_private_static_path(str(file))
                for file in candidates
            )
        except (ValueError, OSError, RuntimeError):
            private = True
        if private:
            self.send_error(HTTPStatus.NOT_FOUND)
            return None
        return super().send_head()

    def list_directory(self, path):
        # Directory indexes can reveal local filenames even when files are denied.
        self.send_error(HTTPStatus.NOT_FOUND)
        return None

    def end_headers(self):
        if (self.path or "").split("?", 1)[0] == "/agent-management-embedded.html":
            self.send_header("Content-Security-Policy", "frame-ancestors file: http://localhost:* http://127.0.0.1:*")
        # Add CORS headers to all responses (Origin allow-listed; see eveos_cors_origin).
        has_acao = any(b'access-control-allow-origin:' in h.lower() for h in self._headers_buffer)
        if not has_acao:
            _acao = eveos_cors_origin(self.headers.get("Origin"))
            if _acao is not None:
                self.send_header("Access-Control-Allow-Origin", _acao)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Requested-With, X-EveOS-Provider-Capture, X-EveOS-Provider-File-Auth")
        self.send_header("Access-Control-Max-Age", "86400")  # 24 hours
        self._send_cache_control()
        super().end_headers()

    def _send_cache_control(self):
        """Keep APIs private and force localhost assets to revalidate before reuse.

        Committed asset URLs carry generated content fingerprints for deterministic file://
        loading. Local development can change a file before those fingerprints are rebuilt, so
        localhost deliberately revalidates every static response instead of trusting a stale URL.
        """
        path = self.path or ""
        if path.startswith("/api/"):
            # Some legacy helpers omit Content-Length. They must end at EOF, not
            # leave a persistent client waiting for an unframed response body.
            self.close_connection = True
            self.send_header("Connection", "close")
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        else:
            # Content fingerprints make file:// loads deterministic. Localhost still
            # revalidates every asset so an unsynchronized development edit cannot
            # leave an existing browser tab pinned to yesterday's implementation.
            self.send_header("Cache-Control", "no-cache")
