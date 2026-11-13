"""audioflix_localize_endpoint_smoke.py

Server-side localization module (server_modules/audioflix_localize.py) pure-logic checks — no
network, no yt-dlp, no ffmpeg needed:
  1. safe_filename strips path-hostile characters and bounds length.
  2. _is_http guards non-URL sources.
  3. scan_dir lists only audio files in a folder (for the reimport music port).
  4. localize_one fails cleanly (no crash) on a non-online url and on a missing target folder.
  5. The bridge POST router exposes the /api/audioflix/localize + /localize-scan routes.
"""
import os
import sys
import tempfile

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server_modules import audioflix_localize as L
from server_modules import audioflix_spotify as SPOTIFY


def check(cond, msg):
    if not cond:
        raise SystemExit("ASSERT FAILED: " + msg)


# 1. safe_filename
check(L.safe_filename('AC/DC: Back "Home" *?') == 'ACDC Back Home', "safe_filename strips invalid chars")
check(L.safe_filename('') == 'track', "safe_filename falls back")
check(len(L.safe_filename('x' * 400)) <= 120, "safe_filename bounds length")

# 2. _is_http
check(L._is_http('https://youtube.com/x') and L._is_http('http://a/b'), "_is_http accepts http(s)")
check(not L._is_http('C:/music/song.mp3') and not L._is_http(''), "_is_http rejects local paths")

# 3. scan_dir
tmp = tempfile.mkdtemp(prefix="eveos_localize_")
open(os.path.join(tmp, "Night Drive.mp3"), "w").close()
open(os.path.join(tmp, "Focus.m4a"), "w").close()
open(os.path.join(tmp, "notes.txt"), "w").close()
scan = L.scan_dir({"dir": tmp})
check(scan.get("ok") and scan.get("count") == 2, "scan_dir lists the two audio files only")
names = sorted(f["name"] for f in scan["files"])
check(names == ["Focus", "Night Drive"], "scan_dir returns extension-less names: %r" % names)
check(all(os.path.isabs(f["path"]) for f in scan["files"]), "scan_dir returns absolute paths")

miss = L.scan_dir({"dir": os.path.join(tmp, "nope")})
check(not miss.get("ok"), "scan_dir reports a missing folder")

# 4. localize_one guards (no network hit on either path)
r_local = L.localize_one({"track": {"id": "x", "title": "T", "url": "C:/song.mp3"}, "targetDir": tmp})
check(not r_local.get("ok") and "online" in (r_local.get("error") or "").lower(), "localize_one rejects a non-online url")
r_nodir = L.localize_one({"track": {"id": "y", "title": "T", "url": "https://example.com/x"}, "targetDir": ""})
check(not r_nodir.get("ok"), "localize_one rejects a missing target folder before any download")
r_spotify = L.localize_one({
    "track": {
        "id": "spotify",
        "title": "Owned Spotify Match",
        "url": "https://open.spotify.com/track/spotifyTrack123",
        "sourceProvider": "spotify",
    },
    "targetDir": tmp,
})
check(
    not r_spotify.get("ok") and "spotify" in (r_spotify.get("error") or "").lower(),
    "localize_one never downloads Spotify audio",
)

# 5. Spotify accepts public, embed, and iframe playlist sources without storing HTML noise.
spotify_id = "37i9dQZF1DX4WYpdgoIcn6"
for source in (
    f"https://open.spotify.com/playlist/{spotify_id}?si=test",
    f"https://open.spotify.com/embed/playlist/{spotify_id}",
    f'<iframe src="https://open.spotify.com/embed/playlist/{spotify_id}?utm_source=generator"></iframe>',
):
    normalized = SPOTIFY.normalize_playlist_input(source)
    check(normalized.get("ok") and normalized.get("playlistId") == spotify_id, "Spotify source did not normalize")
    # Share parameters are intentionally preserved (private-share pt= is an access capability).
    check(str(normalized.get("url") or "").split("?", 1)[0] == f"https://open.spotify.com/playlist/{spotify_id}",
          "Spotify public URL was not canonical")
shared = SPOTIFY.normalize_playlist_input(f"https://open.spotify.com/playlist/{spotify_id}?pt=cap123")
check(shared.get("url") == f"https://open.spotify.com/playlist/{spotify_id}?pt=cap123",
      "Spotify private-share pt= capability was dropped")
check(not SPOTIFY.normalize_playlist_input("https://example.com/list").get("ok"), "non-Spotify sources must be rejected")

# 6. bridge route wiring
from server_modules import audioflix_bridge as B
check(callable(getattr(B, "localize_track", None)), "bridge exposes localize_track")
check(callable(getattr(B, "localize_scan", None)), "bridge exposes localize_scan")
src = open(os.path.join(ROOT, "server_modules", "audioflix_bridge.py"), encoding="utf-8").read()
check("/api/audioflix/localize" in src and "/api/audioflix/localize-scan" in src, "bridge POST map registers both routes")
check("/api/audioflix/spotify-playlist" in src and "/api/audioflix/spotify-session" in src, "bridge registers Spotify routes")
spotify_scraper = open(
    os.path.join(ROOT, "server_modules", "audioflix_spotify_scrape.js"),
    encoding="utf-8",
).read()
check("[data-testid^='tracklist-row']" in spotify_scraper, "Spotify indexed rows use a prefix selector")
# The DOM/metadata join moved to audioflix_spotify_scrape_core.mergePlaylistRows; exercise it directly.
import json as _json
import subprocess as _subprocess
_join = _subprocess.run(["node", "-e", (
    "const {mergePlaylistRows}=require(process.argv[1]);"
    "const out=mergePlaylistRows([{title:'Purpose Is Glorious'}],"
    "[{id:'4cOdK2wGLETKBW3PvgPWqT',title:'Purpose is glorious!',artists:['Natalie Holt'],durationMs:188000}]);"
    "console.log(JSON.stringify(out));"
), os.path.join(ROOT, "server_modules", "audioflix_spotify_scrape_core.js")], capture_output=True, text=True, timeout=30)
_joined = _json.loads(_join.stdout or "[]") if _join.returncode == 0 else []
check(len(_joined) == 1 and _joined[0].get("artist") == "Natalie Holt" and _joined[0].get("duration") == 188,
      "Spotify DOM rows join saved JSON metadata")

print("AUDIOFLIX_LOCALIZE_ENDPOINT_SMOKE_OK")
