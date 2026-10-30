from pathlib import Path

import pytest

from app.library import SongLibrary


def test_playback_overrides_round_trip_without_losing_custom_metadata(tmp_path: Path):
    library = SongLibrary(tmp_path / "songs.json")
    saved = library.save({
        "id": "settings-song",
        "title": "Settings Song",
        "sheet": "a b c",
        "identifiers": {"custom": {
            "favorite": "true",
            "piano_folder": "Practice",
            "piano_playback_v1": {
                "route": "internal",
                "targetHint": None,
                "layout": "88",
                "instrumentId": "acoustic_grand",
                "internalVolumePercent": 0,
            },
        }},
    })

    custom = saved["identifiers"]["custom"]
    assert custom["favorite"] == "true"
    assert custom["piano_folder"] == "Practice"
    assert custom["piano_playback_v1"] == {
        "route": "internal",
        "targetHint": None,
        "layout": "88",
        "instrumentId": "acoustic_grand",
        "internalVolumePercent": 0,
    }
    assert library.get("settings-song")["identifiers"]["custom"] == custom


@pytest.mark.parametrize("settings", [
    {"route": "unknown"},
    {"route": "internal", "layout": "76"},
    {"route": "internal", "internalVolumePercent": -1},
    {"route": "internal", "internalVolumePercent": 101},
    {"route": "internal", "internalVolumePercent": 50.5},
])
def test_invalid_playback_overrides_fail_without_mutating_library(tmp_path: Path, settings):
    library = SongLibrary(tmp_path / "songs.json")
    library.save({"id": "safe", "title": "Safe", "sheet": "a"})
    before = (tmp_path / "songs.json").read_bytes()

    with pytest.raises(ValueError):
        library.update_identifiers("safe", {"custom": {"piano_playback_v1": settings}})

    assert (tmp_path / "songs.json").read_bytes() == before


def test_legacy_song_without_overrides_stays_readable(tmp_path: Path):
    path = tmp_path / "songs.json"
    path.write_text('{"songs":[{"id":"legacy","title":"Legacy","sheet":"a"}]}', encoding="utf-8")
    song = SongLibrary(path).get("legacy")
    assert song["id"] == "legacy"
    assert song["identifiers"]["custom"] == {}
