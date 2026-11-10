"""Package only EveOS-authored Edge telemetry on successful owned-session Stop."""
from __future__ import annotations
import json
import os
from datetime import datetime
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile


def session_report_path():
    """Return a report path only for an explicitly enabled qualification run."""
    if os.environ.get("EVEOS_SPOTIFY_EDGE_SESSION_DIAGNOSTICS", "").strip() != "1":
        return None
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    return Path.home() / "Downloads" / "EveOS-Diagnostics" / "Spotify-Edge-Integration" / f"embed-{stamp}.jsonl"


def archive_live_report(report):
    report = Path(report)
    if report.suffix != ".jsonl" or not report.name.startswith("embed-"):
        raise OSError("Unsupported session diagnostic report")
    if not report.is_file() or report.is_symlink() or report.stat().st_size > 15_000_000:
        raise OSError("Session report missing, linked or too large")
    output = report.with_suffix(".zip")
    manifest = {"purpose": "EveOS Spotify Edge session diagnostics",
                "source": report.name, "format": "jsonl",
                "notes": "Playback status, route and hide events only; no Spotify audio, cookies or credentials"}
    with ZipFile(output, "w", ZIP_DEFLATED, compresslevel=7) as archive:
        archive.write(report, arcname="session/" + report.name)
        archive.writestr("README.json", json.dumps(manifest, indent=2) + "\n")
    return output
