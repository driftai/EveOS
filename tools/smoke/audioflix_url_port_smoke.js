// Contract smoke for Audioflix's localhost URL media port and provider isolation.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); };

const ports = read('server_modules/audioflix_bridge_ports.py');
const localPlayback = read('js/modules/features/audioflix/audioflix.audio.local.js');
const source = read('js/modules/features/audioflix/audioflix.audio.source.js');
const spotifyNative = read('js/modules/features/audioflix/audioflix.native.spotify.js');
const spotifyVolume = read('js/modules/features/audioflix/audioflix.spotify.volume.js');
const ytdl = read('server_modules/audioflix_ytdl.py');

assert(ports.includes('path == "/api/audioflix/port/url"'),
    'server exposes the dedicated Audioflix URL media port');
assert(ports.includes('validate_public_http_target(target_url)')
    && ports.includes('build_public_opener().open(request'),
    'URL port uses the shared public-target and redirect guards');
assert(ports.includes('headers["Range"] = requested_range')
    && ports.includes('"Content-Range"')
    && ports.includes('HTTPStatus.PARTIAL_CONTENT'),
    'URL port preserves upstream byte-range playback/seek semantics');
assert(ports.includes('_remote_media_type_allowed(content_type)')
    && ports.includes('HTTPStatus.UNSUPPORTED_MEDIA_TYPE'),
    'URL port rejects non-media upstream responses');
assert(!ports.includes('Cookie') && !ports.includes('Authorization'),
    'URL port does not forward browser credentials');

assert(localPlayback.includes('getRemoteMediaPortUrl')
    && localPlayback.includes('/api/audioflix/port/url?url='),
    'shared Audioflix media-source hook routes remote media through localhost');
assert(localPlayback.includes('PROVIDER_PAGE_RE.test(raw)')
    && localPlayback.includes('LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase())'),
    'provider pages and loopback URLs are not recursively ported');
assert(localPlayback.includes('const next = getRemoteMediaPortUrl(requested) || requested'),
    'ordinary media elements receive the ported URL transparently');

assert(source.includes('return PLATFORM_RE.test(value);'),
    'only real platform/page URLs enter the generic resolver');
assert(!source.includes('!DIRECT_AUDIO_RE.test(value)'),
    'extensionless ordinary HTTP URLs are no longer guessed into yt-dlp');
assert(source.includes('keepRemoteMediaDirect')
    && source.includes("delete item.rawAudioUrl")
    && source.includes("item.originalUrl = ''"),
    'ordinary URL playback copies suppress the legacy re-resolve retry');
assert(source.includes('const inner = proxiedTarget(currentUrl)')
    && source.includes('safeItem.url = inner'),
    'legacy proxy-wrapped ordinary media is unwrapped for the URL port');

assert(spotifyNative.includes('stripAlternatePlaybackFields')
    && spotifyNative.includes("spotifyPlaybackMode: 'official-embed'"),
    'Spotify preparation strips alternate-media residue and stays official-provider owned');
assert(ytdl.includes('_is_spotify_provider_url(url)')
    && ytdl.includes('alternate URL resolution is disabled'),
    'server-side yt-dlp resolver rejects Spotify provider identities');
assert(!spotifyVolume.includes('getDisplayMedia')
    && !spotifyVolume.includes('window.open(')
    && !spotifyVolume.includes('createMediaStreamSource'),
    'Spotify volume path cannot reopen the removed tab-share/capture flow');

console.log('AUDIOFLIX_URL_PORT_SMOKE_OK');
