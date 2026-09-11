from __future__ import annotations

from app.library import SongLibrary


def test_identifier_only_save_preserves_song_payload(tmp_path) -> None:
    library = SongLibrary(tmp_path / "songs.json")
    original = library.save({
        "id": "song-1",
        "title": "Original",
        "sheet": "abc",
        "performance": [{"at_ms": 0, "duration_ms": 50, "key": "a"}],
        "source": "manual",
    })

    updated = library.save({
        "id": original["id"],
        "identifiers": {"tags": ["favorite"], "custom": {"energy": "high"}},
    })

    assert updated["sheet"] == original["sheet"]
    assert updated["performance"] == original["performance"]
    assert updated["source"] == original["source"]
    assert updated["identifiers"]["tags"] == ["favorite"]


def test_custom_identifier_patch_replaces_removed_keys(tmp_path) -> None:
    library = SongLibrary(tmp_path / "songs.json")
    saved = library.save({
        "id": "song-2",
        "title": "Custom metadata",
        "sheet": "abc",
        "identifiers": {"custom": {"energy": "high", "era": "2020s"}},
    })

    updated = library.save({
        "id": saved["id"],
        "identifiers": {"custom": {"era": "2020s"}},
    })

    assert updated["identifiers"]["custom"] == {"era": "2020s"}
