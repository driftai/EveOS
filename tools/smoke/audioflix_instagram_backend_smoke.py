"""Offline contracts for Instagram collection metadata, direct video, and MP4 localization."""

import json
import os
import sys
import tempfile
from pathlib import Path

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if ROOT not in sys.path:
    sys.path.insert(0, ROOT)

from server_modules import audioflix_instagram as INSTAGRAM
from server_modules import audioflix_instagram_browser as INSTAGRAM_BROWSER
from server_modules import audioflix_instagram_metadata as INSTAGRAM_METADATA
from server_modules import audioflix_instagram_public as INSTAGRAM_PUBLIC
from server_modules import audioflix_instagram_public_proxy as INSTAGRAM_PUBLIC_PROXY
from server_modules import audioflix_localize as LOCALIZE
from server_modules import audioflix_ytdl as YTDL

INSTAGRAM_METADATA.resolve_metadata = lambda *args, **kwargs: {"ok": False}


def check(condition, message):
    if not condition:
        raise SystemExit("ASSERT FAILED: " + message)


music_fixture = (
    '<script type="application/json">'
    '{"clips_music_attribution_info": {'
    '"artist_name": "Example Artist", '
    '"song_name": "Example Song", '
    '"audio_id": "123456789", '
    '"uses_original_sound": false'
    '}}</script>'
)
music = INSTAGRAM_PUBLIC_PROXY._music_metadata_from_page(music_fixture)
check(music.get("musicTitle") == "Example Song", "public Reel music title is parsed")
check(music.get("musicArtist") == "Example Artist", "public Reel music artist is parsed")
check(music.get("musicId") == "123456789", "public Reel audio id is parsed")
check(music.get("musicIsOriginal") is False, "catalog-vs-original music attribution is preserved")


urls = INSTAGRAM.parse_urls(
    "https://instagram.com/reels/Alias_1/?x=1\n"
    "https://www.instagram.com/reel/Alias_1/\n"
    "https://instagram.com/p/Post-2/?utm_source=test"
)
check(urls == [
    "https://www.instagram.com/reel/Alias_1/",
    "https://www.instagram.com/p/Post-2/",
], "Instagram aliases canonicalize and deduplicate")


class FakeYoutubeDL:
    def __init__(self, options):
        self.options = options

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def extract_info(self, url, download=False):
        if self.options.get("format"):
            return {
                "title": "Progressive Reel",
                "duration": 19,
                "formats": [
                    {"url": "https://cdn.example/video-only.mp4", "ext": "mp4", "vcodec": "h264", "acodec": "none", "protocol": "https", "height": 1080},
                    {"url": "https://cdn.example/combined.webm", "ext": "webm", "vcodec": "vp9", "acodec": "opus", "protocol": "https", "height": 1080},
                    {"url": "https://cdn.example/combined.mp4", "ext": "mp4", "vcodec": "h264", "acodec": "aac", "protocol": "https", "height": 720},
                ],
            }
        return {
            "description": ("A detailed Reel caption with spacing. " * 10),
            "uploader": "Drift",
            "thumbnail": "https://cdn.example/reel.jpg",
            "duration": 17,
        }


class FakeYtDlp:
    YoutubeDL = FakeYoutubeDL


