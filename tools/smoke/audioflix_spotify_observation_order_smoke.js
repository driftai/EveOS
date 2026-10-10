'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ROOT = path.resolve(__dirname, '../..');
const read = name => fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix', name), 'utf8');
const flush = async () => { for (let i = 0; i < 6; i++) await new Promise(setImmediate); };
const id = '4cOdK2wGLETKBW3PvgPWqT';
const packet = (cursor, extra = {}) => ({ ok: true, isOwner: true, ownerEpoch: 1, engineEpoch: 1,
    trackGeneration: 5, managed: { helperReachable: true }, engine: { spotifyId: id, generation: 5,
        eventCursor: cursor, currentTime: 4, duration: 180, status: 'playing', paused: false }, ...extra });

async function relayOrdering(protocol) {
    let channel;
    const listeners = new Map(), commands = [], storage = new Map();
    const iframe = { setAttribute() {}, addEventListener() {}, remove() {}, contentWindow: { postMessage() {} } };
    const simpleStorage = { getItem: key => storage.get(key) || null,
        setItem: (key, value) => storage.set(key, String(value)), removeItem: key => storage.delete(key) };
    const window = { EveAudioflixState: { ensure: () => ({}) }, addEventListener: (key, fn) => listeners.set(key, fn),
        removeEventListener: key => listeners.delete(key) };
    const context = vm.createContext({ window, location: { protocol, origin: 'http://127.0.0.1:8765' },
        document: { visibilityState: 'hidden', addEventListener() {}, createElement: () => iframe,
            documentElement: { appendChild() {} } }, localStorage: simpleStorage, sessionStorage: simpleStorage,
        crypto: { randomUUID: () => 'fixture-document' }, URL, console, setTimeout, clearTimeout,
        setInterval: () => 1, clearInterval() {}, MessageChannel: class {
            constructor() { channel = this; this.port1 = { start() {}, close() {}, postMessage: value => commands.push(value) }; this.port2 = {}; }
        } });
    vm.runInContext(read('audioflix.spotify.status-watch.js'), context);
    vm.runInContext(read('audioflix.spotify.remote.js'), context);
    const remote = window.EveAudioflixSpotifyRemote;
    const ready = remote.connect();
    listeners.get('message')({ source: iframe.contentWindow, origin: 'http://127.0.0.1:8765',
        data: { type: 'eveos:spotify-relay-ready', protocolVersion: 1 } });
    channel.port1.onmessage({ data: { type: 'ready', clientId: 'fixture-client', mode: protocol === 'file:' ? 'file' : 'localhost' } });
    await ready;
    const oldRead = remote.status(); await flush();
    const pause = remote.send('pause'); await flush();
    const reply = (request, result) => channel.port1.onmessage({ data: { type: 'result', requestId: request.requestId, result } });
    const paused = packet(10); paused.engine = { ...paused.engine, status: 'paused', paused: true };
    reply(commands.find(value => value.command?.action === 'pause'), paused); await pause;
    reply(commands.find(value => value.command?.action === 'status'), packet(9)); await oldRead;
    try {
        assert.equal(remote.snapshot().lastState.engine.eventCursor, 10, 'late status cannot regress relay cache after Pause');
        assert.equal(remote.snapshot().lastState.engine.paused, true);
        channel.port1.onmessage({ data: { type: 'ready', clientId: 'replacement-client', mode: 'localhost' } });
        assert.equal(remote.snapshot().lastState, null, 'new relay grant cannot retain previous broker counters');
    } finally { remote.disconnect(); }
}

