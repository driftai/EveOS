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
const activation = read('server_modules/audioflix_spotify_playback_activation.js');
const hook = read('server_modules/audioflix_spotify_browser_hook.js');
const manager = read('server_modules/audioflix_spotify_browser.py');
const transport = read('server_modules/audioflix_spotify_browser_transport.js');
const rpc = read('server_modules/audioflix_spotify_browser_rpc.py');
const presentation = read('server_modules/audioflix_spotify_presentation.py');
const broker = read('server_modules/audioflix_spotify_broker.py');
const http = read('server_modules/audioflix_spotify_http.py');
const relay = read('server_modules/audioflix_spotify_relay.py');
const bridge = read('server_modules/audioflix_bridge.py');
const remote = read('js/modules/features/audioflix/audioflix.spotify.remote.js');
const anyBrowser = read('js/modules/features/audioflix/audioflix.spotify.any-browser.js');
const engine = read('js/modules/features/audioflix/audioflix.spotify.engine.js');
const surface = read('js/modules/features/audioflix/audioflix.spotify.engine-surface.js');
const enginePage = read('audioflix-spotify-engine.html');
const launcher = read('tools/audioflix/spotify-managed-browser.ps1');
const serverLaunch = read('server/eveos-server-launch.py');
const manifest = read('js/config/manifest/scripts.parts/03-feature-modules.js');
const ignore = read('.gitignore');

assert(helper.includes("require('playwright')") && helper.indexOf("require('playwright')") > helper.indexOf('async function main()'),
    'Playwright remains lazy so offline readiness checks do not require a browser install');
assert(helper.includes("server.listen(port, '127.0.0.1'") && helper.includes('x-eveos-spotify-token'),
    'private managed helper remains loopback-only and token authenticated');
assert(helper.includes('--autoplay-policy=no-user-gesture-required')
    && helper.includes('--disable-background-timer-throttling')
    && helper.includes('--disable-renderer-backgrounding'),
    'managed browser explicitly permits remote playback and resists minimized-window throttling');
assert(activation.includes('handleTransportWithActivation') && activation.includes('playbackActivated')
    && activation.includes('isLikelyPlayControl') && activation.includes("data-testid")
    && activation.includes('play-pause-button'),
    'remote Play/Resume has a bounded Spotify-control activation fallback');
assert(activation.includes("body.hover") && activation.includes('force: true')
    && activation.includes("dispatchEvent('click')") && activation.includes("note('playback-controls'")
    && activation.includes("note('playback-kick-skip'") && activation.includes('if (observed.playing)'),
    'activation fallback diagnoses hidden controls and exits promptly when provider playback is already active');
assert(!activation.includes('eval(') && !activation.includes('new Function('),
    'playback activation adds no arbitrary evaluation surface');
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
assert(rpc.includes('Browser clients never receive the helper') && rpc.includes('def set_effective_volume')
    && rpc.includes('presentation.ensure_engine') && rpc.includes('def set_presentation')
    && rpc.includes('def stop_engine'),
    'browser clients stay behind server-owned playback and presentation RPC');
assert(presentation.includes('_DEFAULT = "hidden"') && presentation.includes('ShowWindowAsync')
    && presentation.includes('EnumWindows') && presentation.includes('def set_presentation')
    && presentation.includes('def stop_engine'),
    'server presentation policy defaults to audible hidden-headed mode and owns window lifecycle');

assert(broker.includes('ownerEpoch') && broker.includes('trackGeneration') && broker.includes('clientCommandSeq')
    && broker.includes('commandId') && broker.includes('resyncRequired'),
    'broker has ownership, generation, idempotency and stale-replay boundaries');
assert(broker.includes('_transport_lock') && broker.indexOf('if action == "import"') < broker.indexOf('with self._transport_lock'),
    'long playlist import stays outside serialized playback transport operations');
assert(broker.includes('effectiveVolume') && broker.includes('engine.set_effective_volume'),
    'broker accepts an already-effective gain rather than multiplying master volume again');
assert(broker.includes('if not owner and action in {"resume", "volume", "seek", "restart"}')
    && broker.includes('if owner and owner != client_id')
    && broker.includes('if not owner and action in {"pause", "stop", "release"}'),
    'ownerless playback is distinct from another live EveOS tab and can recover without a false observer error');
assert(broker.includes('engine-presentation') && broker.includes('engine-stop')
    && broker.includes('_matching_file_client_locked'),
    'broker exposes bounded engine controls and reuses approved file-document sessions within TTL');

