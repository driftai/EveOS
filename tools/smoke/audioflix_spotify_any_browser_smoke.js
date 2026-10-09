'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.any-browser.js'), 'utf8');

const calls = [];
const windowListeners = new Map();
const dispatched = [];
const spotify = {
    id: 'song-1', type: 'music', sourceProvider: 'spotify', title: 'Smoke',
    url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', volume: 0.5, duration: 180
};
let engineState = {
    status: 'playing', spotifyId: '4cOdK2wGLETKBW3PvgPWqT', generation: 1,
    currentTime: 4, duration: 180, paused: false, completionId: '', eventCursor: 1
};
let lastState = null;

const remote = {
    ready: true,
    snapshot: () => ({ connected: true, status: 'ready', approvalRequired: false, lastState }),
    connect: async () => ({ connected: true, status: 'ready' }),
    waitUntilReady: async () => ({ connected: true }),
    openApproval: () => true,
    async status() {
        lastState = { ok: true, isOwner: true, engine: { ...engineState }, managed: { helperReachable: true } };
        return lastState;
    },
    async send(action, payload = {}) {
        calls.push({ action, payload: { ...payload } });
        if (action === 'play') {
            engineState = {
                ...engineState, status: 'playing', paused: false,
                spotifyId: payload.spotifyId, duration: payload.duration || 180,
                generation: engineState.generation + 1
            };
        } else if (action === 'pause') engineState = { ...engineState, status: 'paused', paused: true };
        else if (action === 'resume') engineState = { ...engineState, status: 'playing', paused: false };
        else if (action === 'seek') engineState = { ...engineState, currentTime: payload.seconds };
        else if (action === 'stop') engineState = { ...engineState, status: 'stopped', paused: true, currentTime: 0 };
        lastState = { ok: true, isOwner: true, engine: { ...engineState }, managed: { helperReachable: true } };
        return lastState;
    }
};

let originalPlayCount = 0;
let originalStopCount = 0;
const audio = {
    ready: true,
    async playItem() { originalPlayCount += 1; return true; },
    async openInternalView() { originalPlayCount += 1; return true; },
    async pause() { return true; },
    async seek() { return true; },
    async stopAll() { originalStopCount += 1; return true; },
    updateItemVolume() {},
    getPlaybackState: () => ({ item: null, paused: true }),
    getStatus: () => ({ status: 'Idle', playback: { paused: true } })
};

const window = {
    EveAudioflixSpotifyRemote: remote,
    EveAudioflixAudio: audio,
    EveAudioflixOutputPort: { effective: (value) => Number(value) * 0.5 },
    addEventListener(name, fn) { windowListeners.set(name, fn); },
    dispatchEvent(event) { dispatched.push(event); }
};
window.window = window;
const context = {
    window,
    console,
    Promise,
    setTimeout,
    clearTimeout,
    setInterval: () => 1,
    clearInterval: () => {},
    CustomEvent: class CustomEvent { constructor(type, options = {}) { this.type = type; this.detail = options.detail; } },
    document: {
        body: { appendChild() {} },
        createElement() { return { style: {}, dataset: {}, append() {}, addEventListener() {}, remove() {} }; }
    }
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'audioflix.spotify.any-browser.js' });

(async () => {
    assert.equal(window.EveAudioflixSpotifyAnyBrowser.ready, true);
    assert.equal(window.EveAudioflixSpotifyAnyBrowser.install(), false,
        'ordinary-tab wrapper installs eagerly once and refuses duplicate wrapping');

    await window.EveAudioflixAudio.playItem(spotify);
    assert.equal(originalPlayCount, 0, 'managed Spotify path does not create an audible local provider player');
    assert.equal(originalStopCount, 1, 'existing local playback is stopped before managed Spotify starts');
    const play = calls.find((entry) => entry.action === 'play');
    assert.ok(play, 'ordinary tab sends play through the authorized relay client');
    assert.equal(play.payload.spotifyId, '4cOdK2wGLETKBW3PvgPWqT');
    assert.equal(play.payload.effectiveVolume, 0.25,
        'track 50% x master/output 50% reaches the engine as exactly 25% once');

    window.EveAudioflixAudio.updateItemVolume('song-1', 0.4);
    await Promise.resolve();
    const slider = calls.filter((entry) => entry.action === 'volume').at(-1);
    assert.equal(slider.payload.effectiveVolume, 0.2,
        'track slider sends one already-effective gain to the engine');

    windowListeners.get('eve:audioflix-output-volume')?.();
    await Promise.resolve();
    const master = calls.filter((entry) => entry.action === 'volume').at(-1);
    assert.equal(master.payload.effectiveVolume, 0.2,
        'master sync starts from saved raw track gain and does not double-attenuate');

    await window.EveAudioflixAudio.pause();
    assert.equal(calls.at(-1).action, 'pause');
    await window.EveAudioflixAudio.seek(42);
    assert.equal(calls.at(-1).action, 'seek');
    assert.equal(calls.at(-1).payload.seconds, 42);

    // If another tab took ownership of the same item, clicking Play here must deliberately transfer
    // ownership rather than silently returning or trying an observer-only resume.
    lastState = { ok: true, isOwner: false, engine: { ...engineState }, managed: { helperReachable: true } };
    const playsBeforeTransfer = calls.filter((entry) => entry.action === 'play').length;
    await window.EveAudioflixAudio.playItem(spotify);
    assert.equal(calls.filter((entry) => entry.action === 'play').length, playsBeforeTransfer + 1,
        'explicit Play on an observed same item transfers ownership through a fresh play command');

    assert.match(source, /completionId/);
    assert.match(source, /emitPlayback\('Ended'\)/);
    assert.match(source, /fallback: false/,
        'relay failure is fail-closed so an uncertain managed engine cannot be doubled by a local embed');
    assert.doesNotMatch(source, /__EveAudioflixManagedBrowserSession/,
        'ordinary-tab client does not depend on the old injected managed-session marker');

    const local = { id: 'local-1', url: 'https://example.com/audio.mp3', sourceProvider: 'direct' };
    await window.EveAudioflixAudio.stopAll();
    await window.EveAudioflixAudio.playItem(local);
    assert.equal(originalPlayCount, 1, 'non-Spotify playback remains on the existing local/browser path');

    assert.ok(dispatched.some((event) => event.type === 'eve:audioflix-progress'),
        'remote Spotify state feeds the existing public Audioflix progress channel');
    console.log('AUDIOFLIX_SPOTIFY_ANY_BROWSER_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });