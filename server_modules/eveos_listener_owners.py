"""Exact local listener ownership across Windows socket-reporting variants."""

from __future__ import annotations

import os
import subprocess


def parse_netstat_listener_pids(output: str, port: int) -> list[int]:
    expected = str(int(port))
    found = set()
    for line in (output or "").splitlines():
        parts = line.split()
        if len(parts) < 5 or "LISTENING" not in line.upper() or not parts[-1].isdigit():
            continue
        if parts[1].rsplit(":", 1)[-1] == expected:
            found.add(int(parts[-1]))
    return sorted(pid for pid in found if pid > 0)


def connection_listener_pids(connections, port: int) -> list[int]:
    """Accept owner-bearing, remote-empty sockets even when Windows omits LISTEN."""
    found = set()
    for connection in connections:
        local = getattr(connection, "laddr", None)
        remote = getattr(connection, "raddr", None)
        pid = int(getattr(connection, "pid", 0) or 0)
        if local and int(getattr(local, "port", 0) or 0) == int(port) and not remote and pid > 0:
            found.add(pid)
    return sorted(found)


def windows_listener_pids(port: int) -> list[int]:
    if os.name != "nt":
        return []
    try:
        import psutil  # Optional fast path; PowerShell remains the portable fallback.
        found = connection_listener_pids(psutil.net_connections(kind="tcp"), port)
        if found:
            return found
    except (ImportError, OSError):
        pass

    script = (
        f"Get-NetTCPConnection -LocalPort {int(port)} -ErrorAction SilentlyContinue | "
        "Where-Object {$_.OwningProcess -gt 0 -and $_.RemotePort -eq 0} | "
        "Select-Object -ExpandProperty OwningProcess -Unique"
    )
    result = subprocess.run(
        ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script],
        capture_output=True, text=True, check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    found = sorted({int(value) for value in result.stdout.split() if value.isdigit() and int(value) > 0})
    if found:
        return found

    result = subprocess.run(
        ["netstat", "-ano", "-p", "tcp"], capture_output=True, text=True,
        check=False, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return parse_netstat_listener_pids(result.stdout or "", port)
