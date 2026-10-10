'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'data/runtime/smoke-results/audioflix-spotify-volume');
const phase = process.argv.includes('--baseline') ? 'baseline' : 'candidate';
const sources = ['audioflix.spotify.volume.js', 'audioflix.spotify.any-browser.js']
    .map(name => [name, fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix', name), 'utf8')]);
const turn = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const track = (id, uri = '1111111111111111111111') => ({
    id, title: id, sourceProvider: 'spotify', url: `https://open.spotify.com/track/${uri}`, volume: 0.5
});

function fixture({ delayMs = 0 } = {}) {
    const events = new Map(), calls = [], held = [], warnings = [];
    let lastState, engine = {}, ownerEpoch = 1, connected = true, owner = true, poll;
    let activeRequests = 0, maximumRequests = 0, helperOperations = 0, tail = Promise.resolve();
    const state = () => ({ ok: true, isOwner: owner, ownerEpoch, engineEpoch: 1,
        trackGeneration: engine.generation || 1, engine: { ...engine } });
    const remote = {
        ready: true, snapshot: () => ({ connected, lastState }),
        connect: async () => ({ connected }), status: async () => state(),
        send(action, payload = {}) {
            if (action === 'play') {
                engine = { spotifyId: payload.spotifyId, generation: (engine.generation || 0) + 1,
                    status: 'playing', paused: false, currentTime: 9, duration: 180 };
                lastState = state();
                return Promise.resolve(lastState);
            }
            if (action !== 'volume') return Promise.resolve(state());
            const entry = { payload: { ...payload }, result: state(), startedAt: performance.now() };
            calls.push(entry); activeRequests++;
            maximumRequests = Math.max(maximumRequests, activeRequests);
            const finish = (result = entry.result) => {
                helperOperations++; activeRequests--; entry.finishedAt = performance.now();
                lastState = result;
                return result;
            };
            if (!delayMs) return new Promise((resolve, reject) => held.push({
                entry, resolve: result => resolve(finish(result)),
                reject: error => { helperOperations++; activeRequests--; reject(error); }
            }));
            // Synthetic helper serialization: these are Windows Node timings, not Spotify latency.
            tail = tail.then(() => new Promise(resolve => setTimeout(() => resolve(finish()), delayMs)));
            return tail;
        }
    };
    const audio = {
        ready: true, playItem: async () => true, openInternalView: async () => true,
        pause: async () => true, seek: async () => true, stopAll: async () => true,
        stopItemLayers: async () => true, updateItemVolume() {},
        getPlaybackState: () => ({ item: null }), getStatus: () => ({})
    };
    const window = { EveAudioflixSpotifyRemote: remote, EveAudioflixAudio: audio,
        EveAudioflixOutputPort: { effective: raw => raw * 0.5 },
        addEventListener(name, fn) { events.set(name, [...(events.get(name) || []), fn]); },
        dispatchEvent() {} };
    const context = { window, Promise, setTimeout, clearTimeout,
        console: { warn: (...args) => warnings.push(args.join(' ')) },
        setInterval: fn => { poll = fn; return 1; }, clearInterval() {},
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } },
        document: { createElement: () => ({ style: {}, dataset: {}, append() {}, addEventListener() {} }),
            body: { appendChild() {} } } };
    vm.createContext(context);
    sources.forEach(([name, source]) => vm.runInContext(source, context, { filename: name }));
    return { window, audio, remote, calls, held, warnings,
        master() { (events.get('eve:audioflix-output-volume') || []).forEach(fn => fn()); },
        counts: () => ({ activeRequests, maximumRequests, helperOperations }),
        async drain() { while (held.length) { held.shift().resolve(); await turn(); } },
        async loseOwner() { owner = false; ownerEpoch++; lastState = state(); poll?.(); await turn(); },
        disconnect() { connected = false; },
        lane: () => window.EveAudioflixSpotifyAnyBrowser.volumeDiagnostics?.() };
}

async function benchmark() {
    const samples = [], counts = [];
    for (const burst of [50, 100]) for (let trial = 0; trial < 3; trial++) {
        const f = fixture({ delayMs: 2 });
        await f.audio.playItem(track('benchmark'));
        let finalAt = 0;
        for (let i = 0; i < burst; i++) {
            f.audio.updateItemVolume('benchmark', (i + 1) / burst);
            finalAt = performance.now();
        }
        while (!f.calls.at(-1)?.finishedAt || f.counts().activeRequests) {
            await new Promise(resolve => setTimeout(resolve, 5));
        }
        samples.push(f.calls.at(-1).finishedAt - finalAt);
        counts.push({ burst, trial, ...f.counts(), lane: f.lane() });
        assert.equal(f.calls.at(-1).payload.effectiveVolume, 0.5, 'benchmark delivers final effective gain');
    }
    const sorted = [...samples].sort((a, b) => a - b);
    return { synthetic: true, environment: { platform: process.platform, node: process.version },
        model: 'authorized relay stub; serialized helper with synthetic 2ms delay; no Spotify/profile/service access',
        latencyMs: { samples, p50: sorted[Math.floor((sorted.length - 1) * 0.5)],
            p95: sorted[Math.ceil((sorted.length - 1) * 0.95)], max: sorted.at(-1) },
        operations: counts };
}

