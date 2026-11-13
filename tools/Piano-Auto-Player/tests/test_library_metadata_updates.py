from __future__ import annotations

from app.library import SongLibrary


def test_metadata_update_preserves_song_payload_and_replaces_custom_identifiers(tmp_path) -> None:
    library = SongLibrary(tmp_path / "songs.json")
    original = library.save({
        "id": "song-1",
        "title": "Original title",
        "artist": "Original artist",
        "sheet": "a b c",
        "performance": [],
        "source": "manual",
        "identifiers": {
            "genre": ["test"],
            "tags": ["keep-payload"],
            "author": "Original artist",
            "personal_rating": 2.0,
            "custom": {"keep": "old", "remove": "me"},
        },
    })

    updated = library.update_identifiers("song-1", {
        "genre": ["updated"],
        "tags": ["metadata-only"],
        "author": "Metadata author",
        "personal_rating": 4.5,
        "custom": {"keep": "new"},
    })

    assert updated is not None
    assert updated["title"] == original["title"]
    assert updated["artist"] == original["artist"]
    assert updated["sheet"] == original["sheet"]
    assert updated["performance"] == original["performance"]
    assert updated["source"] == original["source"]
    assert updated["identifiers"]["personal_rating"] == 4.5
    assert updated["identifiers"]["custom"] == {"keep": "new"}


def test_explicit_empty_custom_identifiers_delete_all_existing_keys(tmp_path) -> None:
    library = SongLibrary(tmp_path / "songs.json")
    library.save({
        "id": "song-2",
        "title": "Delete custom keys",
        "sheet": "a",
        "identifiers": {"custom": {"era": "2020s", "energy": "high"}},
    })

    updated = library.update_identifiers("song-2", {"custom": {}})

    assert updated is not None
    assert updated["sheet"] == "a"
    assert updated["identifiers"]["custom"] == {}


def test_piano_collection_metadata_round_trips_without_string_truncation(tmp_path) -> None:
    library = SongLibrary(tmp_path / "songs.json")
    keep_ids = [f"duplicate-{index:02d}-" + "x" * 120 for index in range(20)]
    library.save({
        "id": "song-collections", "title": "Collections", "sheet": "a",
        "identifiers": {"custom": {
            "piano_folders_v1": ["Study", "Favorites"],
            "piano_groups_v1": ["Anime", "Practice"],
            "piano_duplicate_keep_v1": keep_ids,
        }},
    })

    song = library.get("song-collections")

    assert song is not None
    assert song["identifiers"]["custom"]["piano_folders_v1"] == ["Study", "Favorites"]
    assert song["identifiers"]["custom"]["piano_groups_v1"] == ["Anime", "Practice"]
    assert song["identifiers"]["custom"]["piano_duplicate_keep_v1"] == keep_ids


def test_legacy_serialized_memberships_are_recovered_without_literal_brackets(tmp_path) -> None:
    library = SongLibrary(tmp_path / "songs.json")
    library.save({"id": "legacy", "title": "Legacy", "sheet": "a", "identifiers": {
        "genre": "['Anime OST']", "tags": '["calm", "piano"]', "custom": {
            "piano_folders_v1": "[\"Study\", \"Favorites\"]", "piano_groups_v1": "['Test']"}}})
    song = library.get("legacy")
    assert song["identifiers"]["genre"] == ["Anime OST"]
    assert song["identifiers"]["tags"] == ["calm", "piano"]
    assert song["identifiers"]["custom"]["piano_folders_v1"] == ["Study", "Favorites"]
    assert song["identifiers"]["custom"]["piano_groups_v1"] == ["Test"]
