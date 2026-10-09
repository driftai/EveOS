'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');
const assert = (condition, message) => { if (!condition) throw new Error(`ASSERT FAILED: ${message}`); };
const runNode = (relative) => {
    const result = spawnSync(process.execPath, [path.join(ROOT, relative)], { cwd: ROOT, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${relative} failed with exit ${result.status}`);
};
const runPython = (relative) => {
    const executable = process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
    const result = spawnSync(executable, [path.join(ROOT, relative)], { cwd: ROOT, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${relative} failed with exit ${result.status}`);
};

const helper = read('server_modules/audioflix_spotify_browser.js');
const hook = read('server_modules/audioflix_spotify_browser_hook.js');
const manager = read('server_modules/audioflix_spotify_browser.py');
const transport = read('server_modules/audioflix_spotify_browser_transport.js');
const rpc = read('server_modules/audioflix_spotify_browser_rpc.py');
const broker = read('server_modules/audioflix_spotify_broker.py');
const http = read('server_modules/audioflix_spotify_http.py');
const relay = read('server_modules/audioflix_spotify_relay.py');
const bridge = read('server_modules/audioflix_bridge.py');
const remote = read('js/modules/features/audioflix/audioflix.spotify.remote.js');
const anyBrowser = read('js/modules/features/audioflix/audioflix.spotify.any-browser.js');
const engine = read('js/modules/features/audioflix/audioflix.spotify.engine.js');
const enginePage = read('audioflix-spotify-engine.html');
const manifest = read('js/config/manifest/scripts.parts/03-feature-modules.js');
const ignore = read('.gitignore');

assert(helper.includes("require('playwright')") && helper.indexOf("require('playwright')") > helper.indexOf('async function main()'),
    'Playwright remains lazy so offline readiness checks do not require a browser install');
assert(helper.includes("server.listen(port, '127.0.0.1'") && helper.includes('x-eveos-spotify-token'),
    'private managed helper remains loopback-only and token authenticated');
assert(hook.includes("host !== 'open.spotify.com'") && hook.includes("startsWith('/embed/')"),
    'media instrumentation is scoped to Spotify embed frames');
assert(hook.includes('HTMLMediaElement.prototype.play')
    && hook.includes('window.Audio = WrappedAudio')
    && hook.includes('Document.prototype.createElement'),
    'detached Spotify media discovery remains intact');
assert(hook.includes('MAX_MEDIA_REFS = 32') && hook.includes('state.media = ranked.slice(0, maxRefs)'),
    'detached media references remain bounded');
assert(!hook.includes('__EveAudioflixManagedBrowserSession') && !hook.includes('sessionId'),
    'helper secrets are no longer injected into loopback or Spotify frame documents');

for (const route of ['/volume', '/transport', '/playlist', '/open', '/auth', '/shutdown']) {
    assert(helper.includes(`requestUrl.pathname === '${route}'`), `private helper exposes fixed ${route} route`);
}
assert(!helper.includes("requestUrl.pathname === '/eval'") && !helper.includes("requestUrl.pathname === '/evaluate'"),
    'managed helper exposes no arbitrary evaluation route');
assert(!helper.includes('cookie.value') && !manager.includes('cookie.value'),
    'helper and manager never serialize cookie values');
assert(transport.includes('ALLOWED_ACTIONS') && transport.includes("'load'") && transport.includes("'pause'")
    && transport.includes("'seek'") && !transport.includes('eval('),
    'engine transport is a fixed typed command surface');

assert(enginePage.includes('spotify-engine-player') && enginePage.includes('audioflix.spotify.engine.js'),
    'managed browser owns one lightweight Spotify engine page instead of a complete EveOS client');
assert(engine.includes("'provider-paused'") && !engine.includes('paused unexpectedly')
    && !engine.includes('Recovering ('),
    'remote engine reports provider pause rather than ambiguously auto-resuming it');
assert(engine.includes('completionId') && engine.includes("setStatus('playing')") && engine.includes('markEnded'),
    'engine reports transport/completion evidence without owning the Audioflix queue');

assert(manager.includes('audioflix_spotify._profile_dir()')
    && manager.includes('def list_playlist(') && manager.includes('"POST", "/playlist"'),
    'managed engine reuses the existing saved Spotify profile and same-context importer');
assert(manager.includes('hmac.compare_digest(candidate, expected)')
    && !manager.includes('"sessionId": helper.get("sessionId")'),
    'server-private helper session remains constant-time checked and absent from public manager status');
assert(rpc.includes('Browser clients never receive the helper') && rpc.includes('def set_effective_volume'),
    'browser clients are separated from helper port/token/session by server-side RPC');

assert(broker.includes('ownerEpoch') && broker.includes('trackGeneration') && broker.includes('clientCommandSeq')
    && broker.includes('commandId') && broker.includes('resyncRequired'),
    'broker has ownership, generation, idempotency and stale-replay boundaries');
assert(broker.includes('_transport_lock') && broker.indexOf('if action == "import"') < broker.indexOf('with self._transport_lock'),
    'long playlist import stays outside serialized playback transport operations');
assert(broker.includes('effectiveVolume') && broker.includes('engine.set_effective_volume'),
    'broker accepts an already-effective gain rather than multiplying master volume again');

assert(http.includes('origin == _server_origin(handler).lower()') && !http.includes('Access-Control-Allow-Origin", "null"'),
    'new Spotify broker endpoints trust only their exact localhost relay origin, never a raw null-origin request');
assert(http.includes('X-Frame-Options", "DENY"') && http.includes("frame-ancestors 'none'"),
    'trusted approval page is protected from framing/clickjacking');
assert(relay.includes('MessageChannel') === false && relay.includes('event.ports?.[0]'),
    'relay accepts an explicitly transferred MessageChannel and does not manufacture parent authority');
assert(relay.includes('clientToken = String(result.clientToken)') && !relay.includes("type: 'ready', clientToken"),
    'scoped broker credential remains inside relay memory and is not returned to the parent');
assert(remote.includes('MessageChannel') && remote.includes("location.protocol === 'file:'")
    && !remote.includes('clientToken'),
    'ordinary localhost/file clients share the relay without handling broker credentials');
assert(anyBrowser.includes('EveAudioflixAudio.playItem') || anyBrowser.includes('audio.playItem = async function')
    && anyBrowser.includes('effectiveGain') && anyBrowser.includes("emitPlayback('Ended')"),
    'ordinary EveOS client routes Spotify through managed transport and preserves public queue events');

assert(manifest.includes('audioflix.spotify.remote.js') && manifest.includes('audioflix.spotify.any-browser.js'),
    'any-browser Spotify client is reachable from the feature manifest');
assert(bridge.includes('audioflix_spotify_http.handle_get_request') && bridge.includes('audioflix_spotify_http.handle_post_request'),
    'existing Audioflix HTTP facade owns the new relay/broker surface');
assert(ignore.includes('/.spotify-probe-profile/') && ignore.includes('/spotify-volume-probe.mjs'),
    'probe profile and standalone probe remain ignored');

runNode('tools/smoke/audioflix_spotify_relay_security_smoke.js');
runPython('tools/smoke/audioflix_spotify_broker_smoke.py');
runNode('tools/smoke/audioflix_spotify_entrypoints_smoke.js');
runNode('tools/smoke/audioflix_spotify_any_browser_smoke.js');
require('./audioflix_spotify_managed_import_smoke.js');
console.log('AUDIOFLIX_SPOTIFY_BROWSER_CONTRACT_SMOKE_OK');