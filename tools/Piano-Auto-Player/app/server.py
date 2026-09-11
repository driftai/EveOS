import json
import mimetypes
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, unquote, urlparse

from .audio_transcriber import YouTubePianoTranscriber
from .library import SongLibrary
from .library_transfer import export_library_zip, export_song_bytes, import_library_bytes
from .media_reference import MediaReferenceResolver
from .parser import summarize_sheet
from .playback import PlaybackController, PlaybackOptions
from .preview_timeline import build_performance_preview, build_sheet_preview
from .providers import ProviderRegistry
from .sheet_validation import validate_sheet_text
from .source_discovery import AlternateSourceFinder
from .state import RuntimeState
from .window_focus import list_windows


ROOT = Path(__file__).resolve().parent.parent
WEB = ROOT / "web"
DATA = ROOT / "data"
APP_VERSION = "0.6.21"
SERVER_ID = "PianoAutoPlayer/0.6.21"
STARTUP_LABEL = "Piano Auto Player v0.6.21 running"
STATE = RuntimeState()
CONTROLLER = PlaybackController(STATE)
LIBRARY = SongLibrary(DATA / "songs.json")
PROVIDERS = ProviderRegistry()
YOUTUBE_PIANO = YouTubePianoTranscriber(ROOT)
ALTERNATE_SOURCES = AlternateSourceFinder(ROOT)
MEDIA_REFERENCE = MediaReferenceResolver()


