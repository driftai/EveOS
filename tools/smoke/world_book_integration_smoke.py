"""World Book relocation, UI contract, and persisted lifecycle smoke."""

from __future__ import annotations

import json
import socket
import subprocess
import sys
import tempfile
import textwrap
import time
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))
WORLD_BOOK_ROOT = ROOT / "tools" / "World-Book"
if str(WORLD_BOOK_ROOT) not in sys.path:
    sys.path.insert(0, str(WORLD_BOOK_ROOT))

from server_modules import world_book_control
from worldbook_runtime.bootstrap import load_runtime


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as probe:
        probe.bind(("127.0.0.1", 0))
        return int(probe.getsockname()[1])


def wait_until(predicate, timeout: float = 4.0) -> bool:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        if predicate():
            return True
        time.sleep(0.05)
    return False


def assert_static_contract() -> None:
    tool = ROOT / "tools" / "World-Book"
    assert (tool / "server.py").is_file()
    assert (tool / "launch.ps1").is_file()
    assert (tool / "app" / "index.html").is_file()
    assert (tool / "worldbook_runtime" / "bootstrap.py").is_file()

    html = (ROOT / "EveOS.html").read_text(encoding="utf-8")
    assert "Notes &amp; World Books" in html
    assert "eveos-local-control.js" in html
    assert "world-book.client.js" in html
    assert "world-book.overlay.js" in html
    client = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.client.js").read_text(encoding="utf-8")
    assert "api/health" in client
    assert "standalone launcher" in client
    assert "EveOSLocalControl" in client
    assert "ensureController" in client
    overlay = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.overlay.js").read_text(encoding="utf-8")
    detached = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.detach.js").read_text(encoding="utf-8")
    assert "world-book.detach.js" in html
    assert 'data-world-book-detach' in overlay
    assert "Start via Launcher" not in overlay
    assert "Connect local control and stop this standalone World Book server" in overlay
    assert "ns.detach" in overlay
    assert "eveWorldBookWindow" in detached
    assert "window.open" in detached

    server = (ROOT / "server" / "python-server.py").read_text(encoding="utf-8")
    assert "world_book_control.handle_get_request" in server
    assert "world_book_control.handle_post_request" in server
    assert "world_book_control.restore_desired_state_async" in server
    control = (ROOT / "server_modules" / "world_book_control.py").read_text(encoding="utf-8")
    assert "launch.ps1" in control

    handler = (tool / "worldbook_runtime" / "layers" / "80_http_handler.py").read_text(encoding="utf-8")
    assert 'parsed.path == "/api/health"' in handler
    assert "Access-Control-Allow-Origin" in handler

    launch_batch = (tool / "launch.bat").read_text(encoding="utf-8")
    assert 'launch.ps1" %*' in launch_batch

    ports_cfg = json.loads((ROOT / "config" / "eveos-ports.json").read_text(encoding="utf-8"))
    assert ports_cfg.get("ports", {}).get("WORLD_BOOK_PORT", {}).get("port") == 8766
    assert 'service_port("WORLD_BOOK_PORT")' in control

    frontend_version = (tool / "app" / "assets" / "js" / "state.js").read_text(encoding="utf-8")
    backend_version = (tool / "worldbook_runtime" / "layers" / "00_foundation.py").read_text(encoding="utf-8")
    patch = json.loads((tool / "PATCH-MANIFEST.json").read_text(encoding="utf-8"))
    assert 'WB.APP_VERSION = "0.16.0"' in frontend_version
    assert 'APP_VERSION = "0.16.0"' in backend_version
    assert patch["version"] == "0.16.0" and patch["fromVersion"] == "0.15.0"

    fragment_manifest = json.loads((tool / "app" / "fragments" / "manifest.json").read_text(encoding="utf-8"))
    assert "dialogs-narration.html" in fragment_manifest
    recovery_backup = (tool / "worldbook_runtime" / "layers" / "65_recovery_backup.py").read_text(encoding="utf-8")
    recovery_restore = (tool / "worldbook_runtime" / "layers" / "66_recovery_restore.py").read_text(encoding="utf-8")
    assert '"data/narration_documents"' in recovery_backup
    assert 'manifest.get("narrationDocuments")' in recovery_restore


def assert_private_data_contract() -> None:
    ignore = (ROOT / ".gitignore").read_text(encoding="utf-8")
    assert "tools/World-Book/data/**" in ignore
    assert "!tools/World-Book/data/README.txt" in ignore

    if not (ROOT / ".git").exists():
        return
    result = subprocess.run(
        ["git", "ls-files", "--", "tools/World-Book/data/**"],
        cwd=ROOT,
        check=True,
        capture_output=True,
        text=True,
    )
    tracked = {line.strip().replace("\\", "/") for line in result.stdout.splitlines() if line.strip()}
    assert tracked <= {"tools/World-Book/data/README.txt"}, (
        "World Book private runtime data is tracked: " + ", ".join(sorted(tracked))
    )


