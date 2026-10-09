"""Offline manager contract smoke: no browser launch, no Spotify network access."""

from __future__ import annotations

import importlib.util
import pathlib
import sys
import tempfile

ROOT = pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))
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

# Wrapper and JS helper share one deterministic startup budget. Never regress to an outer timeout
# that can kill a still-valid Edge -> Chromium fallback -> navigation sequence.
contract = mod._STARTUP_CONTRACT
expected_start_ms = sum(contract.values())
assert int(mod._START_TIMEOUT_S * 1000) == expected_start_ms
assert expected_start_ms >= (
    contract["edgeLaunchTimeoutMs"]
    + contract["chromiumLaunchTimeoutMs"]
    + contract["navigationTimeoutMs"]
)
assert contract["outerGraceMs"] >= 5000
helper_source = (ROOT / "server_modules" / "audioflix_spotify_browser.js").read_text(encoding="utf-8")
startup_source = (ROOT / "server_modules" / "audioflix_spotify_browser_startup.js").read_text(encoding="utf-8")
assert "audioflix_spotify_browser_startup.json" in startup_source
assert "timeout: EDGE_LAUNCH_TIMEOUT_MS" in startup_source
assert "timeout: CHROMIUM_LAUNCH_TIMEOUT_MS" in startup_source
assert "timeout: NAVIGATION_TIMEOUT_MS" in startup_source
assert "startup-phase" in startup_source and "launchManagedContext" in helper_source
assert "console.log" in helper_source

# Startup failure reporting must surface the useful error rather than the final `at async ...`
# stack frame or a transient socket timeout.
with tempfile.TemporaryDirectory() as tmp:
    log_path = pathlib.Path(tmp) / "startup.log"
    log_path.write_text(
        "[eveos-audioflix-spotify-browser] 2026-10-09T00:00:00.000Z startup-phase: launch-edge\n"
        "[eveos-audioflix-spotify-browser] Error: browserType.launchPersistentContext: profile busy\n"
        "    at async main (audioflix_spotify_browser.js:170:19)\n",
        encoding="utf-8",
    )
    reason = mod._startup_log_reason(log_path, "fallback")
    assert "browserType.launchPersistentContext" in reason
    assert not reason.lstrip().startswith("at ")
    # The log is appended across runs: a stale error from an earlier launch must not be blamed.
    offset = log_path.stat().st_size
    with log_path.open("a", encoding="utf-8") as handle:
        handle.write("[eveos-audioflix-spotify-browser] startup-phase: navigate\n")
    reason = mod._startup_log_reason(log_path, "fallback", offset)
    assert "profile busy" not in reason and "navigate" in reason, reason

# A recovered helper must clear an earlier refused-connection diagnostic instead of leaving status red.
health = mod.SpotifyBrowserManager()
health._process = type("P", (), {"poll": lambda self: None})()
health._port = 31337
health._token = "health-token"
health._last_error = "stale connection refused"
health._request = lambda method, route, body=None, timeout=0: {"ok": True, "state": "ready"}
assert health._helper_status()["ok"] is True
assert health._last_error == ""

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
    "phase": "ready",
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
    "importing": False,
}
public = manager.status()
assert public["helperReachable"] is True
assert public["authState"] == "signed-in"
assert public["playingCount"] == 1
assert public["phase"] == "ready"
assert public["startupBudgetMs"] == expected_start_ms
assert public["sessionPresent"] is True
assert public["importing"] is False
assert "sessionId" not in public
assert "expected-session" not in repr(public)
assert "token" not in " ".join(public.keys()).lower()
assert "this-token-must-never-be-public" not in repr(public)

matched = manager.session_status({"sessionId": "expected-session"})
assert matched["sessionMatch"] is True
assert "sessionId" not in matched and "expected-session" not in repr(matched)
wrong = manager.session_status({"sessionId": "wrong-session"})
assert wrong["sessionMatch"] is False
assert "sessionId" not in wrong

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
assert captured["body"]["sessionId"] == "expected-session"

rejected = manager.set_volume({"sessionId": "wrong-session", "volume": 0.5})
assert rejected["ok"] is False and rejected["sessionMatch"] is False

qualified = manager.qualify_volume({"volume": 0.4})
assert qualified["ok"] and qualified["sessionMatch"]
assert captured["route"] == "/volume"
assert captured["body"]["sessionId"] == "expected-session"
assert captured["body"]["volume"] == 0.4

# A large/private playlist import must be forwarded into the already-running helper without
# stopping the managed process or dropping the pt= share capability URL.
private_share = (
    "https://open.spotify.com/playlist/1fY2i6tthQptx5Z3nn1g17"
    "?si=a60e8f62ad464b26&pt=48ecfbe39b719caf600d2c23196f587e"
)
playlist_capture = {}
def fake_playlist_request(method, route, body=None, timeout=0):
    playlist_capture.update({"method": method, "route": route, "body": body, "timeout": timeout})
    return {"ok": True, "count": 163, "expectedCount": 163, "scrapeSource": "managed-session"}
manager._request = fake_playlist_request
process_before = manager._process
playlist = manager.list_playlist({"url": private_share})
assert playlist["ok"] and playlist["count"] == 163
assert playlist_capture["method"] == "POST" and playlist_capture["route"] == "/playlist"
assert playlist_capture["body"]["url"] == private_share
assert playlist_capture["timeout"] >= 90
assert manager._process is process_before, "playlist import must not stop the managed browser process"

print("AUDIOFLIX_SPOTIFY_BROWSER_PYTHON_SMOKE_OK")
