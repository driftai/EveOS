'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSpotifyHarness(options = {}) {
    const source = fs.readFileSync(
        path.join(__dirname, '..', 'js', 'modules', 'features', 'audioflix', 'audioflix.audio.url.spotify.js'),
        'utf8'
    );
    const listeners = new Map();
    const playbackEvents = [];
    const progressEvents = [];
    const controller = {
        play: () => Promise.resolve(),
        pause: () => Promise.resolve(),
        seek: () => Promise.resolve(),
        setVolume() {},
        destroy() {},
        loadUri: () => Promise.resolve(),
        addListener(name, handler) { listeners.set(name, handler); }
    };
    let window;
    const api = {
        createController(_mount, _options, ready) {
            ready(controller);
            queueMicrotask(() => listeners.get('ready')?.());
        }
    };
    const document = {
        scripts: [],
        createElement(tag) {
            if (tag === 'script') {
                return { src: '', async: false, addEventListener() {} };
            }
            return { className: '' };
        },
        head: {
            appendChild(script) {
                document.scripts.push(script);
                queueMicrotask(() => window.onSpotifyIframeApiReady?.(api));
            }
        }
    };
    const workerState = { created: 0, armed: 0, cancelled: 0, terminated: 0, urls: [] };
    window = {
        EveAudioflixSpotifyPlayback: {},
        __EveAudioflixSpotifyEndWatchdogGraceMs: 0
    };

    if (options.workerScheduler) {
        class FakeWorker {
            constructor(url) {
                workerState.created += 1;
                workerState.urls.push(String(url || ''));
                this.onmessage = null;
                this.timer = 0;
            }
            postMessage(message) {
                if (message?.type === 'cancel') {
                    workerState.cancelled += 1;
                    if (this.timer) clearTimeout(this.timer);
                    this.timer = 0;
                    return;
                }
                if (message?.type !== 'arm') return;
                workerState.armed += 1;
                if (this.timer) clearTimeout(this.timer);
                const token = Number(message.token) || 0;
                this.timer = setTimeout(() => {
                    this.timer = 0;
                    this.onmessage?.({ data: { type: 'deadline', token } });
                }, Math.max(0, Number(message.delay) || 0));
            }
            terminate() {
                workerState.terminated += 1;
                if (this.timer) clearTimeout(this.timer);
                this.timer = 0;
            }
        }
        window.Worker = FakeWorker;
        if (options.fileMode) {
            window.location = { protocol: 'file:' };
            window.Blob = undefined;
            window.URL = {
                createObjectURL() { throw new Error('Blob workers unavailable in file mode harness'); },
                revokeObjectURL() {}
            };
        } else {
            window.Blob = class FakeBlob {};
            window.URL = {
                createObjectURL: () => 'blob:spotify-background-watchdog',
                revokeObjectURL() {}
            };
        }
    }

    let starvedTimerId = 1000;
    const pageSetTimeout = options.starvePageTimers
        ? () => ++starvedTimerId
        : setTimeout;
    const pageClearTimeout = options.starvePageTimers
        ? () => {}
        : clearTimeout;
    let networkRequests = 0;

    vm.runInNewContext(source, {
        window,
        document,
        setTimeout: pageSetTimeout,
        clearTimeout: pageClearTimeout,
        Promise,
        Date,
        queueMicrotask,
        fetch() {
            networkRequests += 1;
            throw new Error('network access is not available in this harness');
        }
    });
    const view = {
        playback: { paused: true, currentTime: 0, duration: 0 },
        active: null,
        revealTransportFallback() {}
    };
    const provider = window.EveAudioflixSpotifyPlayback.create({
        view,
        ensureStage() { return { appendChild() {} }; },
        setStageStatus() {},
        emitPlayback(status) { playbackEvents.push(status); },
        emitProgress() { progressEvents.push({ ...view.playback }); }
    });
    await provider.playSpotify({
        id: 'song-a',
        title: 'Song A',
        url: 'https://open.spotify.com/track/AAA111'
    });
    listeners.get('playback_started')?.({});
    return { listeners, playbackEvents, progressEvents, view, workerState, get networkRequests() { return networkRequests; } };
}

test('Spotify completion survives throttled page timers through its background worker deadline', async () => {
    const harness = await createSpotifyHarness({ starvePageTimers: true, workerScheduler: true });
    harness.listeners.get('playback_update')?.({
        data: {
            playingURI: 'spotify:track:AAA111',
            position: 30,
            duration: 80,
            isPaused: false
        }
    });

    // The page's normal setTimeout callbacks never execute in this harness. The
    // dedicated worker owns the completion deadline, matching the boundary that
    // matters when Chrome heavily throttles a minimized EveOS renderer.
    await wait(100);

    assert.equal(harness.workerState.created, 1);
    assert.ok(harness.workerState.armed >= 1);
    assert.equal(harness.playbackEvents.filter((status) => status === 'Ended').length, 1);
    assert.equal(harness.view.playback.paused, true);
    assert.equal(harness.view.playback.currentTime, 0.08);
    assert.ok(harness.progressEvents.length > 0);
});

test('Spotify still marks the track ended with the page-timer fallback when workers are unavailable', async () => {
    const harness = await createSpotifyHarness();
    harness.listeners.get('playback_update')?.({
        data: {
            playingURI: 'spotify:track:AAA111',
            position: 30,
            duration: 80,
            isPaused: false
        }
    });

    await wait(100);

    assert.equal(harness.playbackEvents.filter((status) => status === 'Ended').length, 1);
    assert.equal(harness.view.playback.paused, true);
});

test('Spotify background completion deadline is cancelled by an explicit pause', async () => {
    const harness = await createSpotifyHarness({ starvePageTimers: true, workerScheduler: true });
    harness.listeners.get('playback_update')?.({
        data: {
            playingURI: 'spotify:track:AAA111',
            position: 10,
            duration: 100,
            isPaused: false
        }
    });

    await harness.view.active.player.pause();
    await wait(140);

    assert.ok(harness.workerState.cancelled >= 1);
    assert.equal(harness.playbackEvents.filter((status) => status === 'Ended').length, 0);
});

test('Spotify file mode uses an inline worker with no localhost or network dependency', async () => {
    const harness = await createSpotifyHarness({
        starvePageTimers: true,
        workerScheduler: true,
        fileMode: true
    });
    harness.listeners.get('playback_update')?.({
        data: {
            playingURI: 'spotify:track:AAA111',
            position: 30,
            duration: 80,
            isPaused: false
        }
    });

    await wait(100);

    assert.equal(harness.workerState.created, 1);
    assert.match(harness.workerState.urls[0], /^data:text\/javascript;charset=utf-8,/);
    assert.ok(harness.workerState.armed >= 1);
    assert.equal(harness.networkRequests, 0);
    assert.equal(harness.playbackEvents.filter((status) => status === 'Ended').length, 1);
    assert.equal(harness.view.playback.paused, true);
});
