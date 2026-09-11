"""Launch the EveOS local control plane and verify its HTTP surface and lifecycle."""

from __future__ import annotations

import json
import os
import socket
import subprocess
import sys
import time
from pathlib import Path
from urllib.error import URLError
from urllib.request import urlopen

ROOT = Path(__file__).resolve().parents[2]
CONTROL_SERVER = ROOT / "server" / "eveos-control-helper.py"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def fetch_json(url: str, timeout: float = 3.0) -> tuple[int, dict]:
    with urlopen(url, timeout=timeout) as response:
        body = response.read().decode("utf-8")
        return int(response.status), json.loads(body)


def main() -> int:
    if not CONTROL_SERVER.is_file():
        raise SystemExit(f"ASSERT FAILED: missing control entrypoint: {CONTROL_SERVER}")

    port = free_port()
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"
    env["EVEOS_HEADLESS"] = "1"

    process = subprocess.Popen(
        [sys.executable, str(CONTROL_SERVER), str(port)],
        cwd=ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
    )

    deadline = time.monotonic() + 15
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                raise SystemExit(
                    f"ASSERT FAILED: Control plane exited early with code {process.returncode}."
                )
            try:
                # 1. Probe health endpoint
                health_status, health = fetch_json(f"http://127.0.0.1:{port}/api/control-plane/health", timeout=5.0)
                if health_status != 200:
                    raise SystemExit(f"ASSERT FAILED: /api/control-plane/health returned HTTP {health_status}")
                if health.get("service") != "eveos-control-plane":
                    raise SystemExit(f"ASSERT FAILED: unexpected service name: {health.get('service')}")
                if health.get("running") is not True:
                    raise SystemExit("ASSERT FAILED: control plane reported running != True")

                # 2. Probe status endpoint
                status_code, status_payload = fetch_json(f"http://127.0.0.1:{port}/api/control-plane/status", timeout=5.0)
                if status_code != 200:
                    raise SystemExit(f"ASSERT FAILED: /api/control-plane/status returned HTTP {status_code}")
                if status_payload.get("ok") is not True:
                    raise SystemExit("ASSERT FAILED: control plane status reported ok != True")

                # 3. Probe legacy /api/status endpoint
                legacy_status, legacy_payload = fetch_json(f"http://127.0.0.1:{port}/api/status", timeout=5.0)
                if legacy_status != 200:
                    raise SystemExit(f"ASSERT FAILED: /api/status returned HTTP {legacy_status}")
                if legacy_payload.get("service") != "eveos-control-plane":
                    raise SystemExit("ASSERT FAILED: legacy /api/status reported unexpected service")

                print("EVEOS_CONTROL_PLANE_STARTUP_SMOKE_OK")
                return 0
            except (URLError, TimeoutError, ConnectionError, OSError):
                time.sleep(0.25)

        raise SystemExit(
            f"ASSERT FAILED: Control plane did not become ready on port {port} within 15 seconds."
        )
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=2)


if __name__ == "__main__":
    raise SystemExit(main())
