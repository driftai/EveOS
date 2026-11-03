"""Focused fail-closed contract for the Electron Direct Embed server owner."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from server_modules.audioflix_spotify_direct import SpotifyDirectManager


manager = SpotifyDirectManager()
status = manager.status()
assert status["ok"] is True and status["running"] is False
assert "electronAvailable" in status and "hostExists" in status
rejected = manager.command({"action": "play", "payload": {
    "deviceId": "default", "spotifyUri": "spotify:track:4cOdK2wGLETKBW3PvgPWqT"
}}, 8765)
assert rejected["ok"] is False and "sd:*" in rejected["reason"]
assert manager.status()["running"] is False
assert manager.shutdown()["ok"] is True
print("audioflix Spotify Direct Embed manager smoke passed")
