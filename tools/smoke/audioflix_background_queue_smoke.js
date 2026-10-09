#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..', '..');
function assert(condition, message) {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

async function flush() {
    await Promise.resolve();
    await Promise.resolve();
    await new Promise((resolve) => setImmediate(resolve));
}

async function completionCoverage() {
    const queueState = {
        groupName: 'Spotify Group',
        currentIndex: 0,
        playbackRunId: 1,
        isPlaying: true,
        repeatOne: false,
        entries: [
            { id: 101, title: 'First Spotify track' },
            { id: '202', title: 'Second Spotify track' },
            { id: '303', title: 'Third Spotify track' }
        ]
    };
    let stepCalls = 0, restartCalls = 0;

    const window = {
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
                    queueState.playbackRunId += 1;
                    return Promise.resolve(true);
                }
            }
        }
    };
    window.window = window;

    const context = vm.createContext({
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
    const completionSource = fs.readFileSync(path.join(ROOT,
        'js/modules/features/audioflix/audioflix.queue.completion.js'), 'utf8');
    vm.runInContext(completionSource, context);
    const bridge = window.EveAudioflix.queueConnection;
    bridge.complete = window.EveAudioflixQueueCompletion.create({
        snapshot: () => bridge.snapshot(), advance: () => bridge.step(1),
        restart: () => { restartCalls += 1; queueState.playbackRunId += 1; }
    });
    assert(typeof bridge.complete === 'function', 'one canonical completion owner handles all providers');
    const onPlayback = event => bridge.complete(event.detail);

    // Normal Spotify playback now resolves onto an Eve-owned provider (usually YouTube). Preserve
    // the queue ownership by provenance instead of requiring the terminal provider name to be Spotify.
    onPlayback({
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
    onPlayback({
        detail: {
            status: 'Ended',
            browserOnly: true,
            provider: 'youtube',
            item: { id: 101, sourceProvider: 'spotify', spotifyUrl: 'https://open.spotify.com/track/AAA111' }
        }
    });
    await flush();
    assert(stepCalls === 1, 'duplicate/stale resolved Spotify Ended cannot advance a second time');

    // Repeat-one uses the same owner and consumes completion instead of also advancing.
    queueState.currentIndex = 1;
    queueState.repeatOne = true;
    onPlayback({
        detail: {
            status: 'Ended',
            browserOnly: true,
            provider: 'youtube',
            item: { id: 202, sourceProvider: 'spotify', spotifyUrl: 'https://open.spotify.com/track/BBB222' }
        }
    });
    await flush();
    assert(stepCalls === 1 && restartCalls === 1, 'provider completion preserves repeat-one without advancing');

}

// Presentation factories are inert, but group actions, queue transitions, every completion
// consumer, and the URL controller are production code. The transport replaces media input
// only; no user storage, provider account, profile, or localhost service is touched.
function realQueueFixture(count = 20, options = {}) {
    const listeners = new Map(), players = [], starts = [], events = [];
    const music = Array.from({ length: count }, (_, index) => ({
        id: index + 101, title: `Track ${index + 1}`, type: 'music', url: `data:audio/wav,${index}`
    }));
    const snapshot = { music, soundboard: [], musicGroups: ['Smoke Group'], musicGroupMap: {} };
    let actions, controller, queueBridge, drainResolve, failId = '';
    const capture = {
        start: async () => true,
        stop: async value => value?.drain && drainResolve ? new Promise(resolve => {
            const prior = drainResolve;
            drainResolve = () => { prior(); resolve(true); };
        }) : false
    };
    const window = {
        location: { protocol: 'file:', href: 'file:///EveOS.html', origin: 'null' },
        addEventListener(type, listener) {
            if (!listeners.has(type)) listeners.set(type, []);
            listeners.get(type).push(listener);
        },
        dispatchEvent(event) {
            if (event.type === 'eve:audioflix-playback') events.push(event.detail);
            for (const listener of listeners.get(event.type) || []) listener(event);
            return true;
        },
        EveAudioflixState: { ensure: () => snapshot },
        EveAudioflixNative: { shouldSuppressBrowserPlayback: () => options.capture === true },
        EveAudioflixUiShared: { ready: true, shuffleQueue: ids => [...ids].reverse() },
        EveAudioflixUrlLoaders: { loadScript: async () => {}, loadYouTubeApi: async () => {} },
        EveAudioflixUrlWidgets: { create: () => ({}) },
        EveAudioflixInternalPlayer: { createController: () => ({
            sync() {}, hide() {}, setVolume() {}, setRate() {}, setQueue() {}, isOpen: () => false
        }) }
    };
    window.window = window;
    for (const name of ['UiLocalize', 'NexusUi', 'ClassifiersUi', 'UiModal', 'UiPicker',
        'UiManagers', 'UiHotkeys']) window[`EveAudioflix${name}`] = { create: () => ({}) };
    window.EveAudioflixUiToolbar = { create: () => () => '' };
    window.EveAudioflixUiRender = { create: () => ({
        frontendActiveGroup: () => ({ name: 'Smoke Group', items: music, activeGroup: 'Smoke Group' })
    }) };
    for (const name of ['Localize', 'Nexus', 'Routing']) {
        window[`EveAudioflixUiActions${name}`] = { create: () => async () => false };
    }
    window.EveAudioflixUiForms = { create: () => () => {} };
    const document = { addEventListener() {}, querySelectorAll: () => [], querySelector: () => null };
    class FakeAudio {
        constructor() {
            this.listeners = new Map(); this.paused = true; this.currentTime = 0;
            this.duration = 60; players.push(this);
        }
        addEventListener(type, listener) {
            if (!this.listeners.has(type)) this.listeners.set(type, []);
            this.listeners.get(type).push(listener);
        }
        emit(type) { for (const listener of this.listeners.get(type) || []) listener(); }
        async play() {
            if (failId === '*' || String(controller.getPlaybackState().item?.id) === String(failId)) throw new Error('Fixture start failure');
            this.paused = false; this.emit('play');
        }
        pause() { this.paused = true; this.emit('pause'); }
        end() { this.currentTime = this.duration; this.paused = true; this.emit('ended'); }
        removeAttribute() {}
    }
    const context = vm.createContext({ window, document, location: window.location, Audio: FakeAudio,
        CustomEvent: class { constructor(type, value) { this.type = type; this.detail = value.detail; } },
        Promise, String, Number, Math, URL, setTimeout, clearTimeout, setInterval, clearInterval,
        console: { ...console, info() {} } });
    function load(name) {
        const filename = path.join(ROOT, 'js/modules/features/audioflix', name);
        vm.runInContext(fs.readFileSync(filename, 'utf8'), context, { filename });
    }
    load('audioflix.audio.url.providers.js');
    load('audioflix.audio.url.direct.js');
    load('audioflix.audio.url.js');
    controller = window.EveAudioflixUrlPlayback.createController({
        onPlayback: detail => window.dispatchEvent({ type: 'eve:audioflix-playback', detail })
    });
    async function start(item, internal = false) {
        starts.push(item.id);
        return internal ? controller.openInternalView(item) : controller.play(item);
    }
    window.EveAudioflixAudio = {
        playItem: item => start(item), openInternalView: item => start(item, true),
        getPlaybackState: () => controller.getPlaybackState(), getMusicCapture: () => capture,
        isInternalViewOpen: () => false, setQueueBridge: bridge => { queueBridge = bridge; },
        syncQueueView: () => controller.setQueue(queueBridge?.list?.(), queueBridge?.index?.()),
        seek: seconds => controller.seek(seconds), stopAll: () => controller.stop()
    };
    load('audioflix.ui.actions.js');
    const create = window.EveAudioflixUiActions.create;
    window.EveAudioflixUiActions.create = ctx => { actions = create(ctx); return actions; };
    load('audioflix.ui.overlay.js');
    load('audioflix.queue.completion.js');
    load('audioflix.ui.js');
    load('audioflix.transport.resilience.js');
    return {
        window, music, players, starts, events,
        queue: () => window.EveAudioflix.queueConnection.snapshot(),
        action: name => actions.handleAction({ dataset: { afAction: name } }, {}),
        emit: detail => window.dispatchEvent({ type: 'eve:audioflix-playback', detail }),
        fail: id => { failId = id; }, holdDrain: () => { drainResolve = () => {}; },
        resolveDrain: () => { const resolve = drainResolve; drainResolve = null; resolve?.(); }
    };
}

async function settled() {
    await flush();
    await new Promise(resolve => setTimeout(resolve, 15));
    await flush();
}

async function longGroupCoverage() {
    const fixture = realQueueFixture();
    await fixture.action('play-music-group');
    assert(fixture.queue().currentIndex === 0 && fixture.starts.length === 1,
        'plain Play Group starts one track without creating Queue View');
    for (let index = 0; index < 20; index += 1) {
        const detail = { status: 'Ended', browserOnly: true, provider: 'youtube',
            item: { ...fixture.music[index], id: String(fixture.music[index].id), sourceProvider: 'spotify' } };
        fixture.players.at(-1).end();
        fixture.emit(detail); fixture.emit(detail);
        await settled();
        assert(fixture.starts.length === Math.min(index + 2, 20),
            `plain group completion #${index + 1} starts exactly one successor`);
        const before = fixture.queue();
        fixture.emit(detail);
        await settled();
        assert(fixture.queue().currentIndex === before.currentIndex && fixture.starts.length === Math.min(index + 2, 20),
            `late nonmatching completion #${index + 1} cannot skip a successor`);
    }
    assert(fixture.queue().isPlaying === false, '20-track group finishes coherently without a #7 threshold');
}

async function staleTransportCoverage() {
    const fixture = realQueueFixture(3);
    await fixture.action('play-music-group');
    const oldPlayer = fixture.players[0];
    await fixture.window.EveAudioflix.queueConnection.jump(1);
    oldPlayer.end();
    await settled();
    const ended = fixture.events.findLast(event => event.status === 'Ended');
    assert(!ended || ended.item?.id === fixture.music[0].id,
        'an old transport is ignored or reports its own finishing identity');
    assert(fixture.queue().currentIndex === 1 && fixture.starts.length === 2,
        'late old transport completion cannot skip the actively playing successor');
}

async function captureSettlementCoverage() {
    const fixture = realQueueFixture(3, { capture: true });
    await fixture.action('play-music-group');
    fixture.holdDrain();
    fixture.players[0].end();
    try {
        await settled();
        assert(fixture.queue().currentIndex === 0 && fixture.starts.length === 1,
            'direct URL completion holds queue handoff until native capture drain settles');
    } finally { fixture.resolveDrain(); }
    await settled();
    assert(fixture.queue().currentIndex === 1 && fixture.starts.length === 2,
        'settled native capture starts exactly one successor');
}

async function failedStartCoverage() {
    const fixture = realQueueFixture(20);
    await fixture.action('play-music-group');
    fixture.fail(fixture.music[6].id);
    for (let index = 0; index < 6; index += 1) {
        fixture.players.at(-1).end();
        await settled();
    }
    assert(fixture.queue().currentIndex === 7 && fixture.queue().isPlaying === true
        && fixture.window.EveAudioflixAudio.getPlaybackState().item?.id === fixture.music[7].id
        && fixture.window.EveAudioflixAudio.getPlaybackState().paused === false && fixture.starts.length === 8,
        'a failed seventh transport start advances once to the playable eighth track');
}

async function exhaustedStartCoverage() {
    const fixture = realQueueFixture(20);
    fixture.fail('*');
    await fixture.action('play-music-group');
    await settled();
    assert(fixture.starts.length === 20 && fixture.queue().isPlaying === false,
        '20 failed starts stop once after one bounded pass instead of cycling or claiming playback');
}

(async () => {
    const cases = [ ['spotify-provenance-completion', completionCoverage], ['plain-group-20-track-once', longGroupCoverage],
        ['stale-url-transport-identity', staleTransportCoverage], ['url-capture-settlement', captureSettlementCoverage],
        ['failed-transport-start-state', failedStartCoverage], ['failed-starts-bounded-exhaustion', exhaustedStartCoverage] ];
    const failures = [];
    for (const [id, run] of cases) {
        try { await run(); } catch (error) { failures.push({ id, message: String(error.stack || error) }); }
    }
    if (failures.length) {
        const directory = path.join(ROOT, 'data/runtime/smoke-results');
        fs.mkdirSync(directory, { recursive: true });
        fs.writeFileSync(path.join(directory, 'audioflix-background-queue.json'), JSON.stringify({
            status: 'FAIL', total: cases.length, passed: cases.length - failures.length, failures,
            evidence: 'real UI queue/actions/URL modules; simulated transport and inert presentation; no live provider proof'
        }, null, 2));
        for (const failure of failures) console.error(`FAIL [${failure.id}] ${failure.message.split('\n').slice(0, 4).join('\n')}`);
        process.exitCode = 1;
    } else console.log(`AUDIOFLIX_BACKGROUND_QUEUE_SMOKE_OK ${cases.length}/${cases.length}`);
})().catch(error => { console.error(String(error.stack || error).split('\n').slice(0, 8).join('\n')); process.exitCode = 1; });
