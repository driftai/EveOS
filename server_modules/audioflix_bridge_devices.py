"""Audioflix Windows and PortAudio endpoint discovery."""

from __future__ import annotations

import json
import re
import subprocess
import time
from pathlib import Path

from server_modules.audioflix_bridge_playback import refresh_portaudio_devices

try:
    import numpy as np
except Exception:  # pragma: no cover - optional runtime dependency
    np = None

try:
    import sounddevice as sd
except Exception:  # pragma: no cover - optional runtime dependency
    sd = None

_DEVICE_CACHE: dict = {"at": 0.0, "payload": None}
_DEVICE_CACHE_TTL = 10.0
_PROJECT_ROOT = Path(__file__).resolve().parents[1]

def spotify_mode_prerequisites(*, platform=None, environ=None, exists=None, module_exists=None) -> dict:
    """Read-only optional Spotify requirements; never launches browsers or changes audio routes."""
    import importlib.util
    import os
    import sys
    platform = sys.platform if platform is None else platform
    environ = os.environ if environ is None else environ
    exists = Path.is_file if exists is None else exists
    module_exists = (lambda name: importlib.util.find_spec(name) is not None) if module_exists is None else module_exists
    windows = platform == 'win32'
    roots = [environ.get('PROGRAMFILES(X86)'), environ.get('PROGRAMFILES'), environ.get('LOCALAPPDATA')]
    candidates = {str(Path(root) / 'Microsoft' / 'Edge Beta' / 'Application' / 'msedge.exe')
                  for root in roots if root} if windows else set()
    edge = any(exists(Path(candidate)) for candidate in candidates)
    return {
        'platform': platform,
        'edgeBetaInstalled': edge,
        'windowsRoutingAdapterInstalled': bool(module_exists('winappaudiorouter')) if windows else False,
    }

def _sd_outputs() -> list[dict]:
    if sd is None:
        return []
    hostapis = sd.query_hostapis()
    devices = []
    for index, info in enumerate(sd.query_devices()):
        if int(info.get("max_output_channels") or 0) <= 0:
            continue
        hostapi_index = int(info.get("hostapi") or 0)
        hostapi = str(hostapis[hostapi_index].get("name") or "") if hostapi_index < len(hostapis) else ""
        label = str(info.get("name") or f"Output device {index}")
        if hostapi:
            label = f"{label} ({hostapi})"
        devices.append({
            "id": f"sd:{index}",
            "index": index,
            "label": label,
            "kind": "output",
            "channels": int(info.get("max_output_channels") or 0),
            "sampleRate": float(info.get("default_samplerate") or 0),
            "hostApi": hostapi,
            "source": "sounddevice",
            "playable": True,
        })
    return devices


def _sd_inputs() -> list[dict]:
    if sd is None:
        return []
    hostapis = sd.query_hostapis()
    devices = []
    for index, info in enumerate(sd.query_devices()):
        if int(info.get("max_input_channels") or 0) <= 0:
            continue
        hostapi_index = int(info.get("hostapi") or 0)
        hostapi = str(hostapis[hostapi_index].get("name") or "") if hostapi_index < len(hostapis) else ""
        label = str(info.get("name") or f"Input device {index}")
        if _looks_broken_label(label) or _is_low_level_output({"hostApi": hostapi}):
            continue
        if hostapi:
            label = f"{label} ({hostapi})"
        devices.append({
            "id": f"sd-in:{index}",
            "index": index,
            "label": label,
            "kind": "input",
            "channels": int(info.get("max_input_channels") or 0),
            "sampleRate": float(info.get("default_samplerate") or 0),
            "hostApi": hostapi,
            "source": "sounddevice",
            "playable": False,
        })
    return devices


def _windows_endpoint_names() -> list[dict]:
    if not hasattr(subprocess, "run"):
        return []
    script = (
        "Get-CimInstance Win32_PnPEntity | "
        "Where-Object { $_.PNPClass -eq 'AudioEndpoint' -and $_.Name } | "
        "Select-Object Name,DeviceID,Status | ConvertTo-Json -Compress"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script],
            capture_output=True,
            text=True,
            timeout=3,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    except Exception:
        return []
    if result.returncode != 0 or not result.stdout.strip():
        return []
    try:
        raw = json.loads(result.stdout)
    except json.JSONDecodeError:
        return []
    rows = raw if isinstance(raw, list) else [raw]
    devices = []
    for idx, row in enumerate(rows):
        label = str(row.get("Name") or "").strip()
        if not label:
            continue
        devices.append({
            "id": f"win:{idx}",
            "label": label,
            "kind": _guess_endpoint_kind(label),
            "status": str(row.get("Status") or ""),
            "source": "windows",
            "playable": False,
        })
    return devices


def _guess_endpoint_kind(label: str) -> str:
    lowered = str(label or "").lower()
    if any(t in lowered for t in ("cable input", "voicemeeter input", "speakers")):
        return "output"
    if any(t in lowered for t in ("cable output", "voicemeeter output", "microphone", "line in", "recording", "capture")):
        return "input"
    return "output"


def _normalized_label(label: str) -> str:
    text = re.sub(r"\s*\((?:MME|Windows DirectSound|Windows WASAPI|Windows WDM-KS|ASIO)\)\s*$", "", str(label or "").strip(), flags=re.IGNORECASE)
    return re.sub(r"[^a-z0-9]+", "", text.lower())


def _is_generic_output(label: str) -> bool:
    return str(label or "").strip().lower() in {"microsoft sound mapper - output", "primary sound driver"}


def _is_low_level_output(item: dict) -> bool:
    return "wdm-ks" in str(item.get("hostApi") or "").lower()


