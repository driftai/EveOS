#!/usr/bin/env python3
"""EveOS local web and API server."""

import http.server
import socketserver
import os
import sys
import argparse
import errno
import logging
import socket
import webbrowser
from urllib.parse import urlparse, parse_qs
from http import HTTPStatus

SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SERVER_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

if hasattr(sys.stdout, 'reconfigure'):
    sys.stdout.reconfigure(encoding='utf-8', errors='replace')
if hasattr(sys.stderr, 'reconfigure'):
    sys.stderr.reconfigure(encoding='utf-8', errors='replace')

# These handlers back advertised API routes. Starting without one leaves the
# process listening while requests fail later with NameError, so imports are a
# hard startup contract rather than an optional best-effort step.
try:
    from server_modules import wikipedia
    from server_modules import proxy
    from server_modules import lightpanda
    from server_modules import popup_viewer
    from server_modules import eve_state_store
    from server_modules import gemini_control
    from server_modules import gemini_credentials
    from server_modules import audioflix_bridge
    from server_modules import world_book_control
    from server_modules import eveos_server_status
    from server_modules.eveos_http_cors import eveos_cors_origin
except ImportError as exc:
    raise SystemExit(f"[FATAL] EveOS server dependency import failed: {exc}") from exc

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="[Server] %(message)s",
    handlers=[logging.StreamHandler()]
)
logger = logging.getLogger("EveOSServer")

# Default port
DEFAULT_PORT = 3000
DEFAULT_HOST = "127.0.0.1"
ALLOWED_HOSTS = {"127.0.0.1", "0.0.0.0"}

def configure_modular_store(modular_root=None, persist_modular_root=False):
    """
    Apply an optional per-process modular store override.
    This enables multiple server instances (different ports) to run against
    different data-pack folders at the same time.
    """
    if not modular_root:
        return

    try:
        resolved = eve_state_store.set_active_store_root(
            modular_root,
            create_if_missing=True,
            persist=bool(persist_modular_root)
        )
        print(f"[OK] Modular store root: {resolved}")
    except Exception as exc:
        print(f"[ERROR] Failed to apply modular store path '{modular_root}': {exc}")
        sys.exit(1)


