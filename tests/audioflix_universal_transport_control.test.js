'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const RESILIENCE = fs.readFileSync(
    path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.transport.resilience.js'),
    'utf8'
);
const WATCHFUSION = fs.readFileSync(
    path.join(ROOT, 'js', 'modules', 'features', 'watchfusion', 'watchfusion.audioflix-link.js'),
    'utf8'
);

function harness({ browserOnly = true, provider = 'youtube', repeatOne = false } = {}) {
    const documentListeners = new Map();
    const windowListeners = new Map();
    const timers = [];
    const commands = [];
    const calls = { playItem: 0, pause: 0, seek: [], rate: [], updateVolume: [], persisted: [], step: 0, actions: [] };
    const queue = {
        groupName: 'Group',
        isPlaying: true,
        repeatOne,
        currentIndex: 0,
        entries: [{ id: 101, title: 'One' }, { id: '102', title: 'Two' }]
    };
    const playback = {
        item: { id: '101', type: 'music', title: 'One', volume: 1 },
        paused: true,
        currentTime: 73,
        duration: 180,
        browserOnly,
        provider
    };
    const directPlayer = {
        playCalls: 0,
        async play() { this.playCalls += 1; playback.paused = false; }
    };
    const frameWindow = {
        postMessage(message, origin) { commands.push({ message, origin }); }
    };
    const frame = {
        src: 'http://127.0.0.1:8765/server/audioflix-provider-host.html?provider=youtube&id=abcdefghijk&token=af-test',
        contentWindow: frameWindow
    };
    const document = {
        querySelectorAll(selector) {
            assert.equal(selector, '.audioflix-provider-frame iframe');
            return browserOnly ? [frame] : [];
        },
        addEventListener(name, listener) { documentListeners.set(name, listener); }
    };
    const window = {
        EveAudioflixTransportResilience: {},
        EveAudioflixAudio: {
            getPlaybackState: () => ({ ...playback, item: { ...playback.item } }),
            getWaveformController: () => ({ getActivePlayer: () => directPlayer }),
            async playItem() { calls.playItem += 1; return true; },
            async pause() { calls.pause += 1; playback.paused = true; },
            async seek(value) { calls.seek.push(value); playback.currentTime = value; return true; },
            setPlaybackRate(value) { calls.rate.push(value); return value; },
            updateItemVolume(id, value) { calls.updateVolume.push([id, value]); playback.item.volume = value; }
        },
        EveAudioflixState: {
            setItemVolume(type, id, value) { calls.persisted.push([type, id, value]); }
        },
        EveAudioflix: {
            queueConnection: {
                snapshot: () => ({ ...queue, entries: queue.entries.map((entry) => ({ ...entry })) }),
                step(delta) { calls.step += 1; queue.currentIndex += Number(delta) || 0; return true; },
                action(action) { calls.actions.push(action); return true; }
            }
        },
        addEventListener(name, listener) { windowListeners.set(name, listener); }
    };

    vm.runInNewContext(RESILIENCE, {
        window,
        document,
        location: { href: 'file:///C:/EveOS/EveOS.html' },
        URL,
        console: { info() {} },
        setTimeout(callback) { timers.push(callback); return timers.length; }
    });

    return {
        window,
        playback,
        queue,
        calls,
        commands,
        directPlayer,
        documentListeners,
        windowListeners,
        frameWindow,
        runTimers() { while (timers.length) timers.shift()(); }
    };
}

test('provider resume stays on the active EveOS player instead of re-entering playItem', async () => {
    const h = harness();
    await h.window.EveAudioflixTransportControl.resume();

    assert.equal(h.calls.playItem, 0);
    assert.equal(h.commands.length, 1);
    assert.deepEqual(h.commands[0].message, {
        type: 'eve-audioflix-provider-command',
        token: 'af-test',
        action: 'play'
    });
});

test('direct/local resume uses the already-active media element', async () => {
    const h = harness({ browserOnly: false, provider: 'direct' });
    await h.window.EveAudioflixTransportControl.resume();

    assert.equal(h.directPlayer.playCalls, 1);
    assert.equal(h.calls.playItem, 0);
});

test('universal volume routes through Audioflix and mirrors to provider host when present', () => {
    const h = harness();
    const changed = h.window.EveAudioflixTransportControl.setVolume(0.25, { itemId: 101, persist: true });

    assert.equal(changed, true);
    assert.deepEqual(h.calls.updateVolume, [['101', 0.25]]);
    assert.deepEqual(h.calls.persisted, [['music', '101', 0.25]]);
    assert.equal(h.commands.at(-1).message.action, 'volume');
    assert.equal(h.commands.at(-1).message.value, 25);
});

test('common Ended event advances a stuck queue across serialized id types', () => {
    const h = harness({ browserOnly: false, provider: 'direct' });
    h.windowListeners.get('eve:audioflix-playback')({ detail: { status: 'Ended', item: { id: 101 } } });

    assert.equal(h.calls.step, 0, 'normal Audioflix handler gets the first turn');
    h.runTimers();
    assert.equal(h.calls.step, 1);
    assert.equal(h.queue.currentIndex, 1);
});

test('repeat-one recovery restarts instead of advancing', () => {
    const h = harness({ repeatOne: true });
    h.windowListeners.get('eve:audioflix-playback')({ detail: { status: 'Ended', item: { id: '101' } } });
    h.runTimers();

    assert.equal(h.calls.step, 0);
    assert.deepEqual(h.calls.actions, ['restart']);
});

test('WatchFusion uses the universal resume/volume facade for provider playback', () => {
    assert.match(WATCHFUSION, /EveAudioflixTransportControl/);
    assert.match(WATCHFUSION, /controller\?\.resume/);
    assert.match(WATCHFUSION, /controller\?\.setVolume/);
    assert.doesNotMatch(WATCHFUSION, /const playCurrent = \(\) => providerOnly \? audio\(\)\.playItem/);
});
