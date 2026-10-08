'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); };

const helper = read('server_modules/audioflix_spotify_browser.js');
const hook = read('server_modules/audioflix_spotify_browser_hook.js');
const manager = read('server_modules/audioflix_spotify_browser.py');
const bridge = read('server_modules/audioflix_bridge.py');
const volume = read('js/modules/features/audioflix/audioflix.spotify.volume.js');
const ignore = read('.gitignore');

assert(helper.includes("require('playwright')") && helper.indexOf("require('playwright')") > helper.indexOf('async function main()'),
    'Playwright is loaded lazily so readiness checks/offline smokes do not require a browser install');
assert(helper.includes("server.listen(port, '127.0.0.1'") && helper.includes('x-eveos-spotify-token'),
    'managed helper binds loopback only and requires a private token');
assert(hook.includes("host !== 'open.spotify.com'") && hook.includes("startsWith('/embed/')"),
    'media instrumentation is scoped to Spotify embed frames');
assert(hook.includes('HTMLMediaElement.prototype.play')
    && hook.includes('window.Audio = WrappedAudio')
    && hook.includes('Document.prototype.createElement'),
    'production hook retains the detached-media discovery mechanisms proven by the probe');
assert(hook.includes('MAX_MEDIA_REFS = 32') && hook.includes('state.media = ranked.slice(0, maxRefs)'),
    'retained detached media references are bounded');
assert(helper.includes("requestUrl.pathname === '/volume'")
    && helper.includes("requestUrl.pathname === '/playlist'")
    && helper.includes("requestUrl.pathname === '/auth'")
    && helper.includes("requestUrl.pathname === '/shutdown'")
    && !helper.includes("requestUrl.pathname === '/eval'")
    && !helper.includes("requestUrl.pathname === '/evaluate'"),
    'helper exposes fixed commands, including managed playlist import, and no arbitrary-evaluation route');
assert(hook.includes('__EveAudioflixManagedBrowserSession')
    && helper.includes('crypto.timingSafeEqual(actual, expected)'),
    'helper injects and constant-time checks exact managed-session identity');
assert(!helper.includes('cookie.value') && !manager.includes('cookie.value'),
    'production helper/manager never serialize cookie values');

assert(manager.includes('audioflix_spotify._profile_dir()')
    && manager.includes('def list_playlist(')
    && manager.includes('"POST", "/playlist"'),
    'managed browser reuses the existing Audioflix Spotify profile and imports inside that live context');
assert(!manager.includes('suspend_for_profile_task') && !manager.includes('resume_after_profile_task'),
    'playlist import no longer requires stopping the managed browser to release its own profile');
assert(manager.includes('nodeAvailable') && manager.includes('playwrightAvailable')
    && manager.includes('helperReachable') && manager.includes('authState'),
    'manager status reports runtime, Playwright, connection, and auth readiness');
assert(manager.includes('hmac.compare_digest(candidate, expected)')
    && manager.includes('def session_status(')
    && manager.includes('"sessionPresent": bool(self._session_id if running else "")'),
    'backend compares managed-session proofs in constant time without publishing the session id');
assert(!manager.includes('"sessionId": helper.get("sessionId")'),
    'public manager status never serializes the managed session id');
assert(!/"token"\s*:/.test(manager), 'manager public status does not expose its helper token');

for (const route of [
    '/api/audioflix/spotify-browser/status',
    '/api/audioflix/spotify-browser/start',
    '/api/audioflix/spotify-browser/stop',
    '/api/audioflix/spotify-browser/session-status',
    '/api/audioflix/spotify-browser/volume',
    '/api/audioflix/spotify-browser/qualify-volume',
    '/api/audioflix/spotify-browser/auth'
]) assert(bridge.includes(route), `bridge exposes ${route}`);
assert(bridge.includes('def _can_cli_control(handler)')
    && bridge.includes('if path == "/api/audioflix/spotify-browser/qualify-volume"')
    && bridge.includes('if not _can_cli_control(handler):'),
    'live qualifier has a fixed no-Origin localhost gate and cannot be invoked by an ordinary browser tab');
assert(bridge.includes('audioflix_spotify_browser.list_playlist')
    && bridge.includes('managedBrowserImport')
    && !bridge.includes('suspend_for_profile_task("playlist-import")'),
    'managed playlist import keeps the issuing EveOS browser alive instead of closing it for a profile lock');

assert(volume.includes('__EveAudioflixManagedBrowserSession')
    && volume.includes("api('/session-status'")
    && volume.includes("api('/volume'")
    && volume.includes('sessionId: state.managedSessionId'),
    'Audioflix proves and writes only from the injected managed session without reading it from public status');
assert(!volume.includes("String(result?.sessionId || '') === state.managedSessionId"),
    'managed capability no longer depends on a session id echoed by the public status route');
assert(volume.includes('effectiveVolume(state.itemVolume)')
    && volume.includes('EveAudioflixOutputPort?.effective?.(safe)'),
    'Spotify gain applies the existing track x output/master volume policy exactly once');
assert(volume.includes('pendingManagedWrite') && volume.includes('pumpManagedVolume'),
    'rapid slider updates are coalesced instead of spawning unbounded browser commands');
assert(volume.includes('state.managedControl = false') && volume.includes('Managed Spotify volume is unavailable'),
    'helper failure downgrades the UI to an honest unavailable state');

assert(ignore.includes('/.spotify-probe-profile/') && ignore.includes('/spotify-volume-probe.mjs'),
    'probe profile and standalone probe are explicitly ignored');

// Registered transitively through this already-registered managed-browser contract smoke.
require('./audioflix_spotify_managed_import_smoke.js');
console.log('AUDIOFLIX_SPOTIFY_BROWSER_CONTRACT_SMOKE_OK');
