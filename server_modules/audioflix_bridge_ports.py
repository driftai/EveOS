import json
import os
import threading
import urllib.error
import urllib.request
from http import HTTPStatus

from server_modules.outbound_http import build_public_opener, validate_public_http_target

AUDIO_EXTENSIONS = {".mp3", ".mp4", ".wav", ".ogg", ".m4a", ".aac", ".flac", ".webm"}

# Directories the user has explicitly registered as soundboard "ports" or localized music folders.
# The file endpoint will only serve files that live inside one of these (and only audio files), so a
# crafted ?path= cannot read arbitrary files off the machine.
#
# This registry is PERSISTED. It used to live only in memory, which meant every server restart
# de-authorized every localized music folder: the tracks still had valid localPaths, but /port/file
# answered 403 ("not inside a registered port directory") until the user re-ran Localize, so songs
# silently refused to play. Soundboard path ports were re-registered on panel open (port/list), which
# is why only music was affected. Persisting the set makes localized playback survive a restart.
_ALLOWED_DIRS: set[str] = set()
_REGISTRY_LOCK = threading.Lock()
_REGISTRY_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "audioflix_allowed_dirs.json")
_MAX_REGISTRY = 500


def _load_registry() -> None:
    """Restore the authorized-directory set, dropping any folder that no longer exists."""
    try:
        with open(_REGISTRY_PATH, "r", encoding="utf-8") as handle:
            saved = json.load(handle)
    except (OSError, ValueError):
        return
    if not isinstance(saved, list):
        return
    kept = [e for e in saved if isinstance(e, str) and os.path.isdir(e)]
    _ALLOWED_DIRS.update(kept)
    if len(kept) != len(saved):
        _save_registry()      # write the pruned set back so deleted folders don't linger forever


def _save_registry() -> None:
    try:
        with open(_REGISTRY_PATH, "w", encoding="utf-8") as handle:
            json.dump(sorted(_ALLOWED_DIRS), handle, indent=1)
    except OSError:
        pass          # a read-only checkout just loses persistence, never breaks playback


def authorize_dir(path: str) -> None:
    """Register a directory as servable and persist it (idempotent, bounded)."""
    if not path:
        return
    with _REGISTRY_LOCK:
        canon = _canon(path)
        if canon in _ALLOWED_DIRS:
            return
        if len(_ALLOWED_DIRS) >= _MAX_REGISTRY:
            return
        _ALLOWED_DIRS.add(canon)
        _save_registry()


_CONTENT_TYPES = {
    ".mp3": "audio/mpeg",
    ".wav": "audio/wav",
    ".ogg": "audio/ogg",
    ".m4a": "audio/mp4",
    ".mp4": "video/mp4",
    ".aac": "audio/aac",
    ".flac": "audio/flac",
    ".webm": "audio/webm",
}

_CHUNK = 256 * 1024
_REMOTE_TIMEOUT_SECONDS = 20
_REMOTE_MEDIA_EXACT_TYPES = {
    "application/octet-stream",
    "application/ogg",
    "application/vnd.apple.mpegurl",
    "application/x-mpegurl",
}
_REMOTE_FORWARD_HEADERS = (
    "Content-Type",
    "Content-Length",
    "Content-Range",
    "Accept-Ranges",
    "ETag",
    "Last-Modified",
)


def _parse_range(range_header: str, size: int):
    """Parse a single-range 'bytes=start-end' header -> (start, end) inclusive, or None.

    Returns the sentinel 'invalid' when the range is syntactically fine but unsatisfiable, so the
    caller can answer 416 instead of silently sending the whole file.
    """
    value = str(range_header or "").strip().lower()
    if not value.startswith("bytes=") or "," in value:
        return None
    spec = value[6:].strip()
    if "-" not in spec:
        return None
    first, _, last = spec.partition("-")
    try:
        if not first:                       # suffix form: bytes=-500 (final N bytes)
            length = int(last)
            if length <= 0:
                return "invalid"
            start, end = max(0, size - length), size - 1
        else:
            start = int(first)
            end = int(last) if last else size - 1
    except ValueError:
        return None
    if start > end or start >= size:
        return "invalid"
    return start, min(end, size - 1)