async function regression() {
    const f = fixture();
    await f.audio.playItem(track('A'));
    f.audio.updateItemVolume('A', 0.1);
    for (let i = 0; i < 100; i++) f.audio.updateItemVolume('A', (i + 1) / 100);
    await turn();
    assert.equal(f.calls.length, 1, 'volume-burst-bounded: held A keeps exactly one in-flight relay call');
    assert.equal(f.lane().pending, 1, 'volume-burst-bounded: exactly one latest pending value');
    f.master();
    await f.drain();
    assert.equal(f.calls.length, 2, '100 slider inputs and master sync coalesce into A then latest C');
    assert.equal(f.calls.at(-1).payload.effectiveVolume, 0.5, 'final C delivered once with master gain applied once');
    assert.equal(f.counts().maximumRequests, 1, 'helper traffic stays single-flight');

    const switched = fixture();
    await switched.audio.playItem(track('old'));
    switched.audio.updateItemVolume('old', 0.1);
    switched.audio.updateItemVolume('old', 0.2);
    await turn();
    const old = switched.held.shift();
    await switched.audio.playItem(track('new')); // same URI, different playback run
    switched.audio.updateItemVolume('new', 0.3);
    switched.audio.updateItemVolume('new', 0.9);
    old.resolve({ ...old.entry.result, ok: false, reason: 'late old failure' });
    await turn();
    assert.equal(switched.calls.length, 2, 'track switch discards old pending B and preserves new latest C');
    assert.equal(switched.calls.at(-1).payload.effectiveVolume, 0.45);
    assert.equal(switched.calls.at(-1).payload.trackGeneration, 2, 'same URI new run carries current generation fence');
    assert.equal(switched.warnings.length, 0, 'old-run result cannot warn about replacement playback');
    await switched.drain();
    assert.equal(switched.audio.getPlaybackState().item.id, 'new');
    assert.equal(switched.audio.getPlaybackState().currentTime, 9, 'volume replies never overwrite progress');

    const owner = fixture();
    await owner.audio.playItem(track('owned'));
    owner.audio.updateItemVolume('owned', 0.1);
    owner.audio.updateItemVolume('owned', 0.8);
    await turn();
    await owner.loseOwner();
    await owner.drain();
    assert.equal(owner.calls.length, 1, 'pending volume is discarded after ownership transfer');
    owner.audio.updateItemVolume('owned', 0.9);
    assert.equal(owner.calls.length, 1, 'observer does not reacquire owner by moving volume');

    const stopped = fixture();
    await stopped.audio.playItem(track('stopped'));
    stopped.audio.updateItemVolume('stopped', 0.1);
    stopped.audio.updateItemVolume('stopped', 0.8);
    await turn();
    await stopped.audio.stopAll(); await stopped.drain();
    assert.equal(stopped.calls.length, 1, 'stop discards queued volume');
    const failed = fixture();
    await failed.audio.playItem(track('failed'));
    failed.audio.updateItemVolume('failed', 0.1); failed.audio.updateItemVolume('failed', 0.8);
    await turn();
    failed.held.shift().reject(new Error('synthetic helper failure')); await turn(); await failed.drain();
    assert.equal(failed.calls.length, 2, 'failed A still flushes latest C');
    assert.equal(failed.calls.at(-1).payload.effectiveVolume, 0.4);
    const returned = fixture();
    await returned.audio.playItem(track('returned'));
    returned.audio.updateItemVolume('returned', 0.1); await turn();
    returned.audio.updateItemVolume('returned', 0.8);
    returned.audio.updateItemVolume('returned', 0.1);
    returned.held.shift().reject(new Error('synthetic failed A')); await turn(); await returned.drain();
    assert.equal(returned.calls.length, 2, 'returning C to held A value still delivers C after A fails');
    assert.equal(returned.calls.at(-1).payload.effectiveVolume, 0.05);
    return { tests: 6, burst: f.counts(), sameUriTrackSwitch: switched.counts(),
        ownerTransfer: owner.counts(), stop: stopped.counts(), failedA: failed.counts(), returnedC: returned.counts() };
}

(async () => {
    fs.mkdirSync(OUT, { recursive: true });
    const evidence = { phase, recordedAt: new Date().toISOString(), benchmark: await benchmark() };
    fs.writeFileSync(path.join(OUT, `${phase}.json`), JSON.stringify(evidence, null, 2));
    try { evidence.regression = await regression(); }
    catch (error) { evidence.failure = { message: error.message, stack: error.stack };
        fs.writeFileSync(path.join(OUT, `${phase}.json`), JSON.stringify(evidence, null, 2)); throw error; }
    fs.writeFileSync(path.join(OUT, `${phase}.json`), JSON.stringify(evidence, null, 2));
    console.log('AUDIOFLIX_SPOTIFY_VOLUME_COALESCING_SMOKE_OK tests=6/6');
})().catch(error => { console.error(String(error.stack || error).split('\n').slice(0, 20).join('\n')); process.exitCode = 1; });