class Handler(BaseHTTPRequestHandler):
    server_version = SERVER_ID

    def end_headers(self) -> None:
        origin = str(self.headers.get("Origin") or "").strip()
        if origin == "null" or origin.startswith(("http://127.0.0.1", "http://localhost")):
            self.send_header("Access-Control-Allow-Origin", origin)
        self.send_header("Vary", "Origin")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, DELETE, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, X-Requested-With")
        super().end_headers()

    def do_OPTIONS(self) -> None:
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/":
            return self._serve_file(WEB / "index.html")
        if path.startswith("/assets/"):
            return self._serve_file(WEB / unquote(path.removeprefix("/assets/")))
        if path == "/api/status":
            return self._json({
                "ok": True,
                "service": "piano-auto-player",
                "appVersion": APP_VERSION,
                **STATE.snapshot(),
            })
        if path == "/api/windows":
            return self._json({"windows": list_windows()})
        if path == "/api/songs":
            return self._json({"songs": LIBRARY.list()})
        if path == "/api/library/export":
            params = parse_qs(parsed.query)
            ids = [item for raw in params.get("ids", []) for item in raw.split(",") if item]
            body, filename, _count = export_library_zip(LIBRARY, ids or None)
            return self._download(body, "application/zip", filename)
        if path == "/api/library/export-song":
            song_id = parse_qs(parsed.query).get("id", [""])[0]
            song = LIBRARY.get(song_id)
            if not song:
                return self._json({"error": "Song not found."}, HTTPStatus.NOT_FOUND)
            body, filename = export_song_bytes(song)
            return self._download(body, "application/json; charset=utf-8", filename)
        if path == "/api/providers":
            return self._json({"providers": PROVIDERS.info()})
        if path == "/api/youtube/dependencies":
            deps = YOUTUBE_PIANO.dependencies()
            deps["alternate_search"] = ALTERNATE_SOURCES.dependencies()
            return self._json(deps)
        if path == "/api/youtube/diagnostics":
            url = parse_qs(parsed.query).get("url", [""])[0].strip()
            return self._json(YOUTUBE_PIANO.diagnostics(url))
        if path == "/api/youtube/session":
            return self._json({"session": YOUTUBE_PIANO.session_status()})
        if path == "/api/alternate-sources":
            query = parse_qs(parsed.query).get("q", [""])[0].strip()
            try:
                return self._json({"results": ALTERNATE_SOURCES.search(query)})
            except ValueError as exc:
                return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/media/resolve":
            url = parse_qs(parsed.query).get("url", [""])[0].strip()
            try:
                return self._json(MEDIA_REFERENCE.resolve(url))
            except ValueError as exc:
                return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/reference":
            params = parse_qs(parsed.query)
            query = params.get("q", [""])[0].strip()
            artist = params.get("artist", [""])[0].strip()
            try:
                return self._json(PROVIDERS.best_reference(query, artist))
            except Exception as exc:
                return self._json({"error": f"Reference search failed: {exc}"}, HTTPStatus.BAD_GATEWAY)
        if path == "/api/youtube/status":
            job_id = parse_qs(parsed.query).get("job", [""])[0]
            try:
                return self._json(YOUTUBE_PIANO.status(job_id))
            except ValueError as exc:
                return self._json({"error": str(exc)}, HTTPStatus.NOT_FOUND)
        if path == "/api/search":
            params = parse_qs(parsed.query)
            query = params.get("q", [""])[0].strip()
            selected = [item for raw in params.get("providers", []) for item in raw.split(",") if item]
            if not query:
                return self._json({"results": [], "errors": {}, "providers": PROVIDERS.info()})
            try:
                return self._json(PROVIDERS.search(query, selected or None))
            except Exception as exc:
                return self._json({"error": f"Sheet search failed: {exc}"}, HTTPStatus.BAD_GATEWAY)
        return self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_POST(self) -> None:
        parsed = urlparse(self.path)
        path = parsed.path
        if path == "/api/library/import":
            raw = self._read_bytes(100 * 1024 * 1024)
            if raw is None:
                return
            filename = parse_qs(parsed.query).get("filename", [""])[0]
            try:
                result = import_library_bytes(LIBRARY, raw, filename)
                return self._json({"ok": True, **result})
            except ValueError as exc:
                return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        payload = self._read_json()
        if payload is None:
            return
        if path == "/api/parse":
            try:
                sheet = str(payload.get("sheet") or "")
                if sheet.strip():
                    validate_sheet_text(sheet)
                return self._json(summarize_sheet(sheet, str(payload.get("timing_profile") or "expressive")))
            except ValueError as exc:
                return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/preview":
            try:
                sheet = str(payload.get("sheet") or "")
                if not sheet.strip():
                    return self._json({"error": "Paste or load a sheet first."}, HTTPStatus.BAD_REQUEST)
                validate_sheet_text(sheet)
                return self._json(build_sheet_preview(sheet, self._options(payload)))
            except ValueError as exc:
                return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/preview-performance":
            events = payload.get("performance")
            if not isinstance(events, list) or not events:
                return self._json({"error": "Record or load a performance first."}, HTTPStatus.BAD_REQUEST)
            try:
                return self._json(build_performance_preview(events, self._options(payload)))
            except ValueError as exc:
                return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        if path == "/api/play":
            return self._play_sheet(payload)
        if path == "/api/play-performance":
            return self._play_performance(payload)
        if path == "/api/pause":
            paused = CONTROLLER.toggle_pause()
            return self._json({"ok": True, "paused": paused})
        if path == "/api/stop":
            resume_event = CONTROLLER.stop()
            return self._json({"ok": True, "resume_event": resume_event})
        if path == "/api/seek":
            target = _integer(payload.get("event_index"), 1, 1, 200000)
            actual = CONTROLLER.seek(target)
            if not actual:
                return self._json({"error": "No active event timeline to seek."}, HTTPStatus.BAD_REQUEST)
            return self._json({"ok": True, "event_index": actual})
        if path == "/api/songs/identifiers":
            song_id = str(payload.get("id") or "").strip()
            identifiers = payload.get("identifiers")
            if not song_id:
                return self._json({"error": "Song id is required."}, HTTPStatus.BAD_REQUEST)
            if not isinstance(identifiers, dict):
                return self._json({"error": "Identifiers must be an object."}, HTTPStatus.BAD_REQUEST)
            updated = LIBRARY.update_identifiers(song_id, identifiers)
            if not updated:
                return self._json({"error": "Song not found."}, HTTPStatus.NOT_FOUND)
            return self._json({"song": updated})
        if path == "/api/songs":
            song_id = str(payload.get("id") or "")
            existing = LIBRARY.get(song_id) if song_id else None
            has_sheet = bool(str(payload.get("sheet") if "sheet" in payload else (existing.get("sheet") if existing else "")).strip())
            has_performance = bool(payload.get("performance") if "performance" in payload else (existing.get("performance") if existing else None))
            if not (has_sheet or has_performance):
                return self._json({"error": "Song has no sheet or recorded performance."}, HTTPStatus.BAD_REQUEST)
            return self._json({"song": LIBRARY.save(payload)})
        if path == "/api/import":
            try:
                song = PROVIDERS.fetch(str(payload.get("url") or "").strip(), str(payload.get("provider") or ""))
                return self._json(song)
            except Exception as exc:
                return self._json({"error": f"Import failed: {exc}"}, HTTPStatus.BAD_REQUEST)
        if path == "/api/youtube/session":
            cookies = str(payload.get("cookies") or payload.get("session") or "").strip()
            if not cookies:
                return self._json({"error": "Paste cookie text or Netscape format."}, HTTPStatus.BAD_REQUEST)
            summary = YOUTUBE_PIANO.set_session_cookies(cookies)
            return self._json({"ok": True, "session": summary})
        if path in {"/api/youtube/session/clear", "/api/youtube/session/reset"}:
            return self._json({"ok": True, "session": YOUTUBE_PIANO.clear_session_cookies()})
        if path == "/api/youtube":
            try:
                return self._json(YOUTUBE_PIANO.start(
                    str(payload.get("url") or ""),
                    str(payload.get("access") or "auto"),
                    str(payload.get("title_hint") or ""),
                    str(payload.get("quality") or "rhythm_accurate"),
                    str(payload.get("piano_layout") or "61"),
                    str(payload.get("engine") or "auto_hifi"),
                ))
            except ValueError as exc:
                return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)
        return self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def do_DELETE(self) -> None:
        path = urlparse(self.path).path
        if path == "/api/youtube/session":
            return self._json({"ok": True, "session": YOUTUBE_PIANO.clear_session_cookies()})
        prefix = "/api/songs/"
        if path.startswith(prefix):
            song_id = unquote(path[len(prefix):])
            return self._json({"ok": LIBRARY.delete(song_id)})
        return self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)

    def _options(self, payload: dict) -> PlaybackOptions:
        return PlaybackOptions(
            interval_ms=_number(payload.get("interval_ms"), 115.0, 10.0, 2000.0),
            note_hold_ms=_number(payload.get("note_hold_ms"), 18.0, 1.0, 250.0),
            countdown_seconds=_number(payload.get("countdown_seconds"), 3.0, 0.0, 15.0),
            target_window=str(payload.get("target_window") or "Roblox")[:160],
            target_hwnd=_integer(payload.get("target_hwnd"), 0, 0, 2**53 - 1),
            input_mode=str(payload.get("input_mode") or "foreground") if str(payload.get("input_mode") or "foreground") in {"foreground", "virtual_target"} else "foreground",
            auto_focus=bool(payload.get("auto_focus", True)),
            dry_run=bool(payload.get("dry_run", False)),
            speed=_number(payload.get("speed"), 1.0, 0.25, 3.0),
            adaptive_hold=bool(payload.get("adaptive_hold", True)),
            gate_percent=_number(payload.get("gate_percent"), 58.0, 10.0, 90.0),
            modifier_lead_ms=_number(payload.get("modifier_lead_ms"), 6.0, 0.0, 30.0),
            modifier_tail_ms=_number(payload.get("modifier_tail_ms"), 2.0, 0.0, 20.0),
            chord_spread_ms=_number(payload.get("chord_spread_ms"), 4.0, 0.0, 30.0),
            start_event=_integer(payload.get("start_event"), 1, 1, 200000),
            timing_profile=str(payload.get("timing_profile") or "expressive")[:32],
            piano_layout="88" if str(payload.get("piano_layout") or "61") == "88" else "61",
        )

    def _play_sheet(self, payload: dict) -> None:
        sheet = str(payload.get("sheet") or "")
        if not sheet.strip():
            return self._json({"error": "Paste or load a sheet first."}, HTTPStatus.BAD_REQUEST)
        try:
            validate_sheet_text(sheet)
            CONTROLLER.start(sheet, str(payload.get("title") or "Untitled sheet"), self._options(payload))
            return self._json({"ok": True, "summary": summarize_sheet(sheet, str(payload.get("timing_profile") or "expressive"))})
        except ValueError as exc:
            return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def _play_performance(self, payload: dict) -> None:
        events = payload.get("performance")
        if not isinstance(events, list) or not events:
            return self._json({"error": "Record or load a performance first."}, HTTPStatus.BAD_REQUEST)
        try:
            CONTROLLER.start_performance(events, str(payload.get("title") or "Recorded performance"), self._options(payload))
            return self._json({"ok": True, "events": len(events)})
        except ValueError as exc:
            return self._json({"error": str(exc)}, HTTPStatus.BAD_REQUEST)

    def _read_bytes(self, maximum: int) -> bytes | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            length = 0
        if length <= 0:
            self._json({"error": "Import file is empty."}, HTTPStatus.BAD_REQUEST)
            return None
        if length > maximum:
            self._json({"error": "Import file exceeds the 100 MB limit."}, HTTPStatus.REQUEST_ENTITY_TOO_LARGE)
            return None
        return self.rfile.read(length)

    def _read_json(self) -> dict | None:
        try:
            length = int(self.headers.get("Content-Length", "0"))
            raw = self.rfile.read(length) if length else b"{}"
            return json.loads(raw.decode("utf-8"))
        except (ValueError, json.JSONDecodeError):
            self._json({"error": "Invalid JSON body."}, HTTPStatus.BAD_REQUEST)
            return None

    def _json(self, payload: dict, status: HTTPStatus = HTTPStatus.OK) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(int(status))
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, OSError):
            pass

    def _download(self, body: bytes, content_type: str, filename: str) -> None:
        try:
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", content_type)
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Content-Disposition", f'attachment; filename="{filename}"')
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionError, OSError):
            pass

    def _serve_file(self, path: Path) -> None:
        try:
            resolved = path.resolve()
            if WEB.resolve() not in resolved.parents and resolved != WEB.resolve():
                raise FileNotFoundError
            body = resolved.read_bytes()
        except (OSError, FileNotFoundError):
            return self._json({"error": "Not found"}, HTTPStatus.NOT_FOUND)
        content_type = mimetypes.guess_type(resolved.name)[0] or "application/octet-stream"
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, fmt: str, *args) -> None:
        print(f"[PianoAutoPlayer] {self.address_string()} - {fmt % args}")


def _integer(value, default: int, minimum: int, maximum: int) -> int:
    try:
        number = int(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(number, maximum))


def _number(value, default: float, minimum: float, maximum: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        number = default
    return max(minimum, min(number, maximum))


# Previous checkpoint compatibility: Piano Auto Player v0.5.3 running
def run(host: str = "127.0.0.1", port: int = 8771) -> None:
    server = ThreadingHTTPServer((host, port), Handler)
    print(f"{STARTUP_LABEL} at http://{host}:{port}")
    print("Press Ctrl+C here, or F7 during playback, to stop safely.")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        CONTROLLER.stop()
        server.server_close()
