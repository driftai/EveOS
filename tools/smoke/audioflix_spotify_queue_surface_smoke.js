'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(ROOT, 'js/modules/features/audioflix/audioflix.spotify.engine-surface.js'),
    'utf8'
);

const listeners = new Map();
const mirrorMessages = [];
const queueSets = [];
const steps = [];
const jumps = [];
let controllerOptions = null;
let internalOpenCount = 0;
let open = false;
let queueState = {
    groupName: 'Spotify queue',
    currentIndex: 0,
    entries: [
        { id: 'spotify-1', title: 'Provider linked one' },
        { id: 'spotify-2', title: 'Provider linked two' }
    ]
};
const providerTrack = {
    id: 'spotify-1', type: 'music', sourceProvider: 'spotify', title: 'Provider linked one',
    url: 'https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT'
};

const host = {
    children: [],
    replaceChildren() { this.children = []; },
    appendChild(node) { this.children.push(node); return node; }
};
const controller = {
    open() { open = true; return host; },
    hide() { open = false; },
    isOpen() { return open; },
    setStatus() {},
    setVisualVisible() {},
    sync() {},
    setQueue(entries, index) {
        queueSets.push({ entries: entries.map((entry) => ({ ...entry })), index });
    }
};
const remote = {
    snapshot: () => ({
        connected: true,
        base: 'http://127.0.0.1:8765',
        lastState: {
            managed: { presentation: 'hidden' },
            engine: { status: 'playing', currentTime: 12, duration: 180, paused: false }
        }
    }),
    async send() { return { ok: true }; }
};
const managed = {
    ready: true,
    snapshot: () => ({
        active: true,
        item: providerTrack,
        playback: { item: providerTrack, currentTime: 12, duration: 180, paused: false }
    })
};
const audio = {
    ready: true,
    async openInternalView() { internalOpenCount += 1; return true; },
    async pause() { return true; },
    async playItem() { return true; },
    async seek() { return true; },
    async stopAll() { return true; },
    updateItemVolume() {}
};
const queueConnection = {
    snapshot: () => ({ ...queueState, entries: queueState.entries.map((entry) => ({ ...entry })) }),
    step(delta) { steps.push(delta); return true; },
    jump(index) { jumps.push(index); return true; }
};

function node(tag) {
    const value = {
        tagName: tag.toUpperCase(), dataset: {}, style: {}, children: [], textContent: '',
        append(...children) { this.children.push(...children); },
        appendChild(child) { this.children.push(child); return child; },
        addEventListener() {},
        setAttribute() {},
        remove() {}
    };
    if (tag === 'iframe') {
        value.contentWindow = { postMessage(message) { mirrorMessages.push(message); } };
    }
    return value;
}

const window = {
    EveAudioflixSpotifyRemote: remote,
    EveAudioflixSpotifyAnyBrowser: managed,
    EveAudioflixAudio: audio,
    EveAudioflix: { queueConnection },
    EveAudioflixInternalPlayer: {
        createController(options) { controllerOptions = options; return controller; }
    },
    addEventListener(name, listener) { listeners.set(name, listener); }
};
window.window = window;
const context = {
    window,
    document: { createElement: node },
    console,
    URL,
    Number,
    String,
    Object,
    Array,
    Promise
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'audioflix.spotify.engine-surface.js' });

(async () => {
    assert.equal(window.EveAudioflixSpotifyEngineSurface.ready, true);
    await window.EveAudioflixAudio.openInternalView(providerTrack);
    assert.equal(internalOpenCount, 1, 'Spotify Internal View still delegates through the normal Audioflix open path');
    assert.ok(queueSets.length > 0, 'managed Spotify Internal Player receives the Audioflix queue');
    assert.deepEqual(queueSets.at(-1), { entries: queueState.entries, index: 0 },
        'provider-linked Spotify rows are mirrored into Queue View without localization');
    assert.equal(typeof controllerOptions?.onStep, 'function');
    assert.equal(typeof controllerOptions?.onJump, 'function');

    await controllerOptions.onStep(1);
    await controllerOptions.onJump(0);
    assert.deepEqual(steps, [1], 'Next/previous stays owned by the Audioflix queue bridge');
    assert.deepEqual(jumps, [0], 'Queue row jumps stay owned by the Audioflix queue bridge');

    queueState = {
        ...queueState,
        currentIndex: 1,
        entries: [...queueState.entries, { id: 'spotify-3', title: 'Provider linked three' }]
    };
    listeners.get('eve:audioflix-queue-changed')?.();
    assert.deepEqual(queueSets.at(-1), { entries: queueState.entries, index: 1 },
        'queue mutations resync the managed Spotify surface immediately');
    assert.ok(mirrorMessages.some((message) => message.type === 'eveos:spotify-engine-mirror-state'),
        'queue integration does not remove managed engine mirror state');

    assert.match(source, /queueConnection\(\)\?\.snapshot/);
    assert.match(source, /view\?\.setQueue\?\./);
    assert.match(source, /eve:audioflix-queue-changed/);
    console.log('AUDIOFLIX_SPOTIFY_QUEUE_SURFACE_SMOKE_OK');
})().catch((error) => { console.error(error); process.exit(1); });