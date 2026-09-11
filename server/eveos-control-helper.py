#!/usr/bin/env python3
"""Entrypoint for the EveOS local control plane."""

from __future__ import annotations

import os
import sys


SERVER_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_ROOT = os.path.dirname(SERVER_DIR)
if PROJECT_ROOT not in sys.path:
    sys.path.insert(0, PROJECT_ROOT)

from server_modules.eveos_ports import PortRegistryError, assert_unique_effective_ports  # noqa: E402

try:
    assert_unique_effective_ports()
except PortRegistryError as exc:
    print(f"[ERROR] {exc}", file=sys.stderr)
    raise SystemExit(2)

from server_modules.eveos_control_helper import main  # noqa: E402


if __name__ == "__main__":
    raise SystemExit(main())
