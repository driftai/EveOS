import json
import sys
import tempfile
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules import audioflix_spotify as spotify
from server_modules import audioflix_spotify_browser as browser


PLAYLIST = "https://open.spotify.com/playlist/37i9dQZF1DX4WYpdgoIcn6"


class RunningProcess:
    def poll(self):
        return None


def fake_launch(command, **_kwargs):
    Path(command[-1]).write_text(
        json.dumps({"ok": True, "pid": 12345, "openedAt": 1}),
        encoding="utf-8",
    )
    return RunningProcess()


with tempfile.TemporaryDirectory() as temp:
    profile = Path(temp) / "spotify-browser-profile"
    profile.mkdir()
    spotify._session_process = None
    with mock.patch.object(spotify, "_profile_dir", return_value=profile), \
            mock.patch.object(spotify.subprocess, "Popen", side_effect=fake_launch):
        result = spotify.open_session(PLAYLIST)

assert result["ok"] is True
assert result["sessionReady"] is True
assert "saved Spotify Engine browser" in result["message"]

with tempfile.TemporaryDirectory() as temp, mock.patch.dict(spotify.os.environ, {
        "LOCALAPPDATA": temp, "EVEOS_SPOTIFY_PROFILE": ""}):
    root = Path(temp)
    with mock.patch.object(Path, "home", return_value=root):
        legacy = root / "Downloads" / "drift-spotify-embed-scraper-v2" / ".spotify-browser-profile"
        legacy.mkdir(parents=True)
        (legacy / "test-sentinel").touch()
        expected = root / "EveOS" / "spotify-browser-edge-beta-profile"
        assert spotify._profile_dir() == browser._profile_dir() == expected
        assert not (expected / "test-sentinel").exists()
        for mode in ("login", "scrape"):
            command = spotify._helper_command(mode, spotify.normalize_playlist_input(PLAYLIST))
            assert command[4] == str(expected)

print("AUDIOFLIX_SPOTIFY_SESSION_SMOKE_OK")
