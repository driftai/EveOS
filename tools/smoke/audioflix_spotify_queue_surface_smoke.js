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
const RESULT_DIR = path.join(ROOT, 'data/runtime/smoke-results');
let phase = 'vm', passed = 0, browserEvidence = null;

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
let activeTrack = providerTrack, paused = false;
const volumes = [], persisted = [], replays = [], presentedVolumes = [];

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
    setVolume(value) { presentedVolumes.push(value); },
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
        item: activeTrack,
        playback: { item: activeTrack, currentTime: 12, duration: 180, paused }
    })
};
const audio = {
    ready: true,
    async openInternalView() { internalOpenCount += 1; return true; },
    async pause() { return true; },
    async playItem(item) { replays.push(item.id); return true; },
    async seek() { return true; },
    async stopAll() { return true; },
    updateItemVolume(id, value) { volumes.push({ id, value }); }
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
    EveAudioflixState: { setItemVolume(type, id, value) { persisted.push({ type, id, value }); } },
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

async function browserPhase() {
    const { chromium } = require('playwright');
    const browser = await chromium.launch({ headless: true });
    let page;
    const errors = [], requests = [];
    try {
        const browserContext = await browser.newContext({ viewport: { width: 1200, height: 1000 } });
        // Fulfill every request locally; the mirror never contacts Spotify or localhost services.
        await browserContext.route('**/*', route => {
            requests.push(route.request().url());
            return route.fulfill({ contentType: 'text/html', body: '<!doctype html><title>Mock mirror</title>' });
        });
        page = await browserContext.newPage();
        page.setDefaultTimeout(5000);
        page.on('pageerror', error => errors.push({ kind: 'page', message: String(error) }));
        page.on('console', message => {
            if (['error', 'warning'].includes(message.type())) errors.push({ kind: message.type(), message: message.text() });
        });
        await page.goto('http://127.0.0.1:8765/queue-surface-fixture');
        await page.setContent(`<style>
            body { margin: 20px; font: 14px sans-serif; }
            .audioflix-provider-stage { width: 850px; }
            .audioflix-provider-frame iframe { width: 800px; height: 100px; }
            .audioflix-provider-volume { width: 320px; }
        </style>`);
        await page.evaluate(track => {
            const tracks = [0.64, 0.27, 0.82].map((volume, index) => ({
                ...track, id: `spotify-${index + 1}`, title: `Provider linked ${['one', 'two', 'three'][index]}`, volume
            }));
            const fixture = window.__surfaceSmoke = {
                tracks, index: 0, paused: false, opens: 0, volumes: [], persisted: [], pauses: [], replays: []
            };
            const item = () => tracks[fixture.index];
            const playback = () => ({ item: item(), currentTime: 12, duration: 180, paused: fixture.paused });
            const emit = name => window.dispatchEvent(new CustomEvent(name, { detail: playback() }));
            fixture.advance = (index, publish = true) => {
                fixture.index = index; fixture.paused = false;
                if (publish) emit('eve:audioflix-playback');
            };
            fixture.progress = () => emit('eve:audioflix-progress');
            window.EveAudioflixSpotifyRemote = {
                snapshot: () => ({ connected: true, base: 'http://127.0.0.1:8765',
                    lastState: { managed: { presentation: 'hidden' }, engine: { status: 'playing' } } }),
                send: async () => ({ ok: true })
            };
            window.EveAudioflixSpotifyAnyBrowser = {
                ready: true, snapshot: () => ({ active: true, item: item(), playback: playback() })
            };
            window.EveAudioflix = { queueConnection: {
                snapshot: () => ({ currentIndex: fixture.index, entries: tracks.map(({ id, title }) => ({ id, title })) }),
                step: delta => fixture.advance(fixture.index + delta), jump: index => fixture.advance(index)
            } };
            window.EveAudioflixState = { setItemVolume(type, id, value) {
                fixture.persisted.push({ type, id, value });
                tracks.find(track => track.id === id).volume = value;
            } };
            window.EveAudioflixAudio = {
                ready: true, openInternalView: async () => { fixture.opens++; return true; },
                updateItemVolume(id, value) { fixture.volumes.push({ id, value }); },
                async pause() { fixture.pauses.push(item().id); fixture.paused = true; fixture.progress(); },
                async playItem(next) { fixture.replays.push(next.id); fixture.paused = false; fixture.progress(); },
                seek: async () => true, stopAll: async () => true
            };
        }, providerTrack);
        await page.addScriptTag({ content: fs.readFileSync(path.join(ROOT,
            'js/modules/features/audioflix/audioflix.audio.internal.js'), 'utf8') });
        await page.addScriptTag({ content: source });
        const loaded = page.waitForEvent('framenavigated', {
            predicate: frame => frame.url().includes('/audioflix-spotify-engine.html')
        });
        await page.evaluate(() => window.EveAudioflixAudio.openInternalView(window.__surfaceSmoke.tracks[0]));
        await loaded;
        await page.evaluate(() => { window.__surfaceSmoke.frame = document.querySelector('iframe'); });
        const read = () => page.evaluate(() => {
            const f = window.__surfaceSmoke, input = document.querySelector('.audioflix-provider-volume');
            return { title: document.querySelector('.audioflix-provider-stage header strong').textContent,
                volume: Number(input.value), thumb: input.style.getPropertyValue('--volume'),
                snapshotId: window.EveAudioflixSpotifyEngineSurface.snapshot().item?.id,
                volumes: f.volumes, persisted: f.persisted, pauses: f.pauses, replays: f.replays,
                opens: f.opens, sameFrame: f.frame === document.querySelector('iframe') };
        });
        async function pointer(selector, fraction = 0.5) {
            const box = await page.locator(selector).boundingBox();
            assert.ok(box && box.width > 0 && box.height > 0, `browser: visible pointer target ${selector}`);
            await page.mouse.move(box.x + box.width * fraction, box.y + box.height / 2);
            await page.mouse.down(); await page.mouse.up();
        }
        async function volumeInput(index, fraction) {
            const before = await read();
            await pointer('.audioflix-provider-volume', fraction);
            const result = await read(), id = `spotify-${index + 1}`;
            assert.ok(result.volumes.length > before.volumes.length, 'browser: pointer emits a volume command');
            assert.ok(Math.abs(result.volume - fraction) < 0.04, 'browser: pointer moves the range thumb');
            assert.deepEqual(result.volumes.at(-1), { id, value: result.volume }, 'browser: volume targets current track');
            assert.deepEqual(result.persisted.at(-1), { type: 'music', id, value: result.volume },
                'browser: current track gain persists');
            assert.equal(result.thumb, `${result.volume * 100}%`, 'browser: thumb presentation matches input');
            return result;
        }
        let result = await read();
        assert.equal(result.title, 'Provider linked one');
        assert.equal(result.volume, 0.64);
        assert.equal(result.snapshotId, 'spotify-1');
        await volumeInput(0, 0.44);
        await page.evaluate(() => window.__surfaceSmoke.advance(1));
        result = await read();
        assert.equal(result.title, 'Provider linked two', 'browser: automatic transition updates title');
        assert.equal(result.volume, 0.27, 'browser: automatic transition mirrors new track gain');
        assert.equal(result.snapshotId, 'spotify-2');
        await volumeInput(1, 0.68);
        // Control input can arrive before the next playback/progress presentation event.
        await page.evaluate(() => window.__surfaceSmoke.advance(2, false));
        await volumeInput(2, 0.15);
        await page.evaluate(() => window.__surfaceSmoke.progress());
        result = await read();
        assert.equal(result.title, 'Provider linked three');
        assert.equal(result.snapshotId, 'spotify-3');
        assert.equal(result.volume, result.persisted.at(-1).value);
        await pointer('[data-url-player-action="toggle"]');
        result = await read();
        assert.equal(result.pauses.at(-1), 'spotify-3', 'browser: pause targets current track');
        await pointer('[data-url-player-action="toggle"]');
        result = await read();
        assert.deepEqual(result.replays, ['spotify-3'], 'browser: resume cannot replay the opening track');
        assert.equal(result.opens, 1, 'browser: advances do not reopen Queue View');
        assert.equal(result.sameFrame, true, 'browser: advances preserve the original mirror frame');
        assert.ok(requests.length && requests.every(url =>
            ['http://127.0.0.1:8765/queue-surface-fixture',
                'http://127.0.0.1:8765/audioflix-spotify-engine.html?surface=mirror'].includes(url)),
        'browser: all requests are the locally stubbed fixture or mirror');
        assert.deepEqual(errors, [], 'browser: no page or console errors');
        browserEvidence = { ...result, errors, requests };
    } catch (error) {
        browserEvidence = { errors, requests, state: await page?.evaluate(() => ({
            fixture: { ...window.__surfaceSmoke, frame: undefined },
            title: document.querySelector('.audioflix-provider-stage header strong')?.textContent,
            volume: document.querySelector('.audioflix-provider-volume')?.value
        })).catch(() => null) };
        fs.mkdirSync(RESULT_DIR, { recursive: true });
        await page?.screenshot({ path: path.join(RESULT_DIR, 'audioflix-spotify-queue-surface.png'), fullPage: true }).catch(() => {});
        throw error;
    } finally { await browser.close(); }
}

function saveResult(status, error) {
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    fs.writeFileSync(path.join(RESULT_DIR, 'audioflix-spotify-queue-surface.json'), JSON.stringify({
        status, passed, total: 2, phase, browser: browserEvidence, error: error ? String(error.stack || error) : null
    }, null, 2));
}

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

    // Automatic advance updates playback without reopening Queue View. Every control must follow
    // that same item, even before a progress event reaches the displayed mirror.
    activeTrack = { ...providerTrack, id: 'spotify-2', title: 'Provider linked two', volume: 0.27 };
    controllerOptions.onVolume(0.31);
    assert.deepEqual(volumes.at(-1), { id: 'spotify-2', value: 0.31 },
        'volume must target current managed playback, not the item that opened Queue View');
    assert.deepEqual(persisted.at(-1), { type: 'music', id: 'spotify-2', value: 0.31 },
        'the current track volume persists through the shared state path');
    listeners.get('eve:audioflix-progress')?.();
    assert.equal(window.EveAudioflixSpotifyEngineSurface.snapshot().item.id, 'spotify-2');
    assert.equal(presentedVolumes.at(-1), 0.27, 'mirror thumb follows the new track volume');
    assert.equal(mirrorMessages.at(-1).state.title, activeTrack.title);
    paused = true; await controllerOptions.onToggle();
    assert.equal(replays.at(-1), 'spotify-2', 'resume cannot replay the original Queue View track');
    assert.equal(internalOpenCount, 1, 'automatic advancement must not require reopening Queue View');

    assert.match(source, /queueConnection\(\)\?\.snapshot/);
    assert.match(source, /view\?\.setQueue\?\./);
    assert.match(source, /eve:audioflix-queue-changed/);
    passed++; phase = 'browser';
    await browserPhase(); passed++;
    saveResult('PASS');
    console.log('AUDIOFLIX_SPOTIFY_QUEUE_SURFACE_SMOKE_OK 2/2');
})().catch((error) => {
    saveResult('FAIL', error);
    console.error(`FAIL [audioflix-spotify-queue-surface:${phase}] ${String(error.stack || error).split('\n').slice(0, 6).join('\n')}`);
    process.exitCode = 1;
});
