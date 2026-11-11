"""Server-owned Piano synthesis using EveOS's existing WebAudioFont banks."""
from __future__ import annotations

import base64
import secrets
import shutil
import re
import subprocess
import threading
import urllib.request
from dataclasses import dataclass
from pathlib import Path

import numpy as np

_ROOT = Path(__file__).resolve().parents[1]
_CACHE = _ROOT / "data" / "runtime" / "audioflix-piano-native"
_FFMPEG = Path("C:/ffmpeg/bin/ffmpeg.exe")
_BANKS = {
    "fluid_studio_grand": ("0000_FluidR3_GM_sf2_file", 0.68),
    "acoustic_grand": ("0000_GeneralUserGS_sf2_file", 0.72),
    "bright_acoustic": ("0010_GeneralUserGS_sf2_file", 0.70),
    "fluid_electric_piano_1": ("0040_FluidR3_GM_sf2_file", 0.66),
    "fluid_electric_piano_2": ("0050_FluidR3_GM_sf2_file", 0.66),
    "electric_grand": ("0020_GeneralUserGS_sf2_file", 0.68),
    "honky_tonk": ("0030_GeneralUserGS_sf2_file", 0.68),
}
_BANK_URL = "https://surikov.github.io/webaudiofontdata/sound/{name}.js"
_LOCK = threading.RLock()
_ZONES: dict[str, list["Zone"]] = {}
_PCM: dict[tuple[str, int, int], np.ndarray] = {}


@dataclass(frozen=True)
class Zone:
    low: int
    high: int
    original_pitch: int
    coarse_tune: int
    fine_tune: int
    sample_rate: int
    loop_start: int
    loop_end: int
    encoded: str
    encoding: str


def _number(block: str, name: str, default: int = 0) -> int:
    match = re.search(rf"\b{re.escape(name)}\s*:\s*(-?\d+(?:\.\d+)?)", block)
    return int(float(match.group(1))) if match else default


def _zones_from_source(source: str) -> list[Zone]:
    match = re.search(r"\bzones\s*:\s*\[(.*)\]\s*[,}]", source, re.DOTALL)
    if not match:
        raise RuntimeError("Piano instrument bank did not contain zones.")
    zones = []
    for block in re.findall(r"\{(.*?)\}", match.group(1), re.DOTALL):
        audio = re.search(r"\b(file|sample)\s*:\s*['\"]([^'\"]+)['\"]", block)
        if not audio:
            continue
        zones.append(Zone(
            low=_number(block, "keyRangeLow"), high=_number(block, "keyRangeHigh", 127),
            original_pitch=_number(block, "originalPitch", 6000),
            coarse_tune=_number(block, "coarseTune"), fine_tune=_number(block, "fineTune"),
            sample_rate=_number(block, "sampleRate", 44100), loop_start=_number(block, "loopStart"),
            loop_end=_number(block, "loopEnd"), encoded=audio.group(2), encoding=audio.group(1),
        ))
    if not zones:
        raise RuntimeError("Piano instrument bank contained no playable zones.")
    return zones


def _load_zones(sound_id: str) -> tuple[list[Zone], float]:
    if sound_id == "legacy_synth":
        return [], 0.16
    bank, volume = _BANKS.get(sound_id, _BANKS["acoustic_grand"])
    with _LOCK:
        if bank in _ZONES:
            return _ZONES[bank], volume
    _CACHE.mkdir(parents=True, exist_ok=True)
    asset = _CACHE / f"{bank}.js"
    if not asset.exists():
        request = urllib.request.Request(_BANK_URL.format(name=bank), headers={"User-Agent": "EveOS-Piano/1"})
        with urllib.request.urlopen(request, timeout=20) as response:  # noqa: S310 - fixed allowlist
            data = response.read(4 * 1024 * 1024 + 1)
        if not data or len(data) > 4 * 1024 * 1024:
            raise RuntimeError("Piano instrument bank download was empty or oversized.")
        asset.write_bytes(data)
    zones = _zones_from_source(asset.read_text(encoding="utf-8", errors="strict"))
    with _LOCK:
        _ZONES[bank] = zones
    return zones, volume