original_get_ytdlp = YTDL._get_yt_dlp
YTDL._get_yt_dlp = lambda: FakeYtDlp
try:
    collection = INSTAGRAM.list_collection({"source": "\n".join(urls), "title": "Travel Reels"})
    check(collection.get("ok") and len(collection.get("entries", [])) == 2, "collection metadata returns every URL")
    check(collection.get("title") == "Travel Reels" and collection.get("scrapeSource") == "yt-dlp", "collection keeps title and route provenance")
    check(all(len(entry.get("title", "")) <= 180 for entry in collection["entries"]), "long captions are bounded for Audioflix cards")
    check(collection["entries"][0].get("artist") == "Drift", "Reel uploader metadata is retained")

    video = INSTAGRAM.resolve_video({"url": urls[0]})
    check(video.get("ok"), "direct Reel video resolves")
    check(video.get("videoUrl") == "https://cdn.example/combined.mp4", "direct video chooses one progressive MP4 with audio")
    check(video.get("height") == 720 and video.get("duration") == 19, "selected stream metadata is returned")

    class FailingYoutubeDL(FakeYoutubeDL):
        def extract_info(self, url, download=False):
            raise RuntimeError("Instagram sent an empty media response")

    class FailingYtDlp:
        YoutubeDL = FailingYoutubeDL

    class FakeResponse:
        def __enter__(self):
            return self

        def __exit__(self, *_args):
            return False

        def read(self):
            return (
                b'<html><head>'
                b'<meta property="og:title" content="Instagram Post Video">'
                b'<meta property="og:video" content="https://cdn.example/post-video.mp4">'
                b'<meta property="og:image" content="https://cdn.example/post.jpg">'
                b'</head></html>'
            )

    # Verify resolver fallback ladder: yt-dlp -> Camofox -> Lightpanda -> Webpage metadata
    original_camofox = INSTAGRAM_BROWSER.extract_camofox_video
    original_lightpanda = INSTAGRAM_BROWSER.extract_lightpanda_video
    original_public = INSTAGRAM_PUBLIC.resolve_public
    YTDL._get_yt_dlp = lambda: FailingYtDlp
    INSTAGRAM_PUBLIC.resolve_public = lambda _shortcode: {"ok": False}
    INSTAGRAM_BROWSER.extract_camofox_video = lambda _url: {
        "ok": True,
        "videoUrl": "https://cdn.example/camofox-video.mp4",
        "title": "Camofox Hydrated Video",
        "thumbnail": "https://cdn.example/camofox-thumb.jpg",
        "source": "camofox-browser",
    }
    try:
        cf_res = INSTAGRAM.resolve_video({"url": "https://www.instagram.com/p/DS2r6KBDNCS/"})
        check(cf_res.get("ok"), "yt-dlp failure falls back to Camofox browser extraction")
        check(cf_res.get("videoUrl") == "https://cdn.example/camofox-video.mp4", "Camofox video URL returned")
        check(cf_res.get("source") == "camofox-browser", "Camofox source identified")
    finally:
        INSTAGRAM_BROWSER.extract_camofox_video = original_camofox

    INSTAGRAM_BROWSER.extract_camofox_video = lambda _url: {"ok": False, "reason": "No video"}
    INSTAGRAM_BROWSER.extract_lightpanda_video = lambda _url: {
        "ok": True,
        "videoUrl": "https://cdn.example/lightpanda-video.mp4",
        "title": "Lightpanda Rendered Video",
        "thumbnail": "https://cdn.example/lightpanda-thumb.jpg",
        "source": "lightpanda-browser",
    }
    try:
        lp_res = INSTAGRAM.resolve_video({"url": "https://www.instagram.com/p/DS2r6KBDNCS/"})
        check(lp_res.get("ok"), "Camofox failure falls back to Lightpanda browser extraction")
        check(lp_res.get("videoUrl") == "https://cdn.example/lightpanda-video.mp4", "Lightpanda video URL returned")
        check(lp_res.get("source") == "lightpanda-browser", "Lightpanda source identified")
    finally:
        INSTAGRAM_BROWSER.extract_camofox_video = original_camofox
        INSTAGRAM_BROWSER.extract_lightpanda_video = original_lightpanda

    INSTAGRAM_BROWSER.extract_camofox_video = lambda _url: {"ok": False, "reason": "No video"}
    INSTAGRAM_BROWSER.extract_lightpanda_video = lambda _url: {"ok": False, "reason": "No video"}
    original_urlopen = INSTAGRAM.urlopen
    INSTAGRAM.urlopen = lambda *_args, **_kwargs: FakeResponse()
    try:
        post_video = INSTAGRAM.resolve_video({"url": "https://www.instagram.com/p/PostVideo/"})
        check(post_video.get("ok"), "video Instagram /p/ post resolves through webpage fallback")
        check(post_video.get("videoUrl") == "https://cdn.example/post-video.mp4", "post fallback returns direct video URL")
        check(post_video.get("source") == "instagram-webpage", "post fallback identifies webpage source")
        check(post_video.get("title") == "Instagram Post Video", "post fallback retains og:title")
    finally:
        INSTAGRAM.urlopen = original_urlopen
        INSTAGRAM_PUBLIC.resolve_public = original_public
        INSTAGRAM_BROWSER.extract_camofox_video = original_camofox
        INSTAGRAM_BROWSER.extract_lightpanda_video = original_lightpanda
        YTDL._get_yt_dlp = lambda: FakeYtDlp

    with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as handle:
        cookie_path = handle.name
        handle.write("# Netscape HTTP Cookie File\n")
        handle.write(".instagram.com\tTRUE\t/\tTRUE\t2147483647\tcsrftoken\tfake-csrf\n")
        handle.write(".instagram.com\tTRUE\t/\tTRUE\t2147483647\tsessionid\tfake-session\n")
    try:
        os.environ["EVEOS_INSTAGRAM_COOKIES"] = cookie_path
        os.environ.pop("EVEOS_INSTAGRAM_COOKIES_BROWSER", None)
        options = INSTAGRAM._ydl_options()
        check(options.get("cookiefile") == cookie_path, "explicit Instagram cookie file is honored by yt-dlp")
        imported = INSTAGRAM_BROWSER._instagram_cookie_entries("https://www.instagram.com/p/DS2r6KBDNCS/")
        check(len(imported) == 2, "explicit Instagram cookie file imports into Camofox")
        check(imported[1].get("name") == "sessionid" and imported[1].get("value") == "fake-session", "Camofox receives cookie name/value")
    finally:
        os.environ.pop("EVEOS_INSTAGRAM_COOKIES", None)
        os.environ.pop("EVEOS_INSTAGRAM_COOKIES_BROWSER", None)
        try:
            os.remove(cookie_path)
        except OSError:
            pass

    os.environ["EVEOS_INSTAGRAM_COOKIES_BROWSER"] = "edge:Default"
    options = INSTAGRAM._ydl_options()
    check(options.get("cookiesfrombrowser") == ("edge", "Default", None, None), "browser cookie configuration is translated correctly")
