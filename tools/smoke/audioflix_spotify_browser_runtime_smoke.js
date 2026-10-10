'use strict';

const assert = require('node:assert/strict');
const http = require('node:http');
const vm = require('node:vm');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..', '..');
const helper = require(path.join(ROOT, 'server_modules', 'audioflix_spotify_browser.js'));
const activation = require(path.join(ROOT, 'server_modules', 'audioflix_spotify_playback_activation.js'));

function runChild(runtime, relative) {
    const command = runtime === 'python'
        ? (process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3'))
        : process.execPath;
    const result = spawnSync(command, [path.join(ROOT, relative)], { cwd: ROOT, stdio: 'inherit', env: process.env });
    if (result.error) throw result.error;
    if (result.status !== 0) throw new Error(`${relative} failed with exit ${result.status}`);
}

assert.equal(helper.clampVolume(2), 1);
assert.equal(helper.clampVolume(-1), 0);
assert.equal(helper.clampVolume(0.25), 0.25);
assert.equal(helper.validateLoopbackPageUrl('http://127.0.0.1:8765/audioflix-spotify-engine.html'), true);
assert.equal(helper.validateLoopbackPageUrl('https://localhost:8765/audioflix-spotify-engine.html'), true);
assert.equal(helper.validateLoopbackPageUrl('https://example.com/EveOS.html'), false);
assert.equal(helper.headlessRequestedFromPageUrl('http://127.0.0.1:8765/audioflix-spotify-engine.html?playwright=headless'), true);
assert.equal(helper.headlessRequestedFromPageUrl('http://127.0.0.1:8765/audioflix-spotify-engine.html'), false);
assert.equal(helper.isLikelyPlayControl('Play'), true);
assert.equal(helper.isLikelyPlayControl('Play Hide - CS01 Version'), true);
assert.equal(helper.isLikelyPlayControl('Pause'), false);
assert.equal(helper.isLikelyPlayControl('Play on Spotify'), false);
assert.equal(helper.isSpotifyEmbedUrl('https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT'), true);
assert.equal(helper.isSpotifyEmbedUrl('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'), false);
assert.equal(helper.spotifyFrameTrackId('https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT'), '4cOdK2wGLETKBW3PvgPWqT');
assert.deepEqual(helper.playingTrackIds([
    { trackId: '4cOdK2wGLETKBW3PvgPWqT', playingCount: 1 },
    { trackId: '4cOdK2wGLETKBW3PvgPWqT', playingCount: 2 },
    { trackId: '31NEDDU7nPpmFc6MbADxDg', playingCount: 0 }
]), ['4cOdK2wGLETKBW3PvgPWqT']);
assert.equal(helper.normalizeTrackId('spotify:track:4cOdK2wGLETKBW3PvgPWqT'), '4cOdK2wGLETKBW3PvgPWqT');
assert.equal(helper.SERVER_LIVENESS_INTERVAL_MS, 5000);
assert.equal(helper.SERVER_LIVENESS_TIMEOUT_MS, 30000);
assert.equal(activation.PLAY_WAKE_INITIAL_MS, 1400, 'Spotify autoplay gets a grace period before Playwright kicks');
assert.equal(activation.PLAY_CONTROL_WAIT_MS, 3200, 'ordinary Spotify control scan stays bounded');
assert.equal(activation.PLAY_CONTROL_RENDER_GRACE_MS, 5000,
    'slow Spotify embeds get extra bounded render time before activation is declared unavailable');
assert.equal(activation.PLAY_KICK_VERIFY_MS, 700, 'Playwright kick is verified after the autoplay race window');
assert.equal(activation.shouldRetogglePlaybackKick({
    playing: false,
    transport: { status: 'provider-paused', paused: true, currentTime: 0.204, generation: 3 }
}, 3), true, 'a near-zero provider pause on the same generation is treated as a kick/autoplay race');
assert.equal(activation.shouldRetogglePlaybackKick({
    playing: false,
    transport: { status: 'provider-paused', paused: true, currentTime: 0.204, generation: 4 }
}, 3), false, 'a newer generation is never retoggled');
assert.equal(activation.shouldRetogglePlaybackKick({
    playing: false,
    transport: { status: 'provider-paused', paused: true, currentTime: 3, generation: 3 }
}, 3), false, 'an established provider pause is not mistaken for startup');
assert.equal(activation.shouldRetogglePlaybackKick({
    playing: false,
    transport: { status: 'provider-paused', paused: true, currentTime: 0, generation: 3 }
}, 3), false, 'a click-path pause at 0s keeps the original near-start rule');
assert.equal(activation.shouldRetogglePlaybackKick({
    playing: false,
    transport: { status: 'provider-paused', paused: true, currentTime: 0, generation: 3 }
}, 3, { allowZeroTime: true }), true, 'a late-autoplay Pause flash that reverts at 0s is retried once');

function makeBrowserContext(url) {
    class FakeMedia {
        constructor(tag = 'VIDEO') {
            this.tagName = tag;
            this.volume = 0.8;
            this.paused = true;
            this.ended = false;
            this.currentTime = 0;
            this.duration = 180;
            this.readyState = 4;
            this.mediaKeys = {};
            this.isConnected = false;
        }
        play() { this.paused = false; this.currentTime += 1; return Promise.resolve(); }
    }
    class FakeDocument {
        createElement(tag) { return /^(audio|video)$/i.test(tag) ? new FakeMedia(String(tag).toUpperCase()) : { tagName: String(tag).toUpperCase() }; }
        querySelectorAll() { return []; }
    }
    class FakeAudio extends FakeMedia { constructor() { super('AUDIO'); } }
    const parsed = new URL(url);
    const document = new FakeDocument();
    const window = { Audio: FakeAudio };
    window.window = window;
    const context = {
        window,
        document,
        Document: FakeDocument,
        HTMLMediaElement: FakeMedia,
        location: { hostname: parsed.hostname, pathname: parsed.pathname },
        URL,
        Date,
        Number,
        Math,
        String,
        Boolean,
        Object,
        Array,
        Promise,
        setTimeout,
        clearTimeout
    };
    vm.createContext(context);
    vm.runInContext(`(${helper.browserInit.toString()})(${JSON.stringify({ maxRefs: 32, initialVolume: 0.4 })})`, context);
    return context;
}

(async () => {
    let retoggleCalls = 0;
    const recovered = await activation.stabilizePlaybackKick({
        expectedGeneration: 3,
        verifyMs: 0,
        sleep: async () => {},
        observe: async () => ({
            playing: false,
            transport: { status: 'provider-paused', paused: true, currentTime: 0.204, generation: 3 }
        }),
        retoggle: async () => { retoggleCalls += 1; return { clicked: true, method: 'click' }; },
        waitForPlaying: async () => ({
            playing: true,
            transport: { status: 'playing', paused: false, currentTime: 0.9, generation: 3 }
        })
    });
    assert.equal(retoggleCalls, 1, 'kick/autoplay race receives exactly one bounded Play retry');
    assert.equal(recovered.retoggled, true);
    assert.equal(recovered.observed.playing, true, 'bounded retry can recover playback');

    let wrongGenerationRetries = 0;
    const fenced = await activation.stabilizePlaybackKick({
        expectedGeneration: 3,
        verifyMs: 0,
        sleep: async () => {},
        observe: async () => ({
            playing: false,
            transport: { status: 'provider-paused', paused: true, currentTime: 0.2, generation: 4 }
        }),
        retoggle: async () => { wrongGenerationRetries += 1; return { clicked: true }; },
        waitForPlaying: async () => ({ playing: true, transport: { generation: 4 } })
    });
    assert.equal(wrongGenerationRetries, 0, 'a replaced track generation is never retried');
    assert.equal(fenced.retoggled, false);

    // Live run 603e2999 track 18: Pause flashed during the activation scan (kick-skip), then Spotify
    // reverted to provider-paused at 0s and the queue stalled. The late path must verify and retry once.
    let lateRetries = 0;
    const late = await activation.stabilizePlaybackKick({
        expectedGeneration: 7,
        verifyMs: 0,
        allowZeroTime: true,
        sleep: async () => {},
        observe: async () => ({
            playing: false,
            transport: { status: 'provider-paused', paused: true, currentTime: 0, generation: 7 }
        }),
        retoggle: async () => { lateRetries += 1; return { clicked: true, method: 'click' }; },
        waitForPlaying: async () => ({ playing: true, transport: { status: 'playing', generation: 7 } })
    });
    assert.equal(lateRetries, 1, 'late autoplay revert gets exactly one bounded Play retry');
    assert.equal(late.observed.playing, true);

    const livenessServer = http.createServer((_req, res) => { res.writeHead(200); res.end('ok'); });
    await new Promise((resolve) => livenessServer.listen(0, '127.0.0.1', resolve));
    const port = livenessServer.address().port;
    const livenessUrl = `http://127.0.0.1:${port}/EveOS.html`;
    assert.equal(await helper.probeServer(livenessUrl, 500), true, 'watchdog sees a live EveOS endpoint');
    await new Promise((resolve) => livenessServer.close(resolve));
    assert.equal(await helper.probeServer(livenessUrl, 250), false, 'watchdog sees the EveOS endpoint disappear');

    const primary = {
        closed: false, navigations: [],
        async goto(url) { this.navigations.push(url); },
        async close() { this.closed = true; }
    };
    const restoredBlank = { closed: false, async close() { this.closed = true; } };
    const restoredEngine = { closed: false, async close() { this.closed = true; } };
    const pages = [primary, restoredBlank, restoredEngine];
    let newPageCalls = 0;
    const managedContext = {
        pages: () => pages.filter((item) => !item.closed),
        async newPage() { newPageCalls += 1; throw new Error('should reuse the persistent context page'); }
    };
    const notes = [];
    const managedPage = await helper.prepareManagedPage(
        managedContext,
        'http://127.0.0.1:8765/audioflix-spotify-engine.html',
        (kind, message) => notes.push([kind, message])
    );
    assert.equal(managedPage, primary, 'helper reuses the persistent context default/restored page');
    assert.equal(newPageCalls, 0, 'helper does not create an extra about:blank page at startup');
    assert.deepEqual(primary.navigations, ['http://127.0.0.1:8765/audioflix-spotify-engine.html']);
    assert.equal(managedContext.pages().length, 1, 'restored/blank tabs are pruned to one managed engine page');
    assert.equal(restoredBlank.closed, true);
    assert.equal(restoredEngine.closed, true);
    assert.ok(notes.some(([kind]) => kind === 'page-prune'), 'startup records restored-tab pruning');
    await helper.prepareManagedPage(managedContext, 'http://127.0.0.1:8765/audioflix-spotify-engine.html');
    assert.equal(newPageCalls, 0, 're-preparing a healthy context still reuses the sole page');
    assert.equal(managedContext.pages().length, 1);

    const embed = makeBrowserContext('https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT');
    assert.ok(embed.window.__eveSpotifyManagedControl, 'Spotify embed receives bounded managed media control');
    assert.equal(Object.prototype.hasOwnProperty.call(embed.window.__eveSpotifyManagedControl, 'sessionId'), false,
        'Spotify frame control exposes no private helper session id');
    const detached = embed.document.createElement('video');
    await detached.play();
    assert.equal(detached.volume, 0.4, 'new detached playing video inherits staged gain before audible playback');
    let snap = embed.window.__eveSpotifyManagedControl.setVolume(0.25);
    assert.equal(detached.volume, 0.25, 'detached playing video receives requested volume');
    assert.equal(snap.playingCount, 1);
    assert.ok(snap.reached >= 1);
    assert.equal(Object.prototype.hasOwnProperty.call(snap, 'sessionId'), false,
        'media snapshot never serializes helper session material');

    for (let i = 0; i < 80; i += 1) embed.document.createElement(i % 2 ? 'audio' : 'video');
    snap = embed.window.__eveSpotifyManagedControl.snapshot();
    assert.ok(snap.mediaCount <= 32, `media registry is bounded (got ${snap.mediaCount})`);

    const ordinarySpotify = makeBrowserContext('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(ordinarySpotify.window.__eveSpotifyManagedControl, undefined,
        'ordinary Spotify pages are not instrumented as playback embeds');

    const loopback = makeBrowserContext('http://127.0.0.1:8765/EveOS.html');
    assert.equal(loopback.window.__EveAudioflixManagedBrowserSession, undefined,
        'ordinary/engine loopback documents receive no injected helper session marker');
    assert.equal(loopback.window.__eveSpotifyManagedControl, undefined,
        'EveOS top page does not receive Spotify media hooks');

    const other = makeBrowserContext('https://example.com/embed/track/4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(other.window.__eveSpotifyManagedControl, undefined,
        'non-Spotify origins never receive media hooks');

    runChild('python', 'tools/smoke/audioflix_spotify_rpc_timeout_smoke.py');
    runChild('node', 'tools/smoke/audioflix_queue_superseded_start_smoke.js');

    console.log('AUDIOFLIX_SPOTIFY_BROWSER_RUNTIME_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });
