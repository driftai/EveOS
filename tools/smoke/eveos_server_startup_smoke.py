"""Launch the EveOS Python server and verify its core HTTP surface is alive."""

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
SERVER = ROOT / "server" / "python-server.py"


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def fetch(url: str) -> tuple[int, bytes]:
    with urlopen(url, timeout=2) as response:
        return int(response.status), response.read()


def launcher_python() -> str:
    """Use the same interpreter selection as the Windows launcher when possible."""
    if os.name != "nt":
        return sys.executable

    comspec = os.environ.get("ComSpec") or os.environ.get("COMSPEC") or "cmd.exe"
    command = r"call tools\batch\eveos-python.bat >nul && echo(!EVEOS_PYTHON!"
    resolved = subprocess.run(
        [comspec, "/d", "/v:on", "/c", command],
        cwd=ROOT,
        env=os.environ.copy(),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
        timeout=10,
        check=False,
    )
    if resolved.returncode != 0:
        raise SystemExit(
            "ASSERT FAILED: launcher Python resolver failed.\n" + (resolved.stdout or "")
        )

    lines = [line.strip() for line in (resolved.stdout or "").splitlines() if line.strip()]
    if not lines:
        raise SystemExit("ASSERT FAILED: launcher Python resolver returned no interpreter path")
    candidate = Path(lines[-1])
    if not candidate.is_file():
        raise SystemExit(f"ASSERT FAILED: launcher Python does not exist: {candidate}")
    return str(candidate)


def main() -> int:
    if not SERVER.is_file():
        raise SystemExit(f"ASSERT FAILED: missing server entrypoint: {SERVER}")

    port = free_port()
    python_executable = launcher_python()
    env = os.environ.copy()
    env["PYTHONUNBUFFERED"] = "1"

    process = subprocess.Popen(
        [python_executable, str(SERVER), str(port), "--no-browser"],
        cwd=ROOT,
        env=env,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
    )

    deadline = time.monotonic() + 12
    captured: list[str] = []
    try:
        while time.monotonic() < deadline:
            if process.poll() is not None:
                output = process.stdout.read() if process.stdout else ""
                captured.append(output)
                raise SystemExit(
                    "ASSERT FAILED: EveOS server exited before becoming ready.\n"
                    f"Launcher Python: {python_executable}\n"
                    + "".join(captured)
                )
            try:
                status, body = fetch(f"http://127.0.0.1:{port}/api/status")
                if status != 200:
                    raise SystemExit(f"ASSERT FAILED: /api/status returned HTTP {status}")
                payload = json.loads(body.decode("utf-8"))
                if not isinstance(payload, dict):
                    raise SystemExit("ASSERT FAILED: /api/status did not return a JSON object")
                if payload.get("service") != "eveos-local-server":
                    raise SystemExit(
                        f"ASSERT FAILED: /api/status returned wrong service identity: {payload.get('service')!r}"
                    )
                if int(payload.get("port") or 0) != port:
                    raise SystemExit(
                        f"ASSERT FAILED: /api/status returned wrong port: {payload.get('port')!r}"
                    )

                page_status, page = fetch(f"http://127.0.0.1:{port}/EveOS.html")
                if page_status != 200:
                    raise SystemExit(f"ASSERT FAILED: /EveOS.html returned HTTP {page_status}")
                if b"EveOS" not in page[:20000]:
                    raise SystemExit("ASSERT FAILED: /EveOS.html did not return EveOS content")

                print(f"EVEOS_SERVER_STARTUP_SMOKE_OK (python={python_executable})")
                return 0
            except (URLError, TimeoutError, ConnectionError, OSError):
                time.sleep(0.2)

        output = process.stdout.read() if process.stdout else ""
        raise SystemExit(
            "ASSERT FAILED: EveOS server did not become ready within 12 seconds.\n"
            f"Launcher Python: {python_executable}\n" + output
        )
    finally:
        if process.poll() is None:
            process.terminate()
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=3)


if __name__ == "__main__":
    raise SystemExit(main())