finally:
    os.environ.pop("EVEOS_INSTAGRAM_COOKIES", None)
    os.environ.pop("EVEOS_INSTAGRAM_COOKIES_BROWSER", None)
    YTDL._get_yt_dlp = original_get_ytdlp


tmp = Path(tempfile.mkdtemp(prefix="eveos_reel_video_"))
download_calls = []
original_local_get = LOCALIZE._get_yt_dlp
original_download = LOCALIZE._download


def fake_download(_yt_dlp, _url, outtmpl, want_mp3, media_format):
    download_calls.append((want_mp3, media_format))
    path = Path(outtmpl.replace(".%(ext)s", ".mp4"))
    path.write_bytes(b"fake-mp4")
    return {"filepath": str(path), "duration": 12}


LOCALIZE._get_yt_dlp = lambda: object()
LOCALIZE._download = fake_download
try:
    localized = LOCALIZE.localize_one({
        "track": {"id": "reel", "title": "Saved Reel", "url": urls[0]},
        "targetDir": str(tmp),
        "mediaFormat": "video",
    })
    check(localized.get("ok") and localized.get("ext") == "mp4", "Reels can localize as MP4")
    check(localized.get("mediaFormat") == "video", "localization reports the requested media format")
    check(download_calls == [(False, "video")], "video localization uses one merge attempt and never enters MP3 fallback")
finally:
    LOCALIZE._get_yt_dlp = original_local_get
    LOCALIZE._download = original_download


bridge_source = Path(ROOT, "server_modules", "audioflix_bridge.py").read_text(encoding="utf-8")
check("/api/audioflix/instagram-collection" in bridge_source, "bridge registers Instagram collection metadata")
check("/api/audioflix/instagram-video" in bridge_source, "bridge registers direct Instagram video")


# Verify the user-initiated browser session connector stores only Instagram cookies.
from server_modules import audioflix_instagram_session as INSTAGRAM_SESSION

