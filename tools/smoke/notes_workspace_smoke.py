"""Focused real-file round-trip for EveOS Notepad files and Spatial Notes."""

from __future__ import annotations

import tempfile
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import notes_workspace as notes


def run() -> None:
    with tempfile.TemporaryDirectory(prefix="eveos-notes-smoke-") as temporary:
        root = Path(temporary)
        runtime = root / "runtime.json"
        spatial = root / "spatial"
        external = root / "prompts"
        external.mkdir()
        (external / "prompt.txt").write_text("first draft", encoding="utf-8")
        (external / "optional.md").write_text("# Markdown", encoding="utf-8")
        (external / "ignored.json").write_text("{}", encoding="utf-8")

        original_state_path = notes._state_path
        original_spatial_root = notes._spatial_root
        try:
            notes._state_path = lambda: runtime
            notes._spatial_root = lambda: spatial.resolve()
            spatial.mkdir()

            tracked = notes.track(str(external))["root"]
            txt_only = notes.list_entries(tracked["id"], "", False)["entries"]
            assert [entry["name"] for entry in txt_only] == ["prompt.txt"]
            with_markdown = notes.list_entries(tracked["id"], "", True)["entries"]
            assert {entry["name"] for entry in with_markdown} == {"prompt.txt", "optional.md"}

            opened = notes.read_note(tracked["id"], "prompt.txt")
            assert opened["content"] == "first draft"
            saved, status = notes.write_note(
                tracked["id"], "prompt.txt", "second draft", opened["entry"]["revision"]
            )
            assert status == 200 and saved["ok"]
            conflict, status = notes.write_note(
                tracked["id"], "prompt.txt", "stale draft", opened["entry"]["revision"]
            )
            assert status == 409 and conflict["conflict"]

            notes.create_entry("spatial", "", "Ideas", "folder")
            notes.create_entry("spatial", "Ideas", "launch.md", "file")
            spatial_note = notes.read_note("spatial", "Ideas/launch.md")
            notes.write_note("spatial", "Ideas/launch.md", "linked thought", spatial_note["entry"]["revision"])
            favorite = notes.toggle_favorite("spatial", "Ideas/launch.md")
            assert favorite["favorite"] is True
            linked = notes.link_notes(
                "spatial:Ideas/launch.md", f"{tracked['id']}:prompt.txt"
            )
            assert linked["links"] == [f"{tracked['id']}:prompt.txt"]

            backup = notes.export_spatial()
            (spatial / "Ideas" / "launch.md").unlink()
            imported = notes.import_spatial(backup["base64"])
            assert imported["imported"] == 1
            assert (spatial / "Ideas" / "launch.md").read_text(encoding="utf-8") == "linked thought"

            removed = notes.untrack(tracked["id"])
            assert removed["ok"] and (external / "prompt.txt").is_file()
        finally:
            notes._state_path = original_state_path
            notes._spatial_root = original_spatial_root


if __name__ == "__main__":
    run()
    print("NOTES_WORKSPACE_SMOKE_OK")
