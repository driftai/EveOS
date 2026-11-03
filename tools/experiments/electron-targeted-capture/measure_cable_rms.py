"""Experiment E physical check: RMS of what actually arrives on CABLE Output.

Reads N seconds from the input device whose name contains --match (default "CABLE Output"),
computes RMS dBFS and the 440 Hz / 880 Hz band levels in memory, and prints one JSON line.
Nothing is written to disk. Run once per gain step (100/50/0) with every other CABLE source silent.
Expected: 50% is about -6 dB versus 100%; 0% is at the noise floor.
"""
import argparse
import json
import sys

import numpy as np
import sounddevice as sd


def band_db(x: np.ndarray, rate: int, hz: float) -> float:
    spectrum = np.abs(np.fft.rfft(x * np.hanning(len(x)))) / len(x)
    freqs = np.fft.rfftfreq(len(x), 1 / rate)
    band = spectrum[(freqs > hz - 10) & (freqs < hz + 10)]
    peak = float(band.max()) if band.size else 0.0
    return round(20 * np.log10(peak), 1) if peak > 0 else float("-inf")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--match", default="CABLE Output")
    ap.add_argument("--seconds", type=float, default=5.0)
    ap.add_argument("--rate", type=int, default=48000)
    ap.add_argument("--label", default="")
    args = ap.parse_args()
    devices = [(i, d) for i, d in enumerate(sd.query_devices()) if args.match.lower() in d["name"].lower() and d["max_input_channels"] > 0]
    if not devices:
        print(json.dumps({"ok": False, "reason": f"no input device matching {args.match!r}"}))
        return 2
    index, device = devices[0]
    frames = sd.rec(int(args.seconds * args.rate), samplerate=args.rate, channels=1, device=index, dtype="float32")
    sd.wait()
    x = frames[:, 0]
    rms = float(np.sqrt(np.mean(np.square(x)))) if x.size else 0.0
    print(json.dumps({
        "ok": True, "label": args.label, "device": f"{index}: {device['name']}", "seconds": args.seconds,
        "rmsDbfs": round(20 * np.log10(rms), 2) if rms > 0 else float("-inf"),
        "peak": round(float(np.max(np.abs(x))), 4) if x.size else 0.0,
        "band440Db": band_db(x, args.rate, 440.0), "band880Db": band_db(x, args.rate, 880.0),
    }))
    return 0


if __name__ == "__main__":
    sys.exit(main())
