"""Piano package, Audioflix host surface, privacy, HTTP, and lifecycle smoke."""

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
PIANO = ROOT / "tools" / "Piano-Auto-Player"
for candidate in (ROOT, PIANO):
    if str(candidate) not in sys.path:
        sys.path.insert(0, str(candidate))

from app import server as piano_server  # noqa: E402
from server_modules import piano_player_control  # noqa: E402


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


def request(port: int, method: str, path: str, origin: str = "null") -> tuple[int, bytes, str]:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request(method, path, headers={"Origin": origin})
        response = connection.getresponse()
        return response.status, response.read(), response.getheader("Access-Control-Allow-Origin") or ""
    finally:
        connection.close()


def assert_static_contract() -> None:
    assert PIANO.is_dir() and not (PIANO / ".git").exists()
    html = (ROOT / "EveOS.html").read_text(encoding="utf-8")
    ui = (ROOT / "js" / "modules" / "features" / "audioflix" / "audioflix.ui.js").read_text(encoding="utf-8")
    actions = (ROOT / "js" / "modules" / "features" / "audioflix" / "audioflix.ui.actions.js").read_text(encoding="utf-8")
    piano_ui = (ROOT / "js" / "modules" / "features" / "audioflix" / "audioflix.piano.ui.js").read_text(encoding="utf-8")
    piano_css = (ROOT / "js" / "modules" / "features" / "audioflix" / "audioflix.piano.css").read_text(encoding="utf-8")
    piano_client = (ROOT / "js" / "modules" / "features" / "audioflix" / "audioflix.piano.client.js").read_text(encoding="utf-8")
    bridge = (PIANO / "web" / "eveos-host-bridge.js").read_text(encoding="utf-8")
    piano_app = (PIANO / "web" / "app.js").read_text(encoding="utf-8")
    workspace = (PIANO / "web" / "sheet_workspace.js").read_text(encoding="utf-8")
    bulk = (PIANO / "web" / "bulk_conversion.js").read_text(encoding="utf-8")
    workspace_css = (PIANO / "web" / "piano_workspace.css").read_text(encoding="utf-8")
    state = (ROOT / "js" / "modules" / "core" / "state.js").read_text(encoding="utf-8")

    order = [ui.index(f"tabButton('{name}'") for name in ("soundboard", "music", "piano", "soundlab", "router")]
    assert all(index >= 0 for index in order) and order == sorted(order)
    for asset in ("audioflix.piano.css", "audioflix.piano.client.js", "audioflix.piano.ui.js"):
        assert asset in html
    assert "startsWith('piano-')" in actions and "EveAudioflixPianoUi?.handleAction" in actions
    assert ("findController" in piano_client or "ensureController" in piano_client) and "api/piano-player" in piano_client
    assert ("Opening Piano-Auto-Player" in piano_ui or "Start Piano-Auto-Player" in piano_ui) and "location.replace" in piano_ui
    assert "PIANO AUTOMATION" in piano_ui and "PRACTICE AUTOMATION" not in piano_ui
    assert "data-piano-detached" in piano_ui and "detachedWindow" in piano_ui and "Focus Detached" in piano_ui
    assert ".audioflix-piano.is-detached" in piano_css and "pointer-events: none" in piano_css
    assert "piano-setup" in piano_ui and "Setup / Repair" in piano_ui
    assert "sessionStorage" in bridge and "localStorage" not in bridge
    assert "pianoPlayerPort: 8771" in state

    assert 'setupSheetWorkspace' in piano_app and 'setupBulkConversion' in piano_app
    assert 'sheetWorkspace?.stage(song, result)' in piano_app
    assert 'sheetWorkspace.stage(await api.importSheet' in piano_app
    assert 'HISTORY_LIMIT = 10' in workspace and 'From Sheet Finder' in workspace
    assert 'state.history.slice(-HISTORY_LIMIT)' in workspace and 'state.staging.push(entry)' in workspace
    assert 'Bulk conversion' in bulk and 'Queue conversions' in bulk and 'youtubePiano.transcribe' in bulk
    assert 'bulkConversionFile' in bulk and 'Queue .txt file' in bulk and 'file.text()' in bulk
    assert '(?=https?:\\/\\/|[\\s,]|$)' in bulk
    assert 'Ready in From Sheet Finder' in bulk
    assert 'api.youtubeDependencies()' in bulk and 'Blocked —' in bulk and 'Failed —' in bulk
    assert '@media (max-width: 1180px)' in workspace_css and '.hero-grid, .lower-grid' in workspace_css
    assert '.controls-panel select' in workspace_css and '.seek-controls' in workspace_css

    helper = (ROOT / "server_modules" / "eveos_control_helper.py").read_text(encoding="utf-8")
    assert '"/api/piano-player/status"' in helper
    assert '"/api/piano-player/start"' in helper and '"/api/piano-player/stop"' in helper
    assert '"/api/piano-player/setup"' in helper and "open_setup" in helper
    assert "piano_player_control.restore_desired_state_async()" in helper

    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "tools/Piano-Auto-Player/data/**" in ignore
    assert "!tools/Piano-Auto-Player/data/README.txt" in ignore
    assert "tools/Piano-Auto-Player/youtube_session.txt" in ignore
    assert "tools/Piano-Auto-Player/.youtube-piano-venv/" in ignore
    assert "tools/Piano-Auto-Player/.piano-hifi-venv/" in ignore
    setup = (PIANO / "setup.bat").read_text(encoding="utf-8")
    start = (PIANO / "start.bat").read_text(encoding="utf-8")
    assert "setup-youtube-piano.bat" in setup and "setup-hifi-piano.bat" in setup
    assert "127.0.0.1:8771" in start and "127.0.0.1:8765" not in start
    if (ROOT / ".git").exists():
        tracked = subprocess.run(
            ["git", "ls-files", "--", "tools/Piano-Auto-Player/data/**", "tools/Piano-Auto-Player/youtube_session.txt"],
            cwd=ROOT, capture_output=True, text=True, check=True,
        ).stdout.splitlines()
        assert {value.replace("\\", "/") for value in tracked} <= {"tools/Piano-Auto-Player/data/README.txt"}


