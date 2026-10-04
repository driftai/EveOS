'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

function wait(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createSpotifyHarness() {
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
    window = {
        EveAudioflixSpotifyPlayback: {},
        __EveAudioflixSpotifyEndWatchdogGraceMs: 0
    };
    vm.runInNewContext(source, {
        window,
        document,
        setTimeout,
        clearTimeout,
        Promise,
        Date,
        queueMicrotask
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
    return { listeners, playbackEvents, progressEvents, view };
}

test('Spotify marks the track ended from its last playing sample when terminal updates stop', async () => {
    const harness = await createSpotifyHarness();
    harness.listeners.get('playback_update')?.({
        data: {
            playingURI: 'spotify:track:AAA111',
            position: 30,
            duration: 80,
            isPaused: false
        }
    });

    // Do not send Spotify's normal terminal paused/update event. This models the
    // event starvation seen while EveOS is minimized/backgrounded.
    await wait(100);

    assert.equal(harness.playbackEvents.filter((status) => status === 'Ended').length, 1);
    assert.equal(harness.view.playback.paused, true);
    assert.equal(harness.view.playback.currentTime, 0.08);
    assert.ok(harness.progressEvents.length > 0);
});

test('Spotify completion watchdog is cancelled by an explicit pause', async () => {
    const harness = await createSpotifyHarness();
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

    assert.equal(harness.playbackEvents.filter((status) => status === 'Ended').length, 0);
});