def assert_narration_document_contract() -> None:
    runtime = load_runtime()
    with tempfile.TemporaryDirectory(prefix="eveos-world-book-reader-") as temporary:
        narration_root = Path(temporary) / "narration_documents"
        runtime["NARRATION_DOCUMENTS_DIR"] = narration_root

        pasted = runtime["save_narration_document"](
            "Reader smoke",
            "Dr. Vale arrived at 3.14 p.m. The second sentence remains readable.",
        )
        assert pasted["characterCount"] > 20
        assert runtime["get_narration_document"](pasted["id"])["text"].startswith("Dr. Vale")

        html_source = Path(temporary) / "source.html"
        html_source.write_text(
            "<article><h1>Chapter One</h1><p>Readable prose.</p><script>ignored()</script></article>",
            encoding="utf-8",
        )
        html_text, html_format = runtime["extract_narration_text"](html_source)
        assert html_format == "html"
        assert "Chapter One" in html_text and "Readable prose" in html_text
        assert "ignored" not in html_text
        imported = runtime["save_narration_document"](
            "HTML smoke",
            html_text,
            html_source,
            html_format,
        )
        listed = runtime["list_narration_documents"]()
        assert len(listed) == 2
        assert next(item for item in listed if item["id"] == imported["id"])["hasSource"] is True

        deleted = runtime["delete_narration_document"](pasted["id"])
        assert deleted["id"] == pasted["id"]
        assert len(runtime["list_narration_documents"]()) == 1

        try:
            runtime["narration_safe_id"]("../escape")
        except ValueError:
            pass
        else:
            raise AssertionError("Reader document ids accepted a traversal path")

        normalized = runtime["normalize_narration_text"](
            "The scientific fore- bears asked a ques- tion.\nF R O M A P E T O A L E X A N D E R"
        )
        assert "forebears" in normalized and "question" in normalized
        assert "FROM APE TO ALEXANDER" in normalized

        lines = [
            {"text": "Right second", "x0": 320, "x1": 470, "y0": 100, "y1": 112, "fontSize": 12},
            {"text": "Left first", "x0": 30, "x1": 180, "y0": 80, "y1": 92, "fontSize": 12},
            {"text": "Heading", "x0": 20, "x1": 470, "y0": 20, "y1": 34, "fontSize": 14},
            {"text": "Right first", "x0": 320, "x1": 470, "y0": 80, "y1": 92, "fontSize": 12},
            {"text": "Left second", "x0": 30, "x1": 180, "y0": 100, "y1": 112, "fontSize": 12},
        ]
        ordered = [line["text"] for line in runtime["order_narration_pdf_lines"](lines)]
        assert ordered == ["Heading", "Left first", "Left second", "Right first", "Right second"]

        import fitz

        pdf_source = Path(temporary) / "two-column.pdf"
        with fitz.open() as document:
            page = document.new_page(width=500, height=700)
            page.insert_textbox(fitz.Rect(20, 10, 480, 42), "Heading", fontsize=14, align=fitz.TEXT_ALIGN_CENTER)
            page.insert_text((30, 80), "Left first", fontsize=12)
            page.insert_text((30, 105), "Left second", fontsize=12)
            page.insert_text((320, 80), "Right first", fontsize=12)
            page.insert_text((320, 105), "Right second", fontsize=12)
            document.save(pdf_source)
        pdf_text, pdf_format = runtime["extract_narration_text"](pdf_source)
        assert pdf_format == "pdf"
        positions = [pdf_text.index(value) for value in (
            "Heading", "Left first", "Left second", "Right first", "Right second",
        )]
        assert positions == sorted(positions), pdf_text


def assert_lifecycle_contract() -> None:
    with tempfile.TemporaryDirectory(prefix="eveos-world-book-smoke-") as temporary:
        root = Path(temporary)
        fake_server = root / "server.py"
        preference = root / "world-book-service.json"
        port = free_port()
        fake_server.write_text(
            textwrap.dedent(
                """
                import argparse
                import json
                from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

                parser = argparse.ArgumentParser()
                parser.add_argument("--port", type=int, required=True)
                parser.add_argument("--host", default="127.0.0.1")
                parser.add_argument("--no-browser", action="store_true")
                args = parser.parse_args()

                class Handler(BaseHTTPRequestHandler):
                    def do_GET(self):
                        payload = {"ok": True, "appVersion": "smoke", "config": {}}
                        body = json.dumps(payload).encode("utf-8")
                        self.send_response(200)
                        self.send_header("Content-Type", "application/json")
                        self.send_header("Content-Length", str(len(body)))
                        self.end_headers()
                        self.wfile.write(body)

                    def log_message(self, *_args):
                        return

                ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()
                """
            ).strip()
            + "\n",
            encoding="utf-8",
        )

        original_port = world_book_control.WORLD_BOOK_PORT
        original_entry = world_book_control._entry_point
        original_preference = world_book_control._preference_path
        try:
            world_book_control.WORLD_BOOK_PORT = port
            world_book_control._entry_point = lambda: fake_server
            world_book_control._preference_path = lambda: preference

            started = world_book_control.start_server()
            assert started["ok"] and wait_until(lambda: world_book_control.get_status()["running"])
            assert json.loads(preference.read_text(encoding="utf-8"))["desiredRunning"] is True

            stopped = world_book_control.stop_server()
            assert stopped["ok"] and wait_until(lambda: not world_book_control.get_status()["running"])
            assert json.loads(preference.read_text(encoding="utf-8"))["desiredRunning"] is False

            world_book_control._write_desired_state(True)
            world_book_control.restore_desired_state()
            assert wait_until(lambda: world_book_control.get_status()["running"])
            world_book_control.stop_server(persist=False)
        finally:
            if world_book_control._PROCESS and world_book_control._PROCESS.poll() is None:
                world_book_control.stop_server(persist=False)
            world_book_control.WORLD_BOOK_PORT = original_port
            world_book_control._entry_point = original_entry
            world_book_control._preference_path = original_preference


if __name__ == "__main__":
    assert_static_contract()
    assert_private_data_contract()
    assert_narration_document_contract()
    assert_lifecycle_contract()
    print("WORLD_BOOK_INTEGRATION_SMOKE_OK")