def _serve_file_ranged(handler, real_path: str, content_type: str) -> None:
    """Serve a file with HTTP Range support, streamed in chunks.

    Range support is what makes a media element SEEKABLE: without 'Accept-Ranges' and 206 replies,
    Chrome cannot jump to a position, so dragging the seek bar on a ported/localized track silently
    snapped back (it worked in the internal view only because that seeks through the provider's own
    player API instead of HTTP). Streaming in chunks also stops a long track being read fully into
    memory just to be written out again.
    """
    size = os.path.getsize(real_path)
    parsed = _parse_range(handler.headers.get("Range"), size)

    if parsed == "invalid":
        handler.send_response(HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE)
        handler.send_header("Content-Range", f"bytes */{size}")
        handler.send_header("Content-Length", "0")
        handler.end_headers()
        return

    start, end = parsed if parsed else (0, size - 1)
    length = end - start + 1
    handler.send_response(HTTPStatus.PARTIAL_CONTENT if parsed else HTTPStatus.OK)
    handler.send_header("Content-Type", content_type)
    handler.send_header("Accept-Ranges", "bytes")
    handler.send_header("Content-Length", str(length))
    if parsed:
        handler.send_header("Content-Range", f"bytes {start}-{end}/{size}")
    handler.end_headers()

    with open(real_path, "rb") as handle:
        handle.seek(start)
        remaining = length
        while remaining > 0:
            block = handle.read(min(_CHUNK, remaining))
            if not block:
                break
            try:
                handler.wfile.write(block)
            except (BrokenPipeError, ConnectionResetError):
                return          # the player closed the stream (seek/stop) — not an error
            remaining -= len(block)


def _remote_media_type_allowed(content_type: str) -> bool:
    """Keep the URL port a media transport, not a localhost-authenticated arbitrary web proxy."""
    mime = str(content_type or "").split(";", 1)[0].strip().lower()
    return mime.startswith("audio/") or mime.startswith("video/") or mime in _REMOTE_MEDIA_EXACT_TYPES


def _serve_remote_media(handler, target_url: str) -> None:
    """Stream public remote media through EveOS while preserving upstream byte-range semantics."""
    allowed, reason = validate_public_http_target(target_url)
    if not allowed:
        handler.send_error(HTTPStatus.FORBIDDEN, reason or "Remote media target is not allowed.")
        return

    headers = {
        "User-Agent": "EveOS-Audioflix-MediaPort/1.0",
        "Accept": "audio/*,video/*;q=0.9,application/octet-stream;q=0.8,*/*;q=0.1",
        "Accept-Encoding": "identity",
    }
    requested_range = str(handler.headers.get("Range") or "").strip()
    if requested_range:
        # Forward exactly one browser-supplied range. The upstream server remains authoritative for
        # whether the range is satisfiable and for Content-Range/Content-Length values.
        headers["Range"] = requested_range

    request = urllib.request.Request(target_url, headers=headers, method="GET")
    try:
        with build_public_opener().open(request, timeout=_REMOTE_TIMEOUT_SECONDS) as upstream:
            status = int(getattr(upstream, "status", None) or upstream.getcode() or HTTPStatus.OK)
            if status not in (HTTPStatus.OK, HTTPStatus.PARTIAL_CONTENT):
                handler.send_error(status, "Remote media request failed.")
                return

            content_type = str(upstream.headers.get("Content-Type") or "")
            if not _remote_media_type_allowed(content_type):
                handler.send_error(
                    HTTPStatus.UNSUPPORTED_MEDIA_TYPE,
                    "Remote URL did not return audio/video media.",
                )
                return

            handler.send_response(status)
            for header_name in _REMOTE_FORWARD_HEADERS:
                value = upstream.headers.get(header_name)
                if value:
                    handler.send_header(header_name, value)
            handler.send_header("Cache-Control", "no-store")
            handler.end_headers()

            while True:
                block = upstream.read(_CHUNK)
                if not block:
                    break
                try:
                    handler.wfile.write(block)
                except (BrokenPipeError, ConnectionResetError):
                    return          # media seek/stop closes the old request by design
    except urllib.error.HTTPError as exc:
        status = int(getattr(exc, "code", 0) or HTTPStatus.BAD_GATEWAY)
        if status == HTTPStatus.REQUESTED_RANGE_NOT_SATISFIABLE:
            handler.send_response(status)
            content_range = exc.headers.get("Content-Range") if exc.headers else None
            if content_range:
                handler.send_header("Content-Range", content_range)
            handler.send_header("Content-Length", "0")
            handler.end_headers()
            return
        handler.send_error(status if 400 <= status <= 599 else HTTPStatus.BAD_GATEWAY, "Remote media request failed.")
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        handler.send_error(HTTPStatus.BAD_GATEWAY, f"Remote media unavailable: {exc}")


