"""World Portal package, host bridge, privacy, and child lifecycle smoke."""

from __future__ import annotations

import http.client
import http.server
import json
import socket
import subprocess
import sys
import tempfile
import textwrap
import threading
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
WORLD_BOOK = ROOT / "tools" / "World-Book"
PORTAL = WORLD_BOOK / "tools" / "World-Portal"
for candidate in (ROOT, WORLD_BOOK, PORTAL):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from eveos_runtime import EveOSPortalMixin  # noqa: E402
from worldbook_runtime.bootstrap import load_runtime  # noqa: E402


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def wait_until(predicate, timeout: float = 5.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def request(port: int, method: str, path: str, origin: str) -> tuple[int, dict, str]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request(method, path, headers={"Origin": origin})
        response = connection.getresponse()
        body = response.read()
        payload = json.loads(body.decode("utf-8")) if body else {}
        return response.status, payload, response.getheader("Access-Control-Allow-Origin") or ""
    finally:
        connection.close()


def assert_static_contract() -> None:
    assert PORTAL.is_dir() and not (PORTAL / ".git").exists()
    portal_server = (PORTAL / "server.py").read_text(encoding="utf-8")
    portal_html = (PORTAL / "index.html").read_text(encoding="utf-8")
    portal_bridge = (PORTAL / "assets" / "js" / "eveos-host-bridge.js").read_text(encoding="utf-8")
    portal_main = (PORTAL / "assets" / "js" / "main.js").read_text(encoding="utf-8")
    portal_scene = (PORTAL / "assets" / "js" / "scene" / "create-scene.js").read_text(encoding="utf-8")
    earth_shader = (PORTAL / "assets" / "js" / "scene" / "shaders" / "earth-fragment.js").read_text(encoding="utf-8")
    world_html = (WORLD_BOOK / "app" / "index.html").read_text(encoding="utf-8")
    world_view = (WORLD_BOOK / "app" / "assets" / "js" / "world-portal-view.js").read_text(encoding="utf-8")
    responsive = (WORLD_BOOK / "app" / "assets" / "css" / "layers" / "73-header-responsive.css").read_text(encoding="utf-8")
    overlay = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.overlay.js").read_text(encoding="utf-8")
    detached = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.detach.js").read_text(encoding="utf-8")
    state = (ROOT / "js" / "modules" / "core" / "state.js").read_text(encoding="utf-8")

    assert "EveOSPortalMixin" in portal_server and '"--strict-port"' in portal_server
    assert "eveos-host-bridge.js" in portal_html
    assert "sessionStorage" in portal_bridge and "localStorage" not in portal_bridge
    assert 'id="world-portal-btn"' in world_html and 'id="world-portal-view"' in world_html
    assert "world-portal-detach-btn" in world_html and "world-book:context" in world_view
    assert "Starting World Portal" in world_view and "location.replace" in world_view
    assert "embedded=world-book" in world_view
    assert 'embedMode !== "world-book"' in portal_main
    assert "embeddedInWorldBook ? 1.35 : 2" in portal_scene and "1000 / 45" in portal_scene
    assert "if (globePoleCap > 0.001)" in earth_shader and "polarRingAverage(vUv.y)" in earth_shader
    assert "grid-column: 1 / -1" in responsive and "repeat(2, minmax(0, 1fr))" in responsive
    assert 'data-world-book-view="portal"' in overlay and "data-world-portal-frame" in overlay
    assert "view=world-portal&embedded=1" in detached
    assert "worldPortalPort: 8770" in state

    manifest = json.loads((WORLD_BOOK / "worldbook_runtime" / "layers" / "manifest.json").read_text(encoding="utf-8"))
    names = [entry["file"] if isinstance(entry, dict) else entry for entry in manifest]
    assert names.index("74_world_portal.py") < names.index("80_http_handler.py")

    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    for marker in (
        "tools/World-Book/tools/World-Portal/assets/data/outer-sync/",
        "tools/World-Book/tools/World-Portal/assets/data/outer-tools.runtime.json",
        "tools/World-Book/tools/World-Portal/assets/textures/earth-blue-marble.png",
    ):
        assert marker in ignore


class HealthHandler(EveOSPortalMixin, http.server.BaseHTTPRequestHandler):
    @staticmethod
    def portal_app_version() -> str:
        return "smoke"

    def do_GET(self) -> None:  # noqa: N802
        if not self._eveos_health():
            self.send_error(404)

    def log_message(self, *_args) -> None:
        return


def assert_host_contract() -> None:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), HealthHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, payload, cors = request(server.server_port, "GET", "/api/health", "null")
        assert status == 200 and payload == {"ok": True, "service": "world-portal", "appVersion": "smoke"}
        assert cors == "null"
        status, _, cors = request(server.server_port, "OPTIONS", "/api/health", "https://example.com")
        assert status == 403 and not cors
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def assert_lifecycle_contract() -> None:
    runtime = load_runtime()
    with tempfile.TemporaryDirectory(prefix="eveos-world-portal-") as temporary:
        fake = Path(temporary) / "portal.py"
        fake.write_text(textwrap.dedent("""
            import argparse, json
            from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
            parser = argparse.ArgumentParser()
            parser.add_argument('--host', default='127.0.0.1')
            parser.add_argument('--port', type=int, required=True)
            parser.add_argument('--no-browser', action='store_true')
            parser.add_argument('--strict-port', action='store_true')
            args = parser.parse_args()
            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path != '/api/health': return self.send_error(404)
                    body = json.dumps({'ok': True, 'service': 'world-portal', 'appVersion': 'smoke'}).encode()
                    self.send_response(200); self.send_header('Content-Length', str(len(body)))
                    self.end_headers(); self.wfile.write(body)
                def log_message(self, *_args): pass
            ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
        """).strip() + "\n", encoding="utf-8")

        keys = ("WORLD_PORTAL_PORT", "WORLD_PORTAL_PROCESS", "CONFIG", "world_portal_entry",
                "save_config", "world_portal_listener_pids")
        original = {key: runtime[key] for key in keys}
        try:
            runtime["WORLD_PORTAL_PORT"] = free_port()
            runtime["WORLD_PORTAL_PROCESS"] = None
            runtime["CONFIG"] = {"worldPortalDesired": False}
            runtime["world_portal_entry"] = lambda: fake
            runtime["save_config"] = lambda: None
            runtime["world_portal_listener_pids"] = lambda: []
            started = runtime["start_world_portal"]()
            assert started["ok"] and wait_until(lambda: runtime["world_portal_status"]()["running"])
            assert runtime["CONFIG"]["worldPortalDesired"] is True
            stopped = runtime["stop_world_portal"]()
            assert stopped["ok"] and not stopped["running"]
            assert runtime["CONFIG"]["worldPortalDesired"] is False
        finally:
            if runtime["WORLD_PORTAL_PROCESS"] and runtime["WORLD_PORTAL_PROCESS"].poll() is None:
                runtime["stop_world_portal"](persist=False)
            runtime.update(original)


def assert_upstream_tests() -> None:
    commands = [
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-p", "test_*.py"],
        ["node", "--test", *[str(path) for path in sorted((PORTAL / "tests").glob("*.test.mjs"))]],
    ]
    for command in commands:
        result = subprocess.run(command, cwd=PORTAL, capture_output=True, text=True, timeout=90, check=False)
        assert result.returncode == 0, result.stdout + result.stderr


if __name__ == "__main__":
    assert_static_contract()
    assert_host_contract()
    assert_lifecycle_contract()
    assert_upstream_tests()
    print("WORLD_PORTAL_INTEGRATION_SMOKE_OK")