assert(http.includes('origin == _server_origin(handler).lower()') && !http.includes('Access-Control-Allow-Origin", "null"'),
    'new Spotify broker endpoints trust only their exact localhost relay origin, never a raw null-origin request');
assert(http.includes('X-Frame-Options", "DENY"') && http.includes("frame-ancestors 'none'"),
    'trusted approval page is protected from framing/clickjacking');
assert(relay.includes('MessageChannel') === false && relay.includes('event.ports?.[0]'),
    'relay accepts an explicitly transferred MessageChannel and does not manufacture parent authority');
assert(relay.includes('clientToken = String(result.clientToken)') && !relay.includes("type: 'ready', clientToken"),
    'scoped broker credential remains inside relay memory and is not returned to the parent');
assert(relay.includes('Approved. Returning to EveOS') && relay.includes('window.opener?.focus') && relay.includes('window.close'),
    'file approval returns focus to EveOS and closes its trusted popup after success');
assert(remote.includes('MessageChannel') && remote.includes("location.protocol === 'file:'")
    && remote.includes('eveos:spotify-relay-ready') && remote.includes('relayReady')
    && remote.includes('sessionStorage') && remote.includes('eveos:audioflix:spotify-document')
    && !remote.includes('clientToken'),
    'ordinary localhost/file clients use the relay and retain only a stable non-secret document id for reconnect');
assert(anyBrowser.includes('EveAudioflixAudio.playItem') || anyBrowser.includes('audio.playItem = async function')
    && anyBrowser.includes('effectiveGain') && anyBrowser.includes("emitPlayback('Ended')"),
    'ordinary EveOS client routes Spotify through managed transport and preserves public queue events');
assert(anyBrowser.includes('preferredLocalItem')
    && anyBrowser.includes('const localPlayback = window.EveAudioflixLocalPlayback')
    && anyBrowser.includes('localPlayback?.handoffPrepared?.(localItem, prepared.localPath)'),
    'Spotify provider interception gives a validated localized copy first refusal and hands it to normal playback once');
assert(anyBrowser.includes('fallback: !relayWasReached()'),
    'local embed fallback is allowed only when no trusted relay handshake was reached');
assert(anyBrowser.includes('Spotify engine restarted or became idle. Press Play to resume control.'),
    'ordinary EveOS distinguishes an ownerless engine restart from a different-tab ownership conflict');

assert(surface.includes('audioflix-spotify-engine.html?surface=mirror')
    && surface.includes("remote().send('engine-presentation'")
    && surface.includes("remote().send('engine-stop'")
    && surface.includes('Hidden (default)') && surface.includes('True headless (silent)'),
    'Internal Player mirrors the single engine and exposes explicit presentation/subsystem lifecycle controls');
assert(surface.includes('queueConnection()?.snapshot?.()')
    && surface.includes('view?.setQueue?.(entries, index)')
    && surface.includes('onStep:') && surface.includes('onJump:')
    && surface.includes('eve:audioflix-queue-changed'),
    'managed Spotify Internal Player mirrors the Audioflix-owned queue and routes navigation back through it');
assert(launcher.includes("ValidateSet('background','hidden','window','headless')")
    && launcher.includes("[string]$Presentation = 'hidden'")
    && launcher.includes('playwright=headless') && launcher.includes('*-headless')
    && launcher.includes("'hidden' { 0 }") && launcher.includes('spotify-engine-window-handle.txt')
    && launcher.indexOf('Get-SavedSpotifyEngineWindowHandle') < launcher.indexOf("Get-Process msedge"),
    'CLI defaults to hidden headed audio and consults the saved HWND before title scanning');
assert(serverLaunch.includes('shutdown_managed_subsystems')
    && serverLaunch.includes('audioflix_spotify_presentation.stop_engine')
    && serverLaunch.includes('finally:'),
    'canonical EveOS server shutdown tears down the managed Spotify subsystem');
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
runNode('tools/smoke/audioflix_local_prepare_handoff_smoke.js');
runNode('tools/smoke/audioflix_spotify_queue_surface_smoke.js');
runNode('tools/smoke/audioflix_queue_reorder_multi_stage_smoke.js');
runNode('tools/smoke/audioflix_spotify_engine_smoke.js');
require('./audioflix_spotify_managed_import_smoke.js');
console.log('AUDIOFLIX_SPOTIFY_BROWSER_CONTRACT_SMOKE_OK');
