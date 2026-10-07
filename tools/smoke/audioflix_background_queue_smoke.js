#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.ui.overlay.js'),
    'utf8'
);

function assert(condition, message) {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
}

(async () => {
    const listeners = new Map();
    const queueState = {
        groupName: 'Spotify Group',
        currentIndex: 0,
        isPlaying: true,
        repeatOne: false,
        entries: [
            { id: 101, title: 'First Spotify track' },
            { id: '202', title: 'Second Spotify track' },
            { id: '303', title: 'Third Spotify track' }
        ]
    };
    let stepCalls = 0;

    const window = {
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        EveAudioflix: {
            queueConnection: {
                snapshot() {
                    return {
                        ...queueState,
                        entries: queueState.entries.map((entry) => ({ ...entry }))
                    };
                },
                step(delta) {
                    stepCalls += 1;
                    queueState.currentIndex += Number(delta) || 0;
                    return Promise.resolve(true);
                }
            }
        }
    };
    window.window = window;

    vm.runInNewContext(source, {
        window,
        document: {},
        Promise,
        String,
        Number,
        Math,
        setImmediate,
        setTimeout,
        clearTimeout,
        console
    });

    window.EveAudioflixUiOverlay.create({ view: {} });
    const playbackListeners = listeners.get('eve:audioflix-playback') || [];
    assert(playbackListeners.length === 1,
        'overlay registers one provider queue bridge before the main UI playback listener');

    // Normal Spotify playback now resolves onto an Eve-owned provider (usually YouTube). Preserve
    // the queue ownership by provenance instead of requiring the terminal provider name to be Spotify.
    playbackListeners[0]({
        detail: {
            status: 'Ended',
            browserOnly: true,
            provider: 'youtube',
            item: { id: '101', sourceProvider: 'spotify', spotifyUrl: 'https://open.spotify.com/track/AAA111' }
        }
    });
    await flush();

    assert(stepCalls === 1, 'resolved Spotify Ended advances the existing queue exactly once');
    assert(queueState.currentIndex === 1, 'resolved Spotify Ended selects the following queue item');

    // A delayed duplicate terminal update for the prior provider item must not skip another song.
    playbackListeners[0]({
        detail: {
            status: 'Ended',
            browserOnly: true,
            provider: 'youtube',
            item: { id: 101, sourceProvider: 'spotify', spotifyUrl: 'https://open.spotify.com/track/AAA111' }
        }
    });
    await flush();
    assert(stepCalls === 1, 'duplicate/stale resolved Spotify Ended cannot advance a second time');

    // Repeat-one intentionally remains owned by the established generic queue restart path.
    queueState.currentIndex = 1;
    queueState.repeatOne = true;
    playbackListeners[0]({
        detail: {
            status: 'Ended',
            browserOnly: true,
            provider: 'youtube',
            item: { id: 202, sourceProvider: 'spotify', spotifyUrl: 'https://open.spotify.com/track/BBB222' }
        }
    });
    await flush();
    assert(stepCalls === 1, 'provider fast-path does not override repeat-one semantics');

    console.log('AUDIOFLIX_BACKGROUND_QUEUE_SMOKE_OK');
})().catch((error) => {
    console.error(error?.stack || error?.message || String(error));
    process.exit(1);
});