class CORSHTTPRequestHandler(http.server.SimpleHTTPRequestHandler):
    """Custom HTTP request handler with CORS support"""
    
    def __init__(self, *args, **kwargs):
        # Serve EveOS assets from the project root even though this entrypoint
        # lives under server/ to keep the repo root clean.
        directory = PROJECT_ROOT
        super().__init__(*args, directory=directory, **kwargs)
    
    def end_headers(self):
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
            self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        else:
            # Content fingerprints make file:// loads deterministic. Localhost still
            # revalidates every asset so an unsynchronized development edit cannot
            # leave an existing browser tab pinned to yesterday's implementation.
            self.send_header("Cache-Control", "no-cache")
    
    def do_OPTIONS(self):
        """Handle OPTIONS request method for CORS preflight requests"""
        self.send_response(HTTPStatus.NO_CONTENT)
        self.end_headers()
    
    def do_GET(self):
        """Handle GET requests with custom error handling"""
        try:
            # Check for API endpoints
            if self.path.startswith('/api/'):
                self.handle_api_request()
                return
                
            # Handle normal file requests
            super().do_GET()
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError) as e:
            logger.debug(f"Client disconnected during GET request: {e}")
        except Exception as e:
            logger.error(f"Error handling GET request: {str(e)}")
            # If headers haven't been sent, send error
            try:
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Server error: {str(e)}")
            except (BrokenPipeError, ConnectionError, OSError):
                pass # Headers likely already sent

    def do_POST(self):
        """Handle POST requests for API endpoints"""
        try:
            if self.path.startswith('/api/'):
                self.handle_api_post_request()
                return
            self.send_error(HTTPStatus.METHOD_NOT_ALLOWED, "POST not supported for this endpoint")
        except (ConnectionResetError, ConnectionAbortedError, BrokenPipeError, TimeoutError) as e:
            logger.debug(f"Client disconnected during POST request: {e}")
        except Exception as e:
            logger.error(f"Error handling POST request: {str(e)}")
            try:
                self.send_error(HTTPStatus.INTERNAL_SERVER_ERROR, f"Server error: {str(e)}")
            except (BrokenPipeError, ConnectionError, OSError):
                pass
    
    def log_message(self, format, *args):
        """Override log_message to use our logger"""
        logger.info(format % args)
    
    def handle_api_request(self):
        """Handle custom API endpoints"""
        parsed_path = urlparse(self.path)
        path = parsed_path.path
        query = parse_qs(parsed_path.query)
        
        if path == '/api/status':
            gemini_control.send_json(self, eveos_server_status.build_status(self.server))
        
        elif path == '/api/wikipedia/search':
            # Handle Wikipedia search request
            wikipedia.handle_wikipedia_search(self, query)
            
        elif path == '/api/proxy':
            # Handle proxy request
            proxy.handle_proxy_request(self, query)

        elif path == '/api/lightpanda':
            # Handle Lightpanda fetch request
            lightpanda.handle_lightpanda_fetch(self, query)

        elif path == '/api/popup-view' or path.startswith('/api/popup-view/'):
            popup_viewer.handle_popup_view(self, query)

        elif path == '/api/popup-resource' or path.startswith('/api/popup-resource/'):
            popup_viewer.handle_popup_resource_request(self, query)

        elif path.startswith('/api/eve-state/modular/'):
            if not eve_state_store.handle_get_request(self, path, query):
                self.send_response(HTTPStatus.NOT_FOUND)
                self.send_header('Content-Type', 'application/json')
                self.end_headers()
                self.wfile.write(b'{"error": "Unknown modular state endpoint"}')

        elif path == '/api/gemini-server/status':
            gemini_control.send_json(self, gemini_control.get_status())

        elif world_book_control.handle_get_request(self, path):
            return

        elif path == '/api/gemini-credentials/status':
            if not gemini_control.request_can_control(self):
                gemini_control.send_json(
                    self,
                    {"ok": False, "configured": False, "message": "Local access required."},
                    HTTPStatus.FORBIDDEN
                )
                return
            gemini_control.send_json(self, gemini_credentials.get_status())

        elif path.startswith('/api/audioflix/'):
            if audioflix_bridge.handle_get_request(self, path, query):
                return
            self.send_response(HTTPStatus.NOT_FOUND)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error": "Unknown Audioflix endpoint"}')
            
        else:
            # Unknown API endpoint
            self.send_response(HTTPStatus.NOT_FOUND)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error": "Unknown API endpoint"}')

    def handle_api_post_request(self):
        """Handle API POST endpoints"""
        parsed_path = urlparse(self.path)
        path = parsed_path.path
        query = parse_qs(parsed_path.query)

        if path == '/api/proxy':
            proxy.handle_proxy_post_request(self, query)
            return

        if path == '/api/popup-resource' or path.startswith('/api/popup-resource/'):
            popup_viewer.handle_popup_resource_request(self, query)
            return

        if path.startswith('/api/eve-state/modular/'):
            if eve_state_store.handle_post_request(self, path):
                return
            self.send_response(HTTPStatus.NOT_FOUND)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error": "Unknown modular state endpoint"}')
            return

        if path in {'/api/gemini-server/start', '/api/gemini-server/stop'}:
            if not gemini_control.request_can_control(self):
                gemini_control.send_json(
                    self,
                    {
                        "ok": False,
                        "controllerAvailable": True,
                        "state": "forbidden",
                        "running": False,
                        "message": "Gemini server control is limited to local EveOS pages."
                    },
                    HTTPStatus.FORBIDDEN
                )
                return
            action = gemini_control.start_server if path.endswith('/start') else gemini_control.stop_server
            payload = action()
            gemini_control.send_json(self, payload, HTTPStatus.OK if payload.get("ok") else HTTPStatus.INTERNAL_SERVER_ERROR)
            return

        if world_book_control.handle_post_request(self, path):
            return

        if path == '/api/gemini-credentials':
            if not gemini_control.request_can_control(self):
                gemini_control.send_json(
                    self,
                    {"ok": False, "configured": False, "message": "Local access required."},
                    HTTPStatus.FORBIDDEN
                )
                return
            body = gemini_credentials.read_json_body(self)
            payload = gemini_credentials.save_api_key(body.get("apiKey", ""))
            gemini_control.send_json(
                self,
                payload,
                HTTPStatus.OK if payload.get("ok") else HTTPStatus.BAD_REQUEST
            )
            return

        if path.startswith('/api/audioflix/'):
            if audioflix_bridge.handle_post_request(self, path):
                return
            self.send_response(HTTPStatus.NOT_FOUND)
            self.send_header('Content-Type', 'application/json')
            self.end_headers()
            self.wfile.write(b'{"error": "Unknown Audioflix endpoint"}')
            return

        self.send_response(HTTPStatus.NOT_FOUND)
        self.send_header('Content-Type', 'application/json')
        self.end_headers()
        self.wfile.write(b'{"error": "Unknown API endpoint"}')

def get_local_ip():
    """Get local IP address for displaying server URLs"""
    try:
        # This doesn't actually establish a connection
        s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
        s.connect(("8.8.8.8", 80))
        local_ip = s.getsockname()[0]
        s.close()
        return local_ip
    except Exception:
        return "127.0.0.1"

class EveOSThreadingServer(socketserver.ThreadingTCPServer):
    """Thread-per-request server that supports dual-stack IPv4/IPv6 and exits cleanly after Ctrl+C."""

    allow_reuse_address = True
    daemon_threads = True
    block_on_close = False

    def __init__(self, server_address, RequestHandlerClass, bind_and_activate=True):
        self.address_family = socket.AF_INET6
        try:
            super().__init__(server_address, RequestHandlerClass, bind_and_activate)
        except Exception:
            self.address_family = socket.AF_INET
            super().__init__(server_address, RequestHandlerClass, bind_and_activate)

    def server_bind(self):
        if self.address_family == socket.AF_INET6:
            if hasattr(socket, 'has_dualstack_ipv6') and socket.has_dualstack_ipv6():
                self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
            else:
                try:
                    self.socket.setsockopt(socket.IPPROTO_IPV6, socket.IPV6_V6ONLY, 0)
                except (OSError, socket.error):
                    pass
        super().server_bind()


def normalize_host(host):
    value = str(host or DEFAULT_HOST).strip().lower()
    if value in {"localhost", "loopback"}:
        value = DEFAULT_HOST
    if value not in ALLOWED_HOSTS:
        raise ValueError("EveOS host must be 127.0.0.1 or 0.0.0.0")
    return value


def run_server(port=DEFAULT_PORT, open_browser=True, host=DEFAULT_HOST):
    """Run the HTTP server. Loopback is the safe default; LAN is explicit opt-in."""
    host = normalize_host(host)
    try:
        # Create server with threading support
        handler = CORSHTTPRequestHandler
        with EveOSThreadingServer((host, port), handler) as httpd:
            local_ip = get_local_ip()
            url = f"http://127.0.0.1:{port}/EveOS.html"
            active_store = ""
            try:
                active_store = str(eve_state_store.get_active_store_root())
            except Exception:
                active_store = ""
            
            # Print server information
            print("[OK] EveOS Local Server")
            print("  ------------------------------")
            print(f"  Local:   {url}")
            if host == "0.0.0.0":
                print(f"  Network: http://{local_ip}:{port}/EveOS.html")
            else:
                print("  Network: disabled (localhost-only)")
            if active_store:
                print(f"  Data:    {active_store}")
            print("  ------------------------------")
            print("  Proxy:   Enabled at /api/proxy?url=...")
            print("  Popup:   Enabled at /api/popup-view?url=...")
            print("  Bridge:  Lightpanda/WSL enabled at /api/lightpanda")
            print("  Gemini:  Lifecycle control enabled at /api/gemini-server/status")
            print(f"  World:   Saved lifecycle state on port {world_book_control.WORLD_BOOK_PORT}")
            print("  Audio:   Soundboard + VB-Cable bypass + global hotkeys at /api/audioflix/*")
            # Pre-warm the audio device scan so the first soundboard press / hotkey right after
            # boot isn't delayed by a cold WASAPI device enumeration. Non-fatal, off-thread.
            try:
                import threading as _af_t
                _af_t.Thread(target=lambda: audioflix_bridge.list_devices(force=True), daemon=True).start()
            except Exception as exc:
                logger.debug("Audioflix device prewarm skipped: %s", exc)
            world_book_control.restore_desired_state_async()
            print("  ------------------------------")
            print("  Press Ctrl+C to stop the server")
            
            # Open browser
            if open_browser:
                print("  Opening browser...")
                webbrowser.open(url)
            
            # Start server
            httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n[OK] Server stopped")
    except Exception as e:
        print(f"[ERROR] Server error: {str(e)}")
        # If port is in use, suggest another port
        if isinstance(e, OSError) and e.errno in {errno.EADDRINUSE, 10048}:
            suggested_port = port + 1
            print(f"[WARN] Port {port} is already in use. Try using port {suggested_port}:")
            print(f"   python server/python-server.py {suggested_port}")
        return 1
    return 0

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="EveOS local web and API server"
    )
    parser.add_argument(
        "port",
        nargs="?",
        type=int,
        default=DEFAULT_PORT,
        help=f"HTTP port to bind (default: {DEFAULT_PORT})"
    )
    parser.add_argument(
        "--host",
        dest="host",
        choices=sorted(ALLOWED_HOSTS),
        default=DEFAULT_HOST,
        help="Network bind. Defaults to localhost-only; use 0.0.0.0 only for explicit LAN mode."
    )
    parser.add_argument(
        "--modular-root",
        dest="modular_root",
        default="",
        help="Override modular state root folder for this server instance."
    )
    parser.add_argument(
        "--persist-modular-root",
        dest="persist_modular_root",
        action="store_true",
        help="Persist --modular-root into shared modular-store settings."
    )
    parser.add_argument(
        "--no-browser",
        dest="no_browser",
        action="store_true",
        help="Start server without auto-opening a browser tab."
    )

    args, unknown = parser.parse_known_args()
    if unknown:
        # Be tolerant if a modular-root path with spaces was passed without
        # proper quoting (common when launched from batch scripts).
        if args.modular_root and all(not str(token).startswith("-") for token in unknown):
            args.modular_root = " ".join([args.modular_root] + [str(token) for token in unknown]).strip()
        else:
            parser.error(f"unrecognized arguments: {' '.join(str(token) for token in unknown)}")
    if not args.modular_root:
        env_modular_root = os.environ.get("EVEOS_MODULAR_ROOT", "").strip()
        if env_modular_root:
            args.modular_root = env_modular_root
    configure_modular_store(args.modular_root, args.persist_modular_root)
    sys.exit(run_server(args.port, open_browser=not args.no_browser, host=args.host))