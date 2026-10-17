#!/usr/bin/env python3
"""Deterministic text hygiene for bounded EveOS engineering candidates."""

from __future__ import annotations

import argparse
import codecs
import sys
from pathlib import Path


def normalize_terminal_newline(path: Path) -> bool:
    raw = path.read_bytes()

    bom = raw.startswith(codecs.BOM_UTF8)

    payload = (
        raw[len(codecs.BOM_UTF8):]
        if bom
        else raw
    )

    # Preserve the file's currently observed newline convention.
    crlf = b"\r\n" in payload

    text = (
        payload.decode("utf-8")
        .replace("\r\n", "\n")
        .replace("\r", "\n")
    )

    if not text:
        return False

    # Only terminal NEWLINES are normalized.
    # Content and trailing spaces on content lines are untouched.
    normalized = text.rstrip("\n") + "\n"

    if crlf:
        normalized = normalized.replace(
            "\n",
            "\r\n",
        )

    encoded = normalized.encode("utf-8")

    if bom:
        encoded = codecs.BOM_UTF8 + encoded

    if encoded == raw:
        return False

    path.write_bytes(encoded)
    return True


def normalize_paths(paths: list[Path]) -> list[str]:
    changed = []

    for path in paths:
        if not path.is_file():
            continue

        if normalize_terminal_newline(path):
            changed.append(path.as_posix())

    return changed


def main() -> int:
    parser = argparse.ArgumentParser()

    parser.add_argument(
        "--check",
        action="store_true",
    )

    parser.add_argument(
        "paths",
        nargs="+",
    )

    args = parser.parse_args()

    candidates = [
        Path(value)
        for value in args.paths
    ]

    if args.check:
        dirty = []

        for path in candidates:
            if not path.is_file():
                continue

            original = path.read_bytes()

            try:
                changed = normalize_terminal_newline(
                    path
                )

                if changed:
                    dirty.append(
                        path.as_posix()
                    )
            finally:
                path.write_bytes(original)

        if dirty:
            print(
                "TEXT_HYGIENE_RED "
                + " ".join(dirty)
            )
            return 1

        print("TEXT_HYGIENE_GREEN")
        return 0

    changed = normalize_paths(candidates)

    if changed:
        print(
            "TEXT_HYGIENE_NORMALIZED "
            + " ".join(changed)
        )
    else:
        print(
            "TEXT_HYGIENE_ALREADY_CLEAN"
        )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