def assert_http_contract() -> None:
    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), piano_server.Handler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    try:
        status, body, cors = request(server.server_port, "GET", "/api/status")
        payload = json.loads(body.decode("utf-8"))
        assert status == 200 and payload["service"] == "piano-auto-player" and payload["appVersion"]
        assert cors == "null"
        status, body, _ = request(server.server_port, "GET", "/")
        assert status == 200 and b"eveos-host-bridge.js" in body
        for asset in ("sheet_workspace.js", "bulk_conversion.js", "piano_workspace.css"):
            status, body, _ = request(server.server_port, "GET", f"/assets/{asset}")
            assert status == 200 and body
        status, _, cors = request(server.server_port, "OPTIONS", "/api/status", "https://example.com")
        assert status == 204 and not cors
    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=2)


def assert_lifecycle_contract() -> None:
    with tempfile.TemporaryDirectory(prefix="eveos-piano-") as temporary:
        root = Path(temporary)
        fake = root / "piano.py"
        preference = root / "service.json"
        fake.write_text(textwrap.dedent("""
            import argparse, json
            from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
            parser = argparse.ArgumentParser()
            parser.add_argument('--host', default='127.0.0.1')
            parser.add_argument('--port', type=int, required=True)
            parser.add_argument('--no-browser', action='store_true')
            args = parser.parse_args()
            class Handler(BaseHTTPRequestHandler):
                def do_GET(self):
                    if self.path != '/api/status': return self.send_error(404)
                    body = json.dumps({'ok': True, 'service': 'piano-auto-player', 'appVersion': 'smoke'}).encode()
                    self.send_response(200); self.send_header('Content-Length', str(len(body)))
                    self.end_headers(); self.wfile.write(body)
                def log_message(self, *_args): pass
            ThreadingHTTPServer((args.host, args.port), Handler).serve_forever()
        """).strip() + "\n", encoding="utf-8")

        original = {
            "PIANO_PORT": piano_player_control.PIANO_PORT,
            "_entry": piano_player_control._entry,
            "_preference": piano_player_control._preference,
            "headless_for": piano_player_control.eveos_console_prefs.headless_for,
        }
        try:
            piano_player_control.PIANO_PORT = free_port()
            piano_player_control._entry = lambda: fake
            piano_player_control._preference = lambda: preference
            piano_player_control.eveos_console_prefs.headless_for = lambda _service: True
            started = piano_player_control.start_server()
            assert started["ok"] and wait_until(lambda: piano_player_control.get_status()["running"])
            assert "setupAvailable" in started and "youtubeSetup" in started and "hifiSetup" in started
            assert json.loads(preference.read_text(encoding="utf-8"))["desiredRunning"] is True
            stopped = piano_player_control.stop_server()
            assert stopped["ok"] and not stopped["running"]
            assert json.loads(preference.read_text(encoding="utf-8"))["desiredRunning"] is False
        finally:
            if piano_player_control._PROCESS and piano_player_control._PROCESS.poll() is None:
                piano_player_control.stop_server(persist=False)
            piano_player_control.PIANO_PORT = original["PIANO_PORT"]
            piano_player_control._entry = original["_entry"]
            piano_player_control._preference = original["_preference"]
            piano_player_control.eveos_console_prefs.headless_for = original["headless_for"]


def assert_upstream_tests() -> None:
    result = subprocess.run(
        [sys.executable, "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-p", "test_*.py"],
        cwd=PIANO, capture_output=True, text=True, timeout=180, check=False,
    )
    assert result.returncode == 0, result.stdout + result.stderr


if __name__ == "__main__":
    assert_static_contract()
    assert_http_contract()
    assert_lifecycle_contract()
    assert_upstream_tests()
    print("AUDIOFLIX_PIANO_INTEGRATION_SMOKE_OK")