def _decode_zone(sound_id: str, zone: Zone, output_rate: int) -> np.ndarray:
    key = (sound_id, hash(zone.encoded), output_rate)
    with _LOCK:
        cached = _PCM.get(key)
    if cached is not None:
        return cached
    raw = base64.b64decode(zone.encoded, validate=True)
    if zone.encoding == "sample":
        pcm = np.frombuffer(raw, dtype="<i2").astype("float32") / 32768.0
        if zone.sample_rate != output_rate:
            count = max(1, round(len(pcm) * output_rate / zone.sample_rate))
            pcm = np.interp(np.linspace(0, len(pcm) - 1, count), np.arange(len(pcm)), pcm).astype("float32")
    else:
        decoder = str(_FFMPEG) if _FFMPEG.exists() else shutil.which("ffmpeg")
        if not decoder:
            raise RuntimeError("Server-owned Piano requires the installed EveOS FFmpeg runtime.")
        result = subprocess.run([
            decoder, "-hide_banner", "-loglevel", "error", "-i", "pipe:0",
            "-f", "f32le", "-ac", "1", "-ar", str(output_rate), "pipe:1",
        ], input=raw, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=30, check=False)
        if result.returncode or not result.stdout:
            raise RuntimeError("Could not decode the selected Piano instrument bank.")
        pcm = np.frombuffer(result.stdout, dtype="<f4").copy()
    with _LOCK:
        _PCM[key] = pcm
    return pcm


def _token_midi() -> dict[str, int]:
    white, black = "1234567890qwertyuiopasdfghjklzxcvbnm", "!@$%^*(QWETYIOPSDGHJLZCVB"
    black_after, result, wi, bi = {0, 1, 3, 4, 5}, {}, 0, 0
    for octave in range(5):
        base = 36 + octave * 12
        for index, pitch in enumerate((0, 2, 4, 5, 7, 9, 11)):
            result[white[wi]], wi = base + pitch, wi + 1
            if index in black_after:
                result[black[bi]], bi = base + pitch + 1, bi + 1
    result[white[wi]] = 96
    return result


_TOKEN_MIDI = _token_midi()


def _notes(event: dict) -> list[tuple[int, float, float]]:
    spans = event.get("note_spans")
    if isinstance(spans, list) and spans:
        return [(int(span["midi"]), float(span.get("offset_ms") or 0),
                 max(2.0, float(span.get("duration_ms") or 18))) for span in spans if "midi" in span]
    midi = event.get("midi_notes")
    duration = max(2.0, float(event.get("duration_ms") or 18))
    if isinstance(midi, list) and midi:
        return [(int(note), 0.0, duration) for note in midi]
    return [(_TOKEN_MIDI[token], 0.0, duration) for token in str(event.get("key") or "") if token in _TOKEN_MIDI]


def _voice(zone: Zone, source: np.ndarray, midi: int, duration_ms: float,
           output_rate: int, peak: float) -> np.ndarray:
    duration = max(0.002, duration_ms / 1000.0)
    release, attack = 0.18, 0.008
    count = max(1, round((duration + release) * output_rate))
    base_detune = zone.original_pitch - 100 * zone.coarse_tune - zone.fine_tune
    playback_rate = 2 ** ((100 * midi - base_detune) / 1200.0)
    positions = np.arange(count, dtype="float64") * playback_rate
    loop_start = round(zone.loop_start * output_rate / max(zone.sample_rate, 1))
    loop_end = round(zone.loop_end * output_rate / max(zone.sample_rate, 1))
    if loop_end > loop_start + 1:
        beyond = positions >= loop_end
        positions[beyond] = loop_start + np.mod(positions[beyond] - loop_start, loop_end - loop_start)
    positions = np.minimum(positions, max(0, len(source) - 1))
    voice = np.interp(positions, np.arange(len(source)), source).astype("float32")
    attack_frames, release_frame = max(1, round(attack * output_rate)), max(1, round(duration * output_rate))
    envelope = np.ones(count, dtype="float32") * np.float32(peak)
    envelope[:attack_frames] *= np.linspace(0.0001, 1.0, attack_frames, dtype="float32")
    if release_frame < count:
        envelope[release_frame:] *= np.linspace(1.0, 0.0001, count - release_frame, dtype="float32")
    return voice * envelope


