# Shared response policy, loaded before the handler through the runtime manifest.
class WorldBookResponseMixin:
    def allowed_health_origin(self) -> str:
        origin = str(self.headers.get("Origin") or "")
        if origin == "null":
            return origin
        parsed = urlparse(origin)
        if parsed.scheme in {"http", "https"} and parsed.hostname in {"127.0.0.1", "localhost", "::1"}:
            return origin
        return ""

    def end_headers(self) -> None:
        parsed_request = urlparse(self.path)
        if parsed_request.path.startswith("/api/"):
            self.send_header("Cache-Control", "no-store")
        elif "v=" in parsed_request.query:
            # Versioned UI assets are content-addressed by EveOS/World Book cache tokens.
            self.send_header("Cache-Control", "public, max-age=31536000, immutable")
        else:
            # Keep editable local files fresh while still allowing fast conditional reloads.
            self.send_header("Cache-Control", "no-cache")
        if parsed_request.path == "/api/health":
            allowed_origin = self.allowed_health_origin()
            if allowed_origin:
                self.send_header("Access-Control-Allow-Origin", allowed_origin)
                self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
                self.send_header("Access-Control-Allow-Headers", "Content-Type")
                self.send_header("Vary", "Origin")
                if str(self.headers.get("Access-Control-Request-Private-Network") or "").lower() == "true":
                    self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    def send_json(self, payload: object, status: int = 200, headers: dict | None = None) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        if headers:
            for key, value in headers.items():
                self.send_header(key, value)
        self.end_headers()
        self.wfile.write(body)

    def send_error_json(self, status: int, message: str) -> None:
        self.send_json({"ok": False, "error": message}, status)
