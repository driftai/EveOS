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
    assert "world-book.offline.js" in html
    assert "world-book.offline.css" in html
    assert "world-book.notes.workspace.css" in html
    assert "world-book.notes.client.js" in html
    assert "world-book.notes.workspace.js" in html
    assert "eveos-resume.js" in html
    assert "world-book.overlay.template.js" in html
    assert "world-book.overlay.js" in html
    assert html.index("world-book.overlay.template.js") < html.index("world-book.overlay.js")
    assert "world-book.narration.clips.js" in html
    assert html.index("world-book.narration.clips.js") < html.index("world-book.narration.runtime.js")
    client = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.client.js").read_text(encoding="utf-8")
    assert "api/health" in client
    assert "standalone launcher" in client
    assert "EveOSLocalControl" in client
    assert "ensureController" in client
    assert "Promise.all(bases.map" in client
    assert "refreshPromise" in client
    assert "findDirectServer" in client and "650" in client
    assert "window.setTimeout(() => { void refresh(); }, 0)" in client
    overlay = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.overlay.js").read_text(encoding="utf-8")
    overlay_template = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.overlay.template.js").read_text(encoding="utf-8")
    overlay_surface = overlay + "\n" + overlay_template
    detached = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.detach.js").read_text(encoding="utf-8")
    assert "world-book.detach.js" in html
    assert 'data-world-book-detach' in overlay_surface
    assert "Start via Launcher" not in overlay
    assert "Connect local control and stop this standalone World Book server" in overlay
    assert "ns.detach" in overlay
    assert "syncViewButtons" in overlay
    assert "becameOnline" in overlay
    assert "serverReplaced" in overlay
    assert "reloadActiveFrame" in overlay
    assert "data-world-book-reload" in overlay_surface
    assert "data-world-book-detach-state" in overlay_surface
    assert "frame.dataset.worldBookTarget" in overlay
    assert "worldBookFrameState" in overlay
    assert "ns.offline?.shell?.('world')" in overlay_surface
    assert "ns.offline?.shell?.('portal')" in overlay_surface
    assert "data-world-book-notes-copy" in overlay_surface
    assert "data-world-book-notes-download" in overlay_surface
    assert "data-world-book-notes-read" in overlay_surface
    assert "data-eve-notes-mode=\"files\"" in overlay_surface
    assert "data-eve-notes-mode=\"spatial\"" in overlay_surface
    assert "data-eve-notes-editor" in overlay_surface
    assert "notesWorkspace?.activate" in overlay
    assert "EveOSResume?.register" in overlay
    assert "restoreOpen" in overlay and "const repaired = createOverlay()" in overlay
    assert "notesNarration?.readAloud" in overlay
    assert "notesNarration?.notifyChanged" in overlay
    assert "ensureNarrationTarget" not in overlay
    notes_narration = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.notes.narration.js").read_text(encoding="utf-8")
    read_aloud = notes_narration[notes_narration.index("async function readAloud"):notes_narration.index("ns.notesNarration")]
    assert "ns.client.start" not in read_aloud
    assert "primeAudio" in read_aloud and read_aloud.index("primeAudio") < read_aloud.index("await ")
    assert "local: true" in read_aloud
    assert "setSourceProvider" in notes_narration
    assert "notifyChanged" in notes_narration
    assert "data-world-book-needs-server" in overlay_surface
    assert "targetView = 'notes'" in overlay
    assert "requestAnimationFrame" in overlay
    assert "eveWorldBookWindow" in detached
    assert "window.open" in detached
    assert "eve:world-book-detached-state" in detached
    assert "isOpen:" in detached
    narration_bridge = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.narration.bridge.js").read_text(encoding="utf-8")
    narration_ui = (tool / "app" / "assets" / "js" / "narration" / "ui.js").read_text(encoding="utf-8")
    assert "readSource" in narration_bridge
    assert "EveWorldBookNarrationRuntime" in narration_bridge
    assert "'load-source'" in narration_bridge
    assert 'data.action === "load-source"' in narration_ui
    assert "controller.load(data.data?.source || {})" in narration_ui
    world_css = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.css").read_text(encoding="utf-8")
    assert ".notes-world-book-portal-view" in world_css
    assert "[data-world-portal-frame]" in world_css
    offline_js = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.offline.js").read_text(encoding="utf-8")
    offline_css = (ROOT / "js" / "modules" / "features" / "world-book" / "world-book.offline.css").read_text(encoding="utf-8")
    assert "Offline shell" in offline_js
    assert "Open Scratchpad" in offline_js
    assert "setServerState" in offline_js
    assert ".notes-world-book-offline-shell" in offline_css
    assert "place-content: start stretch" in offline_css
    assert "margin: 0 auto" in offline_css
    assert ".notes-world-book-stage" in offline_css
    assert "padding: 0 !important" in offline_css
    assert ".notes-world-book-stage > [data-world-book-panel]" in offline_css
    assert "position: absolute !important" in offline_css
    assert "inset: 0 !important" in offline_css
    assert "transform: none !important" in offline_css
    assert ".notes-world-book-notes-view" in offline_css
    assert "padding: 10px clamp(14px, 2vw, 28px)" in offline_css
    assert "grid-template-rows: auto minmax(min(220px, 45vh), 1fr)" in offline_css
    assert "[data-world-book-notes]" in offline_css and "resize: vertical" in offline_css

    app_index = (tool / "app" / "index.html").read_text(encoding="utf-8")
    assert 'data-entry-section="metadata"' in app_index
    assert 'data-entry-section="notes"' in app_index
    assert 'data-entry-section="links"' in app_index
    assert 'data-entry-section="content"' in app_index
    assert 'data-entry-section="provenance"' in app_index
    assert 'data-entry-section="details"' in app_index
    assert 'id="save-entry-provenance-btn"' in app_index
    app_state_chain = (tool / "app" / "assets" / "js" / "app" / "chains" / "00-layer.js.part").read_text(encoding="utf-8")
    app_bindings_chain = (tool / "app" / "assets" / "js" / "app" / "chains" / "05-layer.js.part").read_text(encoding="utf-8")
    app_advanced_chain = (tool / "app" / "assets" / "js" / "app" / "chains" / "06-advanced.js.part").read_text(encoding="utf-8")
    app_link_chain = (tool / "app" / "assets" / "js" / "app" / "chains" / "01-layer.js.part").read_text(encoding="utf-8")
    app_bootstrap = (tool / "app" / "assets" / "js" / "bootstrap.js").read_text(encoding="utf-8")
    app_header_css = (tool / "app" / "assets" / "css" / "layers" / "73-header-responsive.css").read_text(encoding="utf-8")
    app_sections_css = (tool / "app" / "assets" / "css" / "layers" / "74-entry-sections.css").read_text(encoding="utf-8")
    link_dialog = (tool / "app" / "fragments" / "dialogs-01.html").read_text(encoding="utf-8")
    assert "state.ui.entrySections" in app_state_chain
    assert "selectedSectionKey" in app_state_chain
    assert 'getLinksCollapsed: () => entrySectionCollapsed("links")' in app_bindings_chain
    assert "onEntryRendered: applyEntrySectionState" in app_bindings_chain
    assert "function saveProvenance()" in app_advanced_chain
    assert "existing.provenance = provenance" in app_link_chain
    assert "ref.provenance = { ...provenance }" in app_link_chain
    assert 'id="link-provenance-source"' in link_dialog
    assert 'document.documentElement.classList.toggle("embedded-eveos"' in app_bootstrap
    assert "loadScriptsOrdered" in app_bootstrap
    assert "Promise.all(names.map" in app_bootstrap
    app_loader = (tool / "app" / "assets" / "js" / "app-loader.js").read_text(encoding="utf-8")
    app_start_chain = (tool / "app" / "assets" / "js" / "app" / "chains" / "06-layer.js.part").read_text(encoding="utf-8")
    assert "Promise.all(manifest.map" in app_loader
    assert 'setStatus(config.rootPath ? "Loading workspace…"' in app_start_chain
    assert "void loadPhysicalRoot().then" in app_start_chain
    assert "html.embedded-eveos .topbar" in app_header_css
    assert ".entry-section.is-collapsed" in app_sections_css
    assert ".link-provenance-grid" in app_sections_css

    server = (ROOT / "server" / "python-server.py").read_text(encoding="utf-8")
    assert "world_book_control.handle_get_request" in server
    assert "world_book_control.handle_post_request" in server
    assert "world_book_control.restore_desired_state_async" in server
    control = (ROOT / "server_modules" / "world_book_control.py").read_text(encoding="utf-8")
    assert "launch.ps1" in control
    assert 'headless_for("worldBook")' in control
    assert '"CREATE_NO_WINDOW" if headless else "CREATE_NEW_CONSOLE"' in control
    assert "notes_workspace.handle_get_request" in control
    assert "notes_workspace.handle_post_request" in control
    notes_backend = (ROOT / "server_modules" / "notes_workspace.py").read_text(encoding="utf-8")
    assert 'SPATIAL_ROOT_ID = "spatial"' in notes_backend
    assert "expected_revision != current_revision" in notes_backend

    handler = (tool / "worldbook_runtime" / "layers" / "80_http_handler.py").read_text(encoding="utf-8")
    assert 'parsed.path == "/api/health"' in handler
    assert '"instanceId": SERVER_INSTANCE_ID' in handler
    assert "WorldBookResponseMixin, SimpleHTTPRequestHandler" in handler
    response = (tool / "worldbook_runtime" / "layers" / "75_http_response.py").read_text(encoding="utf-8")
    assert "Access-Control-Allow-Origin" in response
    assert '"public, max-age=31536000, immutable"' in response
    assert '"no-cache"' in response
    assert 'parsed_request.path.startswith("/api/")' in response

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
    assert "data/spatial-notes/" in ignore
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
        original_headless = world_book_control.eveos_console_prefs.headless_for
        try:
            world_book_control.WORLD_BOOK_PORT = port
            world_book_control._entry_point = lambda: fake_server
            world_book_control._preference_path = lambda: preference
            # The lifecycle smoke uses a throwaway fake server. Keep that helper
            # hidden while production remains explicitly headed by default.
            world_book_control.eveos_console_prefs.headless_for = lambda _service=None: True

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
            world_book_control.eveos_console_prefs.headless_for = original_headless


if __name__ == "__main__":
    assert_static_contract()
    assert_private_data_contract()
    assert_narration_document_contract()
    assert_lifecycle_contract()
    print("WORLD_BOOK_INTEGRATION_SMOKE_OK")
