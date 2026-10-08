"""Offline manager contract smoke: no browser launch, no Spotify network access."""

from __future__ import annotations

import importlib.util
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
MODULE = ROOT / "server_modules" / "audioflix_spotify_browser.py"
spec = importlib.util.spec_from_file_location("audioflix_spotify_browser_under_test", MODULE)
mod = importlib.util.module_from_spec(spec)
assert spec and spec.loader
sys.modules[spec.name] = mod
spec.loader.exec_module(mod)

assert mod.validate_loopback_page_url("http://127.0.0.1:8765/EveOS.html")
assert mod.validate_loopback_page_url("https://localhost:8765/EveOS.html")
assert not mod.validate_loopback_page_url("https://example.com/EveOS.html")
assert mod.clamp_volume(2) == 1
assert mod.clamp_volume(-2) == 0
assert mod.normalize_track_id("spotify:track:4cOdK2wGLETKBW3PvgPWqT") == "4cOdK2wGLETKBW3PvgPWqT"
assert mod.normalize_track_id("bad") == ""

manager = mod.SpotifyBrowserManager()
manager.environment_status = lambda force=False: {
    "nodeAvailable": True,
    "nodePath": "node",
    "playwrightAvailable": True,
    "playwrightVersion": "test",
    "helperExists": True,
    "profilePath": "C:/local/profile",
    "profileExists": True,
    "profileHasState": True,
}
manager._session_id = "expected-session"
manager._port = 31337
manager._token = "this-token-must-never-be-public"
manager._process = type("P", (), {"poll": lambda self: None})()
manager._helper_status = lambda: {
    "ok": True,
    "sessionId": "expected-session",
    "state": "controlling",
    "pageUrl": "http://127.0.0.1:8765/EveOS.html",
    "pageAttached": True,
    "spotifyFrameCount": 1,
    "mediaCount": 1,
    "playingCount": 1,
    "desiredVolume": 0.25,
    "authState": "signed-in",
    "browserChannel": "msedge",
    "lastAppliedAt": 123,
    "lastError": "",
}
public = manager.status()
assert public["helperReachable"] is True
assert public["authState"] == "signed-in"
assert public["playingCount"] == 1
assert "token" not in " ".join(public.keys()).lower()
assert "this-token-must-never-be-public" not in repr(public)

captured = {}
def fake_request(method, route, body=None, timeout=0):
    captured.update({"method": method, "route": route, "body": body, "timeout": timeout})
    return {"ok": True, "sessionMatch": True, "volume": body["volume"], "lastAppliedAt": 999}
manager._request = fake_request
result = manager.set_volume({
    "sessionId": "expected-session",
    "volume": 0.25,
    "trackId": "https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT",
})
assert result["ok"] and result["sessionMatch"]
assert captured["route"] == "/volume"
assert captured["body"]["trackId"] == "4cOdK2wGLETKBW3PvgPWqT"
assert captured["body"]["volume"] == 0.25

rejected = manager.set_volume({"sessionId": "wrong-session", "volume": 0.5})
assert rejected["ok"] is False and rejected["sessionMatch"] is False

# Profile-task coordination must release a running managed context exactly once and restore it only
# after the final nested task exits. This is how the existing >100-track importer shares one login.
coordinator = mod.SpotifyBrowserManager()
coordinator._process = type("P", (), {"poll": lambda self: None})()
coordinator._session_id = "profile-session"
coordinator._page_url = "http://127.0.0.1:8765/EveOS.html"
coordinator._helper_status = lambda: {
    "ok": True, "sessionId": "profile-session", "pageUrl": coordinator._page_url
}
stops = []
starts = []
def fake_stop(force=False):
    stops.append(force)
    coordinator._process = None
    return {"ok": True, "state": "stopped"}
def fake_start(payload=None):
    starts.append(dict(payload or {}))
    return {"ok": True, "helperReachable": True}
coordinator._stop_locked = fake_stop
coordinator.start = fake_start
first_ticket = coordinator.suspend_for_profile_task("playlist-import")
second_ticket = coordinator.suspend_for_profile_task("playlist-import-nested")
assert first_ticket["ok"] and first_ticket["shouldResume"] is True
assert second_ticket["ok"] and second_ticket["nested"] is True
assert len(stops) == 1
first_resume = coordinator.resume_after_profile_task(second_ticket)
assert first_resume["resumed"] is False and first_resume["nested"] is True
final_resume = coordinator.resume_after_profile_task(first_ticket)
assert final_resume["ok"] and final_resume["resumed"] is True
assert starts == [{"pageUrl": "http://127.0.0.1:8765/EveOS.html"}]

print("AUDIOFLIX_SPOTIFY_BROWSER_PYTHON_SMOKE_OK")
