'use strict';

// Captured-tab gain (Nexus extension) must only follow the playing official Spotify embed.
// Other AudioFlix transports apply their slider themselves; a tab gain on top would square it.

const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const PAGE_SOURCE = fs.readFileSync(
    path.join(ROOT, 'js', 'modules', 'features', 'audioflix', 'audioflix.tab-gain-owner.js'), 'utf8');
const CONTENT_SOURCE = fs.readFileSync(
    path.join(ROOT, 'tools', 'Nexus-Browser', 'extension', 'content', 'audioflix-tab-audio.js'), 'utf8');

function harness() {
    const attrs = new Map();
    const observers = [];
    const docListeners = new Map();
    const winListeners = new Map();
    const sent = [];
    const on = (map) => (type, fn) => {
        if (!map.has(type)) map.set(type, []);
        map.get(type).push(fn);
    };
    const root = {
        getAttribute: (name) => (attrs.has(name) ? attrs.get(name) : null),
        setAttribute(name, value) {
            const changed = attrs.get(name) !== String(value);
            attrs.set(name, String(value));
            if (changed) for (const cb of observers) cb([{ attributeName: name }]);
        }
    };
    const document = { documentElement: root, addEventListener: on(docListeners) };
    const window = { addEventListener: on(winListeners) };
    const chrome = {
        runtime: {
            sendMessage(message) { sent.push(message); return Promise.resolve({ ok: true }); },
            onMessage: { addListener() {} }
        }
    };
    class MutationObserver {
        constructor(cb) { this.cb = cb; }
        observe() { observers.push(this.cb); }
    }
    const context = vm.createContext({ window, document, chrome, MutationObserver, globalThis: null });
    context.globalThis = context;
    vm.runInContext(PAGE_SOURCE, context);
    vm.runInContext(CONTENT_SOURCE, context);

    const fire = (map, type, event) => (map.get(type) || []).forEach((fn) => fn(event));
    const slider = (id, value, cls = 'audioflix-volume-slider') => ({
        value: String(value),
        dataset: { afId: id },
        getAttribute: (name) => (name === 'max' ? '1' : null),
        matches: (selector) => selector.split(',').some((s) => s.trim() === `.${cls}`)
    });
    return {
        attrs,
        volumes: () => sent.map((m) => m.volume),
        playback: (detail) => fire(winListeners, 'eve:audioflix-playback', { detail }),
        input: (el) => fire(docListeners, 'input', { target: el }),
        slider
    };
}

const spotify = (id, volume = 1) => ({
    id, volume, url: `https://open.spotify.com/track/${id}`, spotifyPlaybackMode: 'official-embed'
});

test('Spotify embed claims the tab gain at its own item volume', () => {
    const h = harness();
    h.playback({ status: 'Playing A', item: spotify('a', 0.4) });
    assert.equal(h.attrs.get('data-af-tab-gain-owner'), 'a');
    assert.equal(h.volumes().at(-1), 0.4);
    h.input(h.slider('a', 0.7));
    assert.equal(h.volumes().at(-1), 0.7);
});

test('non-Spotify tracks keep the tab gain at unity so the slider is not applied twice', () => {
    const h = harness();
    h.playback({ status: 'Playing local', item: { id: 'l', volume: 0.5, url: 'file:///C:/m/l.mp3' } });
    assert.equal(h.attrs.get('data-af-tab-gain-owner'), '');
    h.input(h.slider('l', 0.5));
    assert.ok(h.volumes().every((v) => v === 1), `expected only unity, got ${h.volumes()}`);
});

test('sliders on idle cards never move the captured gain', () => {
    const h = harness();
    h.playback({ status: 'Playing A', item: spotify('a', 0.6) });
    const before = h.volumes().length;
    h.input(h.slider('queued-b', 0.1));
    assert.equal(h.volumes().length, before);
});

test('gain releases on a switch to YouTube and re-applies on the next Spotify track', () => {
    const h = harness();
    h.playback({ status: 'Playing A', item: spotify('a', 0.3) });
    h.playback({ status: 'Playing yt', item: { id: 'y', volume: 0.8, url: 'https://www.youtube.com/watch?v=abcdefghijk' } });
    assert.equal(h.volumes().at(-1), 1);
    h.playback({ status: 'Ended', item: { id: 'y' } });
    h.playback({ status: 'Playing B', item: spotify('b', 0.55) });
    assert.equal(h.volumes().at(-1), 0.55);
});