def render_timeline(timeline: dict, sound_id: str, volume_percent: float = 100,
                    sample_rate: int = 48000, cancel=None, progress=None) -> np.ndarray:
    events = timeline.get("events") if isinstance(timeline, dict) else None
    if not isinstance(events, list) or not events:
        raise RuntimeError("Server-owned Piano requires a complete event timeline.")
    duration_ms = max(float(timeline.get("duration_ms") or 0),
                      max(float(event.get("at_ms") or 0) + float(event.get("duration_ms") or 0) for event in events))
    if duration_ms <= 0 or duration_ms > 60 * 60 * 1000 or len(events) > 200000:
        raise RuntimeError("Piano timeline duration or event count is outside the safe limit.")
    frame_count = round((duration_ms / 1000.0 + 0.25) * sample_rate)
    # Disk-backed PCM prevents 10-60 minute songs occupying hundreds of MB of RAM.
    render_path = None
    if frame_count * 4 > 32 * 1024 * 1024:
        folder = _CACHE / "renders"
        folder.mkdir(parents=True, exist_ok=True)
        render_path = folder / ("piano-" + secrets.token_hex(12) + ".f32")
        output = np.memmap(render_path, dtype="float32", mode="w+", shape=(frame_count,))
        output[:] = 0
    else:
        output = np.zeros(frame_count, dtype="float32")
    try:
      zones, bank_volume = _load_zones(sound_id)
      master = max(0.0, min(1.0, float(volume_percent) / 100.0)) * 0.62
      for index, event in enumerate(events):
          if cancel and cancel():
              raise RuntimeError("Piano render cancelled.")
          base_ms = float(event.get("at_ms") or 0)
          for midi, offset_ms, note_ms in _notes(event):
              start = max(0, round((base_ms + offset_ms) * sample_rate / 1000.0))
              if sound_id == "legacy_synth":
                  count = max(1, round((note_ms / 1000.0 + 0.14) * sample_rate))
                  t = np.arange(count, dtype="float32") / sample_rate
                  freq = 440.0 * 2 ** ((midi - 69) / 12.0)
                  voice = (np.sin(2 * np.pi * freq * t) + 0.11 * np.sin(4.02 * np.pi * freq * t)).astype("float32")
                  voice *= np.linspace(1.0, 0.0001, count, dtype="float32") * bank_volume
              else:
                  zone = next((item for item in zones if item.low <= midi <= item.high), None)
                  if zone is None:
                      continue
                  voice = _voice(zone, _decode_zone(sound_id, zone, sample_rate), midi, note_ms, sample_rate, bank_volume)
              end = min(len(output), start + len(voice))
              if end > start:
                  output[start:end] += voice[:end - start] * master
          if progress and (index % 64 == 0 or index + 1 == len(events)):
              progress(index + 1, len(events))
      # Bounded final pass: avoid allocating another whole-song output array.
      for offset in range(0, frame_count, 262144):
          if cancel and cancel():
              raise RuntimeError("Piano render cancelled.")
          portion = output[offset:offset + 262144]
          output[offset:offset + len(portion)] = np.tanh(portion * np.float32(1.35))
      if isinstance(output, np.memmap):
          output.flush()
      return output
    except BaseException:
      if render_path is not None:
          try:
              del output
              render_path.unlink(missing_ok=True)
          except OSError:
              pass
      raise
