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
    && helper.includes("requestUrl.pathname === '/auth'")
    && helper.includes("requestUrl.pathname === '/shutdown'")
    && !helper.includes("requestUrl.pathname === '/eval'")
    && !helper.includes("requestUrl.pathname === '/evaluate'"),
    'helper exposes fixed commands and no arbitrary-evaluation route');
assert(hook.includes('__EveAudioflixManagedBrowserSession')
    && helper.includes('requestedSession === sessionId'),
    'helper injects and enforces exact managed-session identity');
assert(!helper.includes('cookie.value') && !manager.includes('cookie.value'),
    'production helper/manager never serialize cookie values');

assert(manager.includes('audioflix_spotify._profile_dir()')
    && manager.includes('suspend_for_profile_task')
    && manager.includes('resume_after_profile_task'),
    'managed browser reuses the existing Audioflix Spotify profile and can release its profile lock');
assert(manager.includes('nodeAvailable') && manager.includes('playwrightAvailable')
    && manager.includes('helperReachable') && manager.includes('authState'),
    'manager status reports runtime, Playwright, connection, and auth readiness');
assert(manager.includes('if not session_id or session_id != self._session_id'),
    'backend rejects volume commands from an unmanaged/stale EveOS browser session');
assert(!/"token"\s*:/.test(manager), 'manager public status does not expose its helper token');

for (const route of [
    '/api/audioflix/spotify-browser/status',
    '/api/audioflix/spotify-browser/start',
    '/api/audioflix/spotify-browser/stop',
    '/api/audioflix/spotify-browser/volume',
    '/api/audioflix/spotify-browser/auth'
]) assert(bridge.includes(route), `bridge exposes ${route}`);
assert(bridge.includes('suspend_for_profile_task("playlist-import")')
    && bridge.includes('resume_after_profile_task(ticket)'),
    'Spotify playlist import releases/restores the shared managed profile instead of profile-locking');

assert(volume.includes('__EveAudioflixManagedBrowserSession')
    && volume.includes("api('/volume'")
    && volume.includes('sessionId: state.managedSessionId'),
    'Audioflix volume adapter sends writes only from the injected managed session');
assert(volume.includes('effectiveVolume(state.itemVolume)')
    && volume.includes('EveAudioflixOutputPort?.effective?.(safe)'),
    'Spotify gain applies the existing track x output/master volume policy exactly once');
assert(volume.includes('pendingManagedWrite') && volume.includes('pumpManagedVolume'),
    'rapid slider updates are coalesced instead of spawning unbounded browser commands');
assert(volume.includes('state.managedControl = false') && volume.includes('Managed Spotify volume is unavailable'),
    'helper failure downgrades the UI to an honest unavailable state');

assert(ignore.includes('/.spotify-probe-profile/') && ignore.includes('/spotify-volume-probe.mjs'),
    'probe profile and standalone probe are explicitly ignored');

console.log('AUDIOFLIX_SPOTIFY_BROWSER_CONTRACT_SMOKE_OK');
