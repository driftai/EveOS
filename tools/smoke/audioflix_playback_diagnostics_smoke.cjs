'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('node:vm');
const assert = require('node:assert/strict');

const ROOT = path.resolve(__dirname, '..', '..');
const source = fs.readFileSync(
    path.join(ROOT, 'js/modules/features/audioflix/audioflix.playback.diagnostics.js'),
    'utf8'
);

let clock = 50;
const windowListeners = new Map();
const documentListeners = new Map();
const observers = new Map();
const navigation = {
    startTime: 0,
    domInteractive: 20,
    domContentLoadedEventEnd: 30,
    loadEventEnd: 0
};

class FakePerformanceObserver {
    constructor(callback) { this.callback = callback; }
    observe(options = {}) { observers.set(options.type, this.callback); }
}

const actionTarget = {
    dataset: { afAction: 'play-music-group' },
    closest(selector) {
        if (selector === '[data-af-action]') return this;
        return null;
    }
};

const window = {
    performance: {
        now: () => clock,
        getEntriesByType: (type) => type === 'navigation' ? [navigation] : []
    },
    addEventListener(name, callback) { windowListeners.set(name, callback); },
    dispatchEvent(event) { windowListeners.get(event.type)?.(event); }
};
window.window = window;
const document = {
    addEventListener(name, callback) { documentListeners.set(name, callback); }
};

const context = {
    window,
    document,
    PerformanceObserver: FakePerformanceObserver,
    Date,
    Map,
    Set,
    Math,
    Number,
    String,
    console
};
vm.createContext(context);
vm.runInContext(source, context, { filename: 'audioflix.playback.diagnostics.js' });

const playback = (status) => window.dispatchEvent({
    type: 'eve:audioflix-playback',
    detail: { status }
});

clock = 100;
documentListeners.get('pointerdown')?.({ type: 'pointerdown', target: actionTarget });
clock = 130;
playback('Loading Spotify track');
clock = 180;
playback('Playing Smoke with Spotify');
clock = 200;
playback('Ended');
clock = 260;
playback('Playing next track with Spotify');

observers.get('event')?.({ getEntries: () => [{
    target: actionTarget,
    startTime: 90,
    processingStart: 100,
    processingEnd: 111,
    duration: 32,
    interactionId: 7
}] });
observers.get('longtask')?.({ getEntries: () => [{ duration: 55 }] });

navigation.loadEventEnd = 80;
windowListeners.get('load')?.();

const snapshot = window.EveAudioflixDiagnostics.snapshot();
const summary = snapshot.summary;
assert.equal(summary['ui:input-to-playing'].p50Ms, 80,
    'pointer press to Playing latency is measured');
assert.equal(summary['ui:input-to-playing:play-music-group'].p50Ms, 80,
    'play action keeps its own input-to-playing bucket');
assert.equal(summary['playback:load-to-playing'].p50Ms, 50,
    'provider loading to Playing latency is measured');
assert.equal(summary['queue:between-songs'].p50Ms, 60,
    'Ended to next Playing queue handoff is measured');
assert.equal(summary['ui:input-delay:play-music-group'].p50Ms, 10,
    'Event Timing input delay is recorded');
assert.equal(summary['ui:handler:play-music-group'].p50Ms, 11,
    'Event Timing synchronous handler duration is recorded');
assert.equal(summary['ui:interaction-total:play-music-group'].p50Ms, 32,
    'Event Timing total interaction duration is recorded');
assert.equal(summary['ui:long-task'].p50Ms, 55,
    'long-task observation remains active');
assert.equal(summary['boot:dom-interactive'].p50Ms, 20);
assert.equal(summary['boot:dom-content-loaded'].p50Ms, 30);
assert.equal(summary['boot:window-load'].p50Ms, 80);
assert.ok(snapshot.recent.some((entry) => entry.action === 'play-music-group' && entry.interactionId === 7),
    'recent timing samples retain the action and interaction identity');

console.log('AUDIOFLIX_PLAYBACK_DIAGNOSTICS_SMOKE_OK');