def _looks_broken_label(label: str) -> bool:
    t = str(label or "").strip()
    return not t or t.endswith("()") or t.endswith("(")


def _rank_output(item: dict) -> int:
    label = str(item.get("label") or "")
    hostapi = str(item.get("hostApi") or "").lower()
    rank = 0 if "wasapi" in hostapi else (10 if "directsound" in hostapi else (20 if hostapi == "mme" else (90 if "wdm-ks" in hostapi else 50)))
    if _is_generic_output(label):
        rank += 100
    if _looks_broken_label(label):
        rank += 40
    if "cable input" in label.lower():
        rank -= 10
    elif "voicemeeter" in label.lower():
        rank -= 6
    return rank


def _same_output_label(left: str, right: str) -> bool:
    a = _normalized_label(left)
    b = _normalized_label(right)
    if not a or not b:
        return False
    if a == b:
        return True
    return min(len(a), len(b)) >= 18 and (a.startswith(b) or b.startswith(a))


def _merge_outputs(sd_outputs: list[dict], win_devices: list[dict]) -> list[dict]:
    playable = [item for item in sd_outputs
                if not _is_generic_output(item.get("label", ""))
                and not _looks_broken_label(item.get("label", ""))
                and not _is_low_level_output(item)]
    candidates = playable or [item for item in sd_outputs if not _is_generic_output(item.get("label", ""))]
    merged: list[dict] = []
    for item in sorted(candidates, key=_rank_output):
        if any(item.get("hostApi") == kept.get("hostApi") and _same_output_label(item.get("label", ""), kept.get("label", "")) for kept in merged):
            continue
        merged.append(item)
    for item in win_devices:
        if item.get("kind") != "output":
            continue
        if str(item.get("status") or "").upper() not in {"", "OK"}:
            continue
        if any(_same_output_label(item.get("label", ""), kept.get("label", "")) for kept in merged):
            continue
        merged.append(item)
    return merged


def _merge_inputs(sd_inputs: list[dict], win_devices: list[dict]) -> list[dict]:
    merged: list[dict] = []
    for item in sorted(sd_inputs, key=_rank_output):
        if any(item.get("hostApi") == kept.get("hostApi") and _same_output_label(item.get("label", ""), kept.get("label", "")) for kept in merged):
            continue
        merged.append(item)
    for item in win_devices:
        if item.get("kind") != "input":
            continue
        if str(item.get("status") or "").upper() not in {"", "OK"}:
            continue
        if any(_same_output_label(item.get("label", ""), kept.get("label", "")) for kept in merged):
            continue
        merged.append(item)
    return merged


def _copy_device_payload(payload: dict, cached: bool) -> dict:
    return {**payload, "cached": cached, "devices": [dict(d) for d in payload.get("devices", [])]}


def _refresh_portaudio() -> None:
    """sounddevice/PortAudio enumerates audio devices ONCE when it first initializes; devices that
    are added, renamed, or enabled afterwards (a new Voicemeeter VAIO output, a freshly-plugged DAC,
    etc.) never appear until PortAudio is re-initialized — re-querying alone keeps returning the
    stale boot-time list. A forced device scan re-inits PortAudio so the list reflects the CURRENT
    Windows devices. The terminate invalidates open output streams, so close + drop the players
    first under the lock (which also blocks a concurrent play from opening a stream mid-reinit);
    they're lazily re-created on the next play."""
    if sd is None:
        return
    try:
        refresh_portaudio_devices()
    except Exception as exc:
        print(f"[Audioflix] PortAudio device refresh failed: {exc}", flush=True)


def list_devices(force: bool = False) -> dict:
    now = time.monotonic()
    cached_payload = _DEVICE_CACHE.get("payload")
    if not force and cached_payload and now - float(_DEVICE_CACHE.get("at") or 0.0) < _DEVICE_CACHE_TTL:
        return _copy_device_payload(cached_payload, True)

    # A forced scan means the user is (re)opening the device picker — re-enumerate the hardware so
    # newly added/renamed outputs show up and are selectable, not just the boot-time set.
    if force:
        _refresh_portaudio()

    sd_outputs = _sd_outputs()
    sd_inputs = _sd_inputs()
    win_devices = _windows_endpoint_names()
    merged_outputs = _merge_outputs(sd_outputs, win_devices)
    merged_inputs = _merge_inputs(sd_inputs, win_devices)
    merged = merged_outputs + merged_inputs
    payload = {
        "ok": True,
        "bridge": True,
        "playbackAvailable": sd is not None and np is not None,
        "spotifyModePrerequisites": spotify_mode_prerequisites(),
        "devices": merged,
        "deviceCount": len(merged),
        "scannedAt": time.time(),
        "cacheTtl": _DEVICE_CACHE_TTL,
        "message": "Native playback ready." if sd is not None and np is not None
        else "Install sounddevice to enable native playback; endpoint names are discovery-only.",
    }
    # Optional read-only presence checks: never reconfigure or refresh audio devices.
    try:
        from server_modules.audioflix_mode_capabilities import detect_mode_capabilities
        payload["modeCapabilitiesV042"] = detect_mode_capabilities()
    except Exception:
        payload["modeCapabilitiesV042"] = {"schemaVersion": 1,
            "edgeBeta": {"status": "not_checked", "detail": "Host detection unavailable."},
            "windowsAppRouting": {"status": "not_checked", "detail": "Routing dependency detection unavailable."},
            "playbackVerified": False}
    _DEVICE_CACHE["at"] = now
    _DEVICE_CACHE["payload"] = payload
    return _copy_device_payload(payload, False)