with tempfile.TemporaryDirectory(prefix="eveos_ig_session_") as session_root:
    original_appdata = os.environ.get("LOCALAPPDATA")
    original_cookie_config = os.environ.get("EVEOS_CAMOFOX_COOKIE_CONFIG")
    try:
        os.environ["EVEOS_CAMOFOX_COOKIE_CONFIG"] = str(Path(session_root) / "camofox-site-cookies.json")
        imported = INSTAGRAM_SESSION.import_cookies({
            "cookies": [
                {"name": "sessionid", "value": "fake-session", "domain": ".instagram.com", "path": "/", "secure": True, "httpOnly": True},
                {"name": "csrftoken", "value": "fake-csrf", "domain": "www.instagram.com", "path": "/", "secure": True},
                {"name": "not-instagram", "value": "drop-me", "domain": ".example.com", "path": "/"},
            ]
        })
        check(imported.get("ok") and imported.get("cookieCount") == 2, "browser session import accepts only Instagram cookies")
        session_status = INSTAGRAM_SESSION.status()
        check(session_status.get("connected") and session_status.get("cookieCount") == 2, "browser session status reports connected")
        config = json.loads(Path(session_status["configPath"]).read_text(encoding="utf-8"))
        check(len(config["cookies"]["instagram.com"]) == 2, "session store contains only Instagram cookies")
        netscape_file = INSTAGRAM_SESSION._netscape_path()
        check(netscape_file.is_file(), "Netscape cookie file is created for yt-dlp compatibility")
        cleared = INSTAGRAM_SESSION.clear()
        check(cleared.get("ok") and not INSTAGRAM_SESSION.status().get("connected"), "browser session can be cleared")
        check(not netscape_file.is_file(), "Netscape cookie file is cleaned up on session clear")
    finally:
        if original_cookie_config is None:
            os.environ.pop("EVEOS_CAMOFOX_COOKIE_CONFIG", None)
        else:
            os.environ["EVEOS_CAMOFOX_COOKIE_CONFIG"] = original_cookie_config
        if original_appdata is None:
            os.environ.pop("LOCALAPPDATA", None)
        else:
            os.environ["LOCALAPPDATA"] = original_appdata

    # Verify duration extraction from Facebook CDN efg payloads (valid, malformed, missing)
    from server_modules import audioflix_instagram_public_proxy as INSTAGRAM_PROXY
    import base64
    valid_efg = base64.b64encode(json.dumps({"duration_s": 49}).encode()).decode()
    dur1 = INSTAGRAM_PROXY._extract_duration_from_url(f"https://instagram.example.com/video.mp4?efg={valid_efg}")
    check(dur1 == 49, "valid efg parameter extracts exact duration in seconds")
    dur2 = INSTAGRAM_PROXY._extract_duration_from_url("https://instagram.example.com/video.mp4?efg=corrupted_base64!!!")
    check(dur2 == 0, "corrupted efg parameter safely falls back to 0")
    dur3 = INSTAGRAM_PROXY._extract_duration_from_url("https://instagram.example.com/video.mp4?other=param")
    check(dur3 == 0, "missing efg parameter safely returns 0")

    # Verify collection import fallback to public resolver when yt-dlp returns empty response
    original_get_ytdlp = YTDL._get_yt_dlp
    original_public = INSTAGRAM_PUBLIC.resolve_public
    try:
        YTDL._get_yt_dlp = lambda: FailingYtDlp
        INSTAGRAM_PUBLIC.resolve_public = lambda _code: {
            "ok": True,
            "title": "Fallback Public Post Title",
            "artist": "Public Creator",
            "thumbnail": "https://cdn.example/thumb.jpg",
            "duration": 49,
            "source": "instagram-public-proxy",
        }
        col = INSTAGRAM.list_collection({"source": "https://www.instagram.com/p/DS2r6KBDNCS/", "title": "Public Collection"})
        check(col.get("ok"), "collection import succeeds when yt-dlp fails")
        check(len(col.get("entries", [])) == 1, "collection entry is preserved")
        entry = col["entries"][0]
        check(entry.get("title") == "Fallback Public Post Title", "collection entry populates title from public resolver")
        check(entry.get("artist") == "Public Creator", "collection entry populates artist from public resolver")
        check(entry.get("duration") == 49, "collection entry populates duration from public resolver")
    finally:
        YTDL._get_yt_dlp = original_get_ytdlp
        INSTAGRAM_PUBLIC.resolve_public = original_public

    # Verify fail-safe resolution when all providers fail
    try:
        YTDL._get_yt_dlp = lambda: FailingYtDlp
        INSTAGRAM_PUBLIC.resolve_public = lambda _code: {"ok": False}
        INSTAGRAM_BROWSER.extract_camofox_video = lambda _url: {"ok": False}
        INSTAGRAM_BROWSER.extract_lightpanda_video = lambda _url: {"ok": False}
        INSTAGRAM.urlopen = lambda *_args, **_kwargs: FakeResponse() # but without og:video
        class EmptyResponse:
            def __enter__(self): return self
            def __exit__(self, *_args): return False
            def read(self): return b"<html><head></head><body>No video</body></html>"
        INSTAGRAM.urlopen = lambda *_args, **_kwargs: EmptyResponse()
        failed_res = INSTAGRAM.resolve_video({"url": "https://www.instagram.com/p/NonExistent/"})
        check(failed_res.get("ok") is False, "graceful failure when all providers fail")
        check("failed" in failed_res.get("reason", "").lower(), "informative error reason returned")
    finally:
        YTDL._get_yt_dlp = original_get_ytdlp
        INSTAGRAM_PUBLIC.resolve_public = original_public
        INSTAGRAM_BROWSER.extract_camofox_video = original_camofox
        INSTAGRAM_BROWSER.extract_lightpanda_video = original_lightpanda
        INSTAGRAM.urlopen = original_urlopen

print("AUDIOFLIX_INSTAGRAM_BACKEND_SMOKE_OK")
