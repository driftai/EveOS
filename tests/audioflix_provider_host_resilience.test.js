'use strict';

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const SOURCE = fs.readFileSync(
    path.join(__dirname, '..', 'js', 'modules', 'features', 'audioflix', 'audioflix.transport.resilience.js'),
    'utf8'
);

function harness({ activeId = 'track-1' } = {}) {
    const documentListeners = new Map();
    const windowListeners = new Map();
    const sent = [];
    const timers = [];
    const logs = [];
    const queue = {
        isPlaying: true,
        repeatOne: false,
        currentIndex: 0,
        entries: [{ id: 'track-1' }, { id: 'track-2' }]
    };
    let stepCalls = 0;

    const frameWindow = {
        postMessage(message, origin) {
            sent.push({ message, origin });
        }
    };
    const frame = {
        src: 'http://127.0.0.1:8765/server/audioflix-provider-host.html?provider=youtube&id=abcdefghijk&token=af-test',
        contentWindow: frameWindow
    };

    const document = {
        querySelectorAll(selector) {
            assert.equal(selector, '.audioflix-provider-frame iframe');
            return [frame];
        },
        addEventListener(name, listener) {
            documentListeners.set(name, listener);
        }
    };
    const window = {
        EveAudioflixTransportResilience: {},
        EveAudioflixAudio: {
            getPlaybackState: () => ({ item: { id: activeId } })
        },
        EveAudioflix: {
            queueConnection: {
                snapshot: () => ({
                    ...queue,
                    entries: queue.entries.map((entry) => ({ ...entry }))
                }),
                step(delta) {
                    stepCalls += 1;
                    queue.currentIndex += Number(delta) || 0;
                    return true;
                }
            }
        },
        addEventListener(name, listener) {
            windowListeners.set(name, listener);
        }
    };

    vm.runInNewContext(SOURCE, {
        window,
        document,
        location: { href: 'file:///C:/EveOS/EveOS.html' },
        URL,
        console: { info: (message) => logs.push(String(message)) },
        setTimeout(callback) {
            timers.push(callback);
            return timers.length;
        }
    });

    return {
        window,
        documentListeners,
        windowListeners,
        sent,
        timers,
        logs,
        queue,
        frameWindow,
        get stepCalls() { return stepCalls; },
        runTimers() {
            while (timers.length) timers.shift()();
        }
    };
}

function volumeTarget(id, value, providerPanel = false) {
    return {
        value: String(value),
        dataset: { afId: id },
        matches(selector) {
            if (selector === '.audioflix-volume-slider, .audioflix-provider-volume') return true;
            if (selector === '.audioflix-volume-slider') return !providerPanel;
            return selector === '.audioflix-provider-volume' && providerPanel;
        }
    };
}

test('active Audioflix card volume is resent to the live provider host in YouTube percent units', () => {
    const h = harness();
    h.documentListeners.get('input')({ target: volumeTarget('track-1', 0.25) });

    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0].origin, 'http://127.0.0.1:8765');
    assert.deepEqual(
        JSON.parse(JSON.stringify(h.sent[0].message)),
        {
            type: 'eve-audioflix-provider-command',
            token: 'af-test',
            action: 'volume',
            value: 25
        }
    );
});

test('a non-active card cannot change the live provider volume', () => {
    const h = harness();
    h.documentListeners.get('input')({ target: volumeTarget('track-2', 0.1) });
    assert.equal(h.sent.length, 0);
});

test('raw provider-host ended state is never a queue completion source', () => {
    const h = harness();
    // Queue completion comes only from canonical Audioflix Ended. A raw host `state=ended`
    // reuses one iframe/token across loads and repeat restarts and carries no run identity.
    assert.equal(h.windowListeners.has('message'), false, 'no raw provider-host listener');
    h.runTimers();
    assert.equal(h.stepCalls, 0);
    assert.equal(h.queue.currentIndex, 0);
});

test('canonical Ended fallback still advances once, and not after the normal handler moved', async () => {
    const h = harness();
    const ended = (detail) => h.windowListeners.get('eve:audioflix-playback')({ detail });
    ended({ status: 'Ended', item: { id: 'track-1' }, settle: Promise.resolve(true) });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(h.stepCalls, 0, 'fallback waits until normal Ended handlers run');
    h.runTimers();
    assert.equal(h.stepCalls, 1);
    assert.equal(h.queue.currentIndex, 1);

    const moved = harness();
    moved.windowListeners.get('eve:audioflix-playback')({ detail: { status: 'Ended', item: { id: 'track-1' }, settle: Promise.resolve(true) } });
    moved.queue.currentIndex = 1;
    await new Promise((resolve) => setImmediate(resolve));
    moved.runTimers();
    assert.equal(moved.stepCalls, 0);
});