def _canon(p: str) -> str:
    return os.path.realpath(os.path.abspath(p))


_load_registry()   # restore authorized dirs so localized music plays after a restart


def _is_within(child: str, parent: str) -> bool:
    try:
        return os.path.commonpath([child, parent]) == parent
    except ValueError:
        # Different drives on Windows raise ValueError -> definitely not within.
        return False


def handle_port_get_request(handler, path: str, query, send_json_fn) -> bool:
    if path == "/api/audioflix/port/list":
        dir_path = query.get("path", [""])[0]
        if not dir_path:
            send_json_fn(handler, {"ok": False, "message": "Missing path parameter."}, HTTPStatus.BAD_REQUEST)
            return True

        if not os.path.exists(dir_path) or not os.path.isdir(dir_path):
            send_json_fn(handler, {"ok": False, "message": "Directory does not exist or is not a folder."}, HTTPStatus.NOT_FOUND)
            return True

        try:
            canon_dir = _canon(dir_path)
            authorize_dir(canon_dir)  # registering a port authorizes serving its files (persisted)
            files = []
            for dirpath, _dirnames, filenames in os.walk(canon_dir):
                canon_sub = _canon(dirpath)
                if canon_sub != canon_dir:
                    authorize_dir(canon_sub)  # authorize subdirectories too (persisted)
                for filename in filenames:
                    filepath = os.path.join(dirpath, filename)
                    _, ext = os.path.splitext(filename.lower())
                    if ext in AUDIO_EXTENSIONS:
                        files.append({"name": filename, "path": filepath})
            send_json_fn(handler, {"ok": True, "files": files})
        except Exception as e:
            send_json_fn(handler, {"ok": False, "message": str(e)}, HTTPStatus.INTERNAL_SERVER_ERROR)
        return True

    elif path == "/api/audioflix/port/file":
        file_path = query.get("path", [""])[0]
        if not file_path:
            handler.send_error(HTTPStatus.BAD_REQUEST, "Missing path parameter.")
            return True

        real = _canon(file_path)
        _, ext = os.path.splitext(real.lower())
        if ext not in AUDIO_EXTENSIONS:
            handler.send_error(HTTPStatus.FORBIDDEN, "Only audio files can be served.")
            return True
        # Only serve from directories the user actually registered (a port listing, a localize run,
        # or a folder scan). Do NOT auto-authorize an unknown parent just because the file exists:
        # that would turn this endpoint into an arbitrary audio-file reader for anything that can
        # reach 127.0.0.1. Restart-survival is handled by persisting the registry, not by trusting
        # whatever path was asked for.
        if not any(_is_within(real, d) for d in _ALLOWED_DIRS):
            handler.send_error(HTTPStatus.FORBIDDEN, "File is not inside a registered port directory.")
            return True
        if not os.path.isfile(real):
            # Fallback: the stored localPath may point to the wrong subdirectory level.
            # Search registered allowed dirs for a file with the same basename.
            target_name = os.path.basename(real).lower()
            found = None
            for allowed in list(_ALLOWED_DIRS):
                try:
                    for dirpath, _dns, fns in os.walk(allowed):
                        for fn in fns:
                            if fn.lower() == target_name:
                                candidate = os.path.join(dirpath, fn)
                                if os.path.isfile(candidate):
                                    found = _canon(candidate)
                                    break
                        if found:
                            break
                except OSError:
                    continue
                if found:
                    break
            if not found:
                handler.send_error(HTTPStatus.NOT_FOUND, "File not found.")
                return True
            real = found

        try:
            _serve_file_ranged(handler, real, _CONTENT_TYPES.get(ext, "application/octet-stream"))
        except Exception as e:
            handler.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, str(e))
        return True

    elif path == "/api/audioflix/port/url":
        target_url = str((query.get("url") or [""])[0]).strip()
        if not target_url:
            handler.send_error(HTTPStatus.BAD_REQUEST, "Missing url parameter.")
            return True
        _serve_remote_media(handler, target_url)
        return True

    return False
