'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const ROOT = path.resolve(__dirname, '../..');
const DIR = path.join(ROOT, 'js/modules/features/audioflix');
const ID = '4cOdK2wGLETKBW3PvgPWqT';
const uri = type => `spotify:${type}:${ID}`;
const artifact = path.join(ROOT, 'data/runtime/smoke-results/audioflix-spotify-media-playback.json');
let phase = 'engine-episode-load', checks = 0;
function load(context, name) {
    vm.runInContext(fs.readFileSync(path.join(DIR, name), 'utf8'), context, { filename: name });
}
function contextFor(window, document = {}) {
    const context = vm.createContext({ window, document, console, Promise, setTimeout, clearTimeout,
        setInterval: () => 1, clearInterval() {}, queueMicrotask,
        CustomEvent: class { constructor(type, options) { this.type = type; this.detail = options.detail; } } });
    if (fs.existsSync(path.join(DIR, 'audioflix.spotify.media.js'))) load(context, 'audioflix.spotify.media.js');
    return context;
}
function engineFixture(entityLoader = 'loadUri') {
    const calls = [], listeners = new Map();
    const controller = {
        addListener(name, listener) { listeners.set(name, [...(listeners.get(name) || []), listener]); },
        play() {}, resume() {}, restart() {}, pause() {}, seek() {},
        [entityLoader](value) { calls.push(['load', value]); }
    };
    const emit = (name, data = {}) => (listeners.get(name) || []).forEach(fn => fn({ data }));
    const window = {};
    const api = { createController(_mount, options, ready) {
        calls.push(['create', options.uri]); ready(controller); queueMicrotask(() => emit('ready'));
    } };
    const document = { scripts: [], documentElement: { dataset: {} }, getElementById: () => ({}),
        createElement: () => ({ addEventListener() {} }), head: { appendChild(script) {
            document.scripts.push(script); queueMicrotask(() => window.onSpotifyIframeApiReady(api));
        } } };
    const context = contextFor(window, document);
    load(context, 'audioflix.spotify.engine.js');
    return { engine: window.EveAudioflixSpotifyEngine, calls, emit, window };
}
async function engineCases(entityLoader) {
    const f = engineFixture(entityLoader), e = f.engine;
    await e.command('load', { spotifyId: ID, spotifyUri: uri('episode'), mediaType: 'episode', generation: 1, duration: 180 });
    assert.equal(f.calls[0][1], uri('episode'), 'episode loads its typed URI, never a track with the same ID');
    assert.equal(e.snapshot().spotifyUri, uri('episode'));
    assert.equal(e.snapshot().mediaType, 'episode'); checks++;
    await e.command('play'); f.emit('playback_started');
    f.emit('playback_update', { playingURI: uri('episode'), position: 1500, duration: 180000, isPaused: false });
    const cursor = e.snapshot().eventCursor;
    for (const playingURI of [uri('track'), `spotify:local:${ID}`, `spotify:episode:${ID}extra`]) {
        f.emit('playback_update', { playingURI, position: 180000, duration: 180000, isPaused: false });
        assert.equal(e.snapshot().eventCursor, cursor, 'other types/malformed identities cannot complete an episode');
    }
    checks++;
    assert.throws(() => e.acknowledgeMediaSeek({ spotifyId: ID, spotifyUri: uri('track'),
        mediaType: 'track', generation: 1, currentTime: 179 }), /playback changed/);
    assert.throws(() => e.acknowledgeMediaSeek({ spotifyId: ID, generation: 1, currentTime: 179 }), /playback changed/);
    e.acknowledgeMediaSeek({ spotifyId: ID, spotifyUri: uri('episode'), mediaType: 'episode',
        generation: 1, currentTime: 179, duration: 180 });
    f.emit('playback_update', { playingURI: uri('episode'), position: 0, duration: 180000, isPaused: true });
    assert.equal(e.snapshot().status, 'ended'); checks++;
    const completion = e.snapshot().completionId;
    f.emit('playback_update', { playingURI: uri('episode'), position: 0, duration: 180000, isPaused: true });
    assert.equal(e.snapshot().completionId, completion, 'episode completion stays durable and singular');
    await e.command('load', { spotifyUri: uri('episode'), generation: 2 });
    await e.command('play'); f.emit('playback_started');
    f.emit('playback_update', { playingURI: uri('episode'), position: 180000, duration: 180000, isPaused: false });
    assert.equal(e.snapshot().ended, false, 'same-episode replay rejects stale tail until fresh progress');
    f.emit('playback_update', { playingURI: uri('episode'), position: 1000, duration: 180000, isPaused: false });
    assert.equal(e.snapshot().status, 'playing'); checks++;
    await e.command('load', { spotifyUri: uri('track'), generation: 3 });
    assert.equal(f.calls.at(-1)[1], uri('track'), 'type change with identical ID navigates the controller');
    assert.equal(e.snapshot().mediaType, 'track');
    const before = e.snapshot();
    for (const payload of [{ spotifyId: ID, mediaType: 'local' },
        { spotifyId: ID, spotifyUri: uri('episode'), mediaType: 'track' },
        { spotifyId: ID, spotifyUri: 'spotify:episode:invalid' }]) {
        await assert.rejects(e.command('load', payload), /valid Spotify/);
        assert.equal(e.snapshot().generation, before.generation, 'rejected identity cannot mutate playback generation');
    }
    await e.command('load', { spotifyId: ID, generation: 4 });
    assert.equal(e.snapshot().spotifyUri, uri('track'), 'legacy bare IDs remain tracks only'); checks++;
}
function anyBrowserFixture() {
    const calls = [], events = [], listeners = new Map(), local = new Set();
    let engine = {}, lastState = null, original = 0, poll = null;
    const state = () => ({ ok: true, isOwner: true, ownerEpoch: 1, engineEpoch: 1, engine: { ...engine } });
    const remote = { ready: true, snapshot: () => ({ connected: true, lastState }),
        connect: async () => ({ connected: true }), status: async () => state(),
        async send(action, payload = {}) {
            calls.push({ action, payload: { ...payload } });
            if (action === 'play') engine = { ...payload, generation: (engine.generation || 0) + 1,
                status: 'playing', paused: false, currentTime: 1, completionId: '', eventCursor: 1 };
            if (action === 'pause') engine.paused = true;
            if (action === 'stop') engine.status = 'stopped';
            return lastState = state();
        } };
    const audio = { ready: true, playItem: async () => { original++; return true; },
        openInternalView: async () => { original++; return true; }, pause: async () => true, resume: async () => true, seek: async () => true,
        stopAll: async () => true, stopItemLayers: async () => true, updateItemVolume() {},
        getPlaybackState: () => ({ item: null }), getStatus: () => ({}) };
    const window = { EveAudioflixAudio: audio, EveAudioflixSpotifyRemote: remote,
        EveAudioflixSpotifyNativeCapture: { configure() {}, ensure: async () => false,
            bind() {}, clear() {}, guard: () => true, status: () => ({}) },
        EveAudioflixSpotifyPlaybackLifecycle: { create: () => ({ ensureObserver: () => null }) },
        EveAudioflixLocalPlayback: { prepare: async item => local.has(item.id)
            ? { item: { ...item, url: 'blob:verified-local' }, localPath: 'C:\\test\\song.mp3' } : null },
        addEventListener(name, fn) { listeners.set(name, fn); }, dispatchEvent(event) { events.push(event); } };
    const context = contextFor(window);
    context.setInterval = fn => { poll = fn; return 1; };
    load(context, 'audioflix.spotify.volume.js'); load(context, 'audioflix.spotify.any-browser.js');
    return { audio, calls, events, local, window, context, remote, original: () => original,
        async update(patch) { engine = { ...engine, ...patch }; poll(); for (let i = 0; i < 10; i++) await Promise.resolve(); },
        async turns() { for (let i = 0; i < 10; i++) await Promise.resolve(); } };
}
async function anyBrowserCases() {
    const f = anyBrowserFixture();
    const episode = { id: 'media', title: 'Episode', type: 'music', sourceProvider: 'spotify',
        sourceMediaType: 'episode', sourceMediaId: ID, sourceUri: uri('episode'), volume: 0.4 };
    await f.audio.playItem(episode);
    assert.equal(f.original(), 0, 'metadata episode routes through managed playback without a fabricated URL');
    assert.equal(f.calls.find(c => c.action === 'play').payload.spotifyUri, uri('episode')); checks++;
    f.audio.updateItemVolume('media', 0.3); await f.turns();
    const volume = f.calls.find(c => c.action === 'volume').payload;
    assert.equal(volume.spotifyUri, uri('episode')); assert.equal(volume.mediaType, 'episode'); checks++;
    const ended = () => f.events.filter(event => event.detail.status === 'Ended').length;
    await f.update({ spotifyUri: uri('track'), mediaType: 'track', status: 'ended', ended: true, completionId: 'wrong' });
    assert.equal(ended(), 0, 'same-ID track status cannot finish active episode');
    await f.update({ spotifyUri: uri('episode'), mediaType: 'episode', completionId: 'episode-end' });
    assert.equal(ended(), 1); await f.update({}); assert.equal(ended(), 1); checks++;
    await f.audio.playItem(episode);
    const plays = () => f.calls.filter(c => c.action === 'play').length;
    const before = plays();
    await f.audio.playItem({ ...episode, sourceMediaType: 'track', sourceUri: uri('track') });
    assert.equal(plays(), before + 1, 'same card ID with a changed media namespace starts the new entity'); checks++;
    const remoteBefore = plays();
    await f.audio.playItem({ ...episode, id: 'metadata-local', sourceMediaType: 'local', sourceUri: `spotify:local:${ID}` });
    assert.equal(plays(), remoteBefore, 'Spotify-local metadata never issues a remote play');
    f.local.add('localized');
    await f.audio.playItem({ ...episode, id: 'localized', localPath: 'C:\\test\\song.mp3' });
    assert.equal(plays(), remoteBefore, 'verified local file keeps normal local routing'); checks++;
    for (const reportedType of ['track', 'episode', 'legacy']) {
        const slow = anyBrowserFixture();
        let now = 0;
        slow.context.Date = { now: () => now += 30000 };
        slow.remote.send = async () => ({ ok: false, timeout: true });
        slow.remote.status = async () => ({ ok: true, isOwner: true,
            engine: { spotifyId: ID, ...(reportedType === 'legacy' ? {} : {
                spotifyUri: uri(reportedType), mediaType: reportedType }), status: 'playing', paused: false } });
        if (reportedType === 'episode') assert.equal(await slow.audio.playItem(episode), true, 'typed episode slow start can be adopted');
        else await assert.rejects(slow.audio.playItem(episode), /too long/, 'track-only legacy state cannot be adopted as an episode');
        checks++;
    }
}
function parserCases() {
    const m = contextFor({}).window.EveAudioflixSpotifyMedia;
    for (const type of ['track', 'episode']) {
        for (const value of [uri(type), `https://open.spotify.com/${type}/${ID}?si=x`,
            `https://open.spotify.com/embed/${type}/${ID}`, `https://open.spotify.com/intl-en/${type}/${ID}`]) {
            assert.equal(m.parse(value).spotifyUri, uri(type));
        }
        assert.equal(m.fromItem({ sourceProvider: 'spotify', sourceMediaType: type, sourceMediaId: ID }).spotifyUri, uri(type));
    }
    assert.equal(m.parse(ID).mediaType, 'track');
    assert.equal(m.trackId(uri('episode')), '');
    for (const value of [`https://open.spotify.com.evil/episode/${ID}`, `before${uri('episode')}`,
        `${uri('episode')}suffix`, 'spotify:local:Artist:Album:Title:0', `https://example.com/${ID}`]) assert.equal(m.parse(value), null);
    assert.equal(m.fromPayload({ spotifyUri: uri('episode'), spotifyId: '1111111111111111111111' }), null);
    assert.equal(m.fromPayload({ spotifyUri: uri('episode'), mediaType: 'track' }), null);
    assert.equal(m.fromPayload({ spotifyId: ID, mediaType: 'episode' }).spotifyUri, uri('episode'), 'explicit namespace plus ID is a typed identity');
    assert.equal(m.fromPayload({ spotifyId: ID }).spotifyUri, uri('track'), 'untyped bare IDs are legacy tracks only');
    assert.equal(m.fromPayload({ spotifyUri: uri('episode'), uri: uri('track') }), null);
    assert.equal(m.fromItem({ sourceMediaType: 'local', sourceUri: uri('track') }), null);
    assert.equal(m.fromItem({ sourceMediaType: 'episode', url: `https://open.spotify.com/track/${ID}` }), null);
    assert.equal(m.fromItem({ sourceMediaType: 'episode', sourceUri: uri('episode'), url: `https://open.spotify.com/track/${ID}` }), null);
    assert.equal(m.fromItem({ sourceProvider: 'direct', url: ID }), null, 'ordinary 22-character labels cannot be guessed into Spotify');
    checks++;
}
async function fallbackCases() {
    const f = engineFixture(), events = [], view = { playback: {}, active: null };
    const window = f.window;
    window.EveAudioflixSpotifyCompletion = { itemDurationMs: () => 0 };
    const listeners = new Map(), calls = [];
    const player = { addListener: (name, fn) => listeners.set(name, fn), play() {}, pause() {}, seek() {},
        loadUri: value => calls.push(value) };
    const document = { scripts: [], createElement: () => ({ addEventListener() {} }),
        head: { appendChild: () => queueMicrotask(() => window.onSpotifyIframeApiReady({ createController(_mount, options, ready) {
            calls.push(options.uri); ready(player); queueMicrotask(() => listeners.get('ready')());
        } })) } };
    const context = contextFor(window, document);
    load(context, 'audioflix.audio.url.spotify.js');
    const adapter = window.EveAudioflixSpotifyPlayback.create({ view, ensureStage: () => ({ appendChild() {} }),
        setStageStatus() {}, emitPlayback: value => events.push(value), emitProgress() {} });
    const episode = { id: 'fallback', title: 'Episode', url: `https://open.spotify.com/episode/${ID}` };
    await adapter.playSpotify(episode);
    assert.equal(calls[0], uri('episode'), 'provider fallback creates an episode controller');
    listeners.get('playback_started')({ data: { playingURI: uri('track') } });
    assert.equal(events.length, 0, 'fallback ignores wrong-type startup identity');
    listeners.get('playback_update')({ data: { playingURI: uri('track'), position: 180000, duration: 180000, isPaused: false } });
    assert.equal(events.length, 0, 'fallback ignores same-ID track completion');
    await view.active.player.loadItem({ ...episode, url: `https://open.spotify.com/track/${ID}` });
    assert.equal(calls.at(-1), uri('track'), 'fallback switches typed identity without manufacturing track IDs');
    view.active.player.destroy(); checks++;
}
async function preparationCases() {
    const window = {}, context = contextFor(window);
    load(context, 'audioflix.state.schema.js');
    load(context, 'audioflix.playlists.spotify.js');
    load(context, 'audioflix.audio.source.js');
    load(context, 'audioflix.native.spotify.js');
    let resolverCalls = 0;
    window.EveAudioflixNative = { resolveUrl: () => { resolverCalls++; throw Error('Unexpected episode resolver'); } };
    const episode = { id: 'prepared-episode', title: 'Episode', url: `https://open.spotify.com/episode/${ID}`,
        ...window.EveAudioflixSpotify.entryPatch({ id: ID, uri: uri('episode'), mediaType: 'episode' }) };
    assert.equal(window.EveAudioflixAudioSource.needsResolution(episode.url), false, 'Episode embeds never enter yt-dlp');
    const resolved = await window.EveAudioflixAudioSource.resolveItem(episode);
    assert.equal(resolverCalls, 0);
    const prepared = await window.EveAudioflixNativeSpotify.preparePlaybackSource(resolved);
    assert.equal(prepared.item.url, episode.url);
    assert.equal(prepared.item.sourceUri, uri('episode'));
    assert.equal(prepared.item.spotifyPlaybackMode, 'official-embed'); checks++;
    const identity = window.EveAudioflixStateSchema.mediaIdentity(episode);
    assert.equal(identity.sourcePlayable, true);
    assert.equal(identity.sourceAvailability, 'playable');
    assert.equal(window.EveAudioflixStateSchema.mediaIdentity({ ...episode, sourceAvailability: 'unavailable' }).sourcePlayable, false);
    assert.equal(window.EveAudioflixStateSchema.mediaIdentity({ sourceProvider: 'spotify', sourceMediaType: 'local', sourceUri: 'spotify:local:a:b:c:5' }).sourcePlayable, false);
    assert.equal(episode.spotifyTrackId, '', 'Imported episode never fills a legacy track ID'); checks++;
    const local = { ...episode, localPath: 'C:/Music/episode.mp3' };
    const localPrepared = { item: local, localPath: local.localPath };
    assert.equal(await window.EveAudioflixNativeSpotify.preparePlaybackSource(local, localPrepared), localPrepared);
    checks++;
}
(async () => {
    await engineCases('loadUri'); await engineCases('loadEntity');
    phase = 'strict-parser-contract'; parserCases();
    phase = 'any-browser-identity-volume-completion'; await anyBrowserCases();
    phase = 'official-embed-fallback'; await fallbackCases();
    phase = 'episode-source-preparation'; await preparationCases();
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify({ ok: true, checks, phase, synthetic: true }));
    console.log(`AUDIOFLIX_SPOTIFY_MEDIA_PLAYBACK_OK checks=${checks} typedUri=true episode=true legacyTrack=true`);
})().catch(error => {
    fs.mkdirSync(path.dirname(artifact), { recursive: true });
    fs.writeFileSync(artifact, JSON.stringify({ ok: false, phase, checks, error: { message: error.message, stack: error.stack } }));
    console.error(`AUDIOFLIX_SPOTIFY_MEDIA_PLAYBACK_FAILED phase=${phase}: ${error.message}`); process.exitCode = 1;
});
