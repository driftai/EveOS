#!/usr/bin/env python3
"""Runtime proof for the canonical EveOS service-port registry."""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import eveos_ports  # noqa: E402


def check(condition, message):
    if not condition:
        raise AssertionError(message)


def main():
    registered = eveos_ports.registered_ports()
    check(registered["GEMINI_WS_PORT"] == 9085, "Gemini Live WebSocket assignment changed unexpectedly")
    check(registered["WATCHFUSION_PORT"] == 9087, "WatchFusion assignment is not the migrated port")
    check(not eveos_ports.conflicts(effective=False), "canonical registry contains a duplicate port")

    env = os.environ.copy()
    env["GEMINI_WS_PORT"] = "19085"
    env["WATCHFUSION_PORT"] = "19085"
    result = subprocess.run(
        [sys.executable, str(ROOT / "server" / "eveos-control-helper.py"), "19082", "--probe", "--timeout", "0.1"],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    combined = f"{result.stdout}\n{result.stderr}"
    check(result.returncode == 2, f"control plane did not refuse colliding overrides: rc={result.returncode}")
    check("service-port collision" in combined.lower(), "collision refusal did not explain the port conflict")

    env = os.environ.copy()
    env["WATCHFUSION_PORT"] = "19087"
    probe = subprocess.run(
        [
            sys.executable,
            "-c",
            "from server_modules import eveos_ports; "
            "from server_modules import watchfusion_control; "
            "print(eveos_ports.service_port('WATCHFUSION_PORT')); "
            "print(watchfusion_control.WATCHFUSION_PORT)",
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        text=True,
        timeout=5,
        check=False,
    )
    check(probe.returncode == 0, probe.stderr or "WatchFusion override probe failed")
    values = [line.strip() for line in probe.stdout.splitlines() if line.strip()]
    check(values[-2:] == ["19087", "19087"], f"WatchFusion ignored registry override: {values}")

    print("EVEOS_PORT_REGISTRY_SMOKE_OK")


if __name__ == "__main__":
    main()