async function playbackOrdering() {
    let state = packet(1), observer, held;
    const events = [], calls = [];
    const remote = { ready: true, connect: async () => ({ connected: true }),
        snapshot: () => ({ connected: true, lastState: state }),
        status: () => new Promise(resolve => { held = resolve; }),
        async send(action) {
            calls.push(action);
            if (action === 'pause') state = { ...state, engine: { ...state.engine, eventCursor: 10, status: 'paused', paused: true } };
            if (action === 'seek') state = { ...state, engine: { ...state.engine, eventCursor: 12, currentTime: 0, ended: false, completionId: '' } };
            return state;
        } };
    const audio = { ready: true, playItem: async () => true, openInternalView: async () => true,
        pause: async () => true, seek: async () => true, stopAll: async () => true,
        stopItemLayers: async () => true, updateItemVolume() {}, getPlaybackState: () => ({}), getStatus: () => ({}) };
    const window = { EveAudioflixSpotifyRemote: remote, EveAudioflixAudio: audio,
        addEventListener() {}, dispatchEvent: event => events.push(event) };
    const context = vm.createContext({ window, console, document: { visibilityState: 'hidden', addEventListener() {},
        removeEventListener() {} }, setInterval: () => 1, clearInterval() {}, setTimeout, clearTimeout,
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options?.detail; } } });
    vm.runInContext(read('audioflix.spotify.volume.js'), context);
    vm.runInContext(read('audioflix.spotify.status-watch.js'), context);
    const create = window.EveAudioflixSpotifyStatusWatch.create;
    window.EveAudioflixSpotifyStatusWatch.create = options => { observer = create(options); return observer; };
    vm.runInContext(read('audioflix.spotify.any-browser.js'), context);
    try {
        await audio.playItem({ id: 'fixture-song', url: `https://open.spotify.com/track/${id}`, title: 'Fixture', volume: 1 });
        await flush();
        const oldRead = observer.progressOnce(); await audio.pause(); held(packet(9)); await oldRead;
        assert.equal(audio.getPlaybackState().paused, true, 'late same-generation Playing cannot undo confirmed Pause');
        const oldEnded = observer.progressOnce(); await audio.seek(0);
        const stale = packet(11); stale.engine = { ...stale.engine, status: 'ended', paused: true, ended: true, completionId: 'old:1' };
        held(stale); await oldEnded;
        assert.equal(events.filter(event => event.detail?.status === 'Ended').length, 0,
            'late same-generation completion cannot consume a newer Seek');
        const restarted = packet(0, { engineEpoch: 2, ownerEpoch: 2, isOwner: false, ownerClientId: '',
            engine: { generation: 0, currentTime: 0, duration: 0, paused: true, status: 'idle' } });
        const refresh = observer.progressOnce(); state = restarted; held(restarted); await refresh;
        assert(events.some(event => /engine restarted or became idle/.test(event.detail?.status || '')),
            'new helper epoch is not rejected because its generation starts at zero');
        assert.equal(calls.filter(action => action === 'play').length, 1, 'observation never starts playback');
        assert.equal(calls.filter(action => action === 'resume').length, 0);
    } finally { observer?.dispose?.(); observer?.stop(); }
}

(async () => {
    const results = [];
    for (const [name, run] of [['localhost-cache', () => relayOrdering('http:')],
        ['file-cache', () => relayOrdering('file:')], ['playback-order', playbackOrdering]]) {
        try { await run(); results.push({ name, ok: true }); }
        catch (error) { results.push({ name, ok: false, error: error.stack }); }
    }
    const artifact = path.join(ROOT, 'data/runtime/smoke-results/LAST-AUDIOFLIX-SPOTIFY-OBSERVATION-ORDER.json');
    fs.mkdirSync(path.dirname(artifact), { recursive: true }); fs.writeFileSync(artifact, JSON.stringify(results, null, 2));
    const failed = results.filter(result => !result.ok);
    if (failed.length) throw new Error(failed.map(result => `${result.name}: ${result.error.split('\n').slice(0, 5).join('\n')}`).join('\n') + `\nArtifact: ${artifact}`);
    console.log('AUDIOFLIX_SPOTIFY_OBSERVATION_ORDER_OK (localhost/file cache, Pause, Seek, helper restart)');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
