'use strict';

const assert = require('node:assert/strict');
const vm = require('node:vm');
const path = require('node:path');

const helper = require(path.resolve(__dirname, '..', '..', 'server_modules', 'audioflix_spotify_browser.js'));

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
assert.equal(helper.normalizeTrackId('spotify:track:4cOdK2wGLETKBW3PvgPWqT'), '4cOdK2wGLETKBW3PvgPWqT');

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
    const embed = makeBrowserContext('https://open.spotify.com/embed/track/4cOdK2wGLETKBW3PvgPWqT');
    assert.ok(embed.window.__eveSpotifyManagedControl, 'Spotify embed receives bounded managed media control');
    assert.equal(Object.prototype.hasOwnProperty.call(embed.window.__eveSpotifyManagedControl, 'sessionId'), false,
        'Spotify frame control exposes no private helper session id');
    const detached = embed.document.createElement('video');
    await detached.play();
    assert.equal(detached.volume, 0.4, 'new detached media inherits staged gain before audible playback');
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

    console.log('AUDIOFLIX_SPOTIFY_BROWSER_RUNTIME_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });
