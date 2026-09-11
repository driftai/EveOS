#!/usr/bin/env python3
"""Launch the existing EveOS server with an explicit network bind.

The legacy server module historically bound an empty host, which means all interfaces.
Official launchers go through this adapter so the default is truly loopback-only while
LAN mode remains an explicit opt-in.
"""

from __future__ import annotations

import argparse
import importlib.util
import os
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parent.parent
LEGACY_ENTRY = Path(__file__).resolve().parent / "python-server.py"


def load_server_module():
    spec = importlib.util.spec_from_file_location("eveos_legacy_server", LEGACY_ENTRY)
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not load EveOS server: {LEGACY_ENTRY}")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def normalize_host(value: str) -> str:
    host = str(value or "127.0.0.1").strip().lower()
    if host in {"localhost", "loopback"}:
        return "127.0.0.1"
    if host not in {"127.0.0.1", "0.0.0.0"}:
        raise argparse.ArgumentTypeError("host must be 127.0.0.1 or 0.0.0.0")
    return host


def main() -> int:
    parser = argparse.ArgumentParser(description="EveOS explicit-host web/API launcher")
    parser.add_argument("port", nargs="?", type=int, default=3000)
    parser.add_argument("--host", type=normalize_host, default="127.0.0.1")
    parser.add_argument("--modular-root", default="")
    parser.add_argument("--persist-modular-root", action="store_true")
    parser.add_argument("--no-browser", action="store_true")
    args, unknown = parser.parse_known_args()
    if unknown:
        if args.modular_root and all(not str(token).startswith("-") for token in unknown):
            args.modular_root = " ".join([args.modular_root] + [str(token) for token in unknown]).strip()
        else:
            parser.error(f"unrecognized arguments: {' '.join(str(token) for token in unknown)}")

    if not args.modular_root:
        args.modular_root = os.environ.get("EVEOS_MODULAR_ROOT", "").strip()

    module = load_server_module()
    original_server = module.EveOSThreadingServer
    selected_host = args.host

    class ExplicitHostServer(original_server):
        def __init__(self, server_address, handler, bind_and_activate=True):
            _ignored_host, port = server_address
            super().__init__((selected_host, port), handler, bind_and_activate)

    module.EveOSThreadingServer = ExplicitHostServer
    module.configure_modular_store(args.modular_root, args.persist_modular_root)
    mode = "LAN" if selected_host == "0.0.0.0" else "LOCALHOST"
    print(f"[BOOT] EveOS selective bind: {mode} ({selected_host}:{args.port})")
    return int(module.run_server(args.port, open_browser=not args.no_browser) or 0)


if __name__ == "__main__":
    raise SystemExit(main())
