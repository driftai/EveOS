"""Shared response policy: persistent static assets, private close-framed APIs."""

from .eveos_http_cors import eveos_cors_origin


class EveOSHTTPHeadersMixin:
    """Keep legacy API framing isolated from HTTP/1.1 static connection reuse."""

    protocol_version = "HTTP/1.1"

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
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Requested-With")
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
