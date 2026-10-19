#!/usr/bin/env python3
"""Hash-locked TLO preservation contract: permitted dirty != editable."""
from __future__ import annotations

import tempfile
from pathlib import Path
from unittest.mock import patch

import tlo_preserved_files as preserved


def run() -> None:
    with tempfile.TemporaryDirectory(prefix="eve-tlo-preserved-") as directory:
        root = Path(directory)
        source = root / "docs" / "WIP.md"
        source.parent.mkdir(parents=True)
        source.write_bytes(b"original WIP document\n")
        with patch.object(preserved, "ROOT", root):
            expected = preserved.capture(["docs/WIP.md"], {"tools/test.py"})
            preserved.verify(expected)
            assert len(expected["docs/WIP.md"]) == 64
            try:
                preserved.capture(["docs/WIP.md"], {"docs/WIP.md"})
                raise AssertionError("Protected/repair file overlap was accepted")
            except RuntimeError:
                pass
            try:
                preserved.capture(["../escape.md"], set())
                raise AssertionError("Path traversal was accepted")
            except RuntimeError:
                pass
            source.write_bytes(b"unauthorized change\n")
            try:
                preserved.verify(expected)
                raise AssertionError("Modified WIP passed preservation check")
            except RuntimeError:
                pass
    print("TLO_PRESERVED_DIRTY_FILE_CONTRACT_OK")


if __name__ == "__main__":
    run()
