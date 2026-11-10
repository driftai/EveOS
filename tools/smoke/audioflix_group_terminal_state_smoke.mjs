#!/usr/bin/env node

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const source = fs.readFileSync(path.join(ROOT, 'js/modules/features/audioflix/audioflix.queue.completion.js'), 'utf8');
let syncs = 0;
let renders = 0;
let ownedRestarts = 0;
const button = {
    dataset: { afAction: 'stop-music-group' },
    classList: { remove: () => {} },
    textContent: '■ Stop Group'
};
const overlay = {
    querySelectorAll: (selector) => selector === '[data-af-action="stop-music-group"]' ? [button] : []
};
const document = {
    querySelector: (selector) => selector === '#audioflix-overlay' ? overlay : null
};
const context = vm.createContext({
    console,
    Promise,
    WeakMap,
    document,
    window: {
        EveAudioflix: { rerender: () => { renders += 1; }, queueConnection: { snapshot: () => ({ repeatOne: false }) } },
        EveAudioflixAudio: { syncQueueView: () => { syncs += 1; },
            restartCurrent: async track => { ownedRestarts += 1; return track?.id === 'owned'; } },
        EveAudioflixInternalPlayer: null,
        EveAudioflixDiagnostics: { record: () => {} }
    }
});
vm.runInContext(source, context, { filename: 'audioflix.queue.completion.js' });
const completion = context.window.EveAudioflixQueueCompletion;
assert.equal(completion?.ready, true);

const queue = {
    entries: [{ id: 'track-1', title: 'One' }],
    currentIndex: 0,
    isPlaying: true,
    repeatOne: false,
    playbackRunId: 17
};
let advances = 0;
const complete = completion.create({
    snapshot: () => queue,
    advance: async () => { advances += 1; queue.currentIndex = 1; queue.isPlaying = false; },
    restart: async () => { throw new Error('restart should not run'); }
});
const detail = { status: 'Ended', item: { id: 'track-1' }, settle: Promise.resolve() };
assert.equal(complete(detail), true, 'natural Ended should be claimed');
assert.equal(complete(detail), false, 'same completion must be idempotent');
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(advances, 1, 'queue advances exactly once');
assert.equal(queue.isPlaying, false, 'terminal queue becomes idle');
assert.equal(syncs, 1, 'terminal queue view is synchronized');
assert.equal(renders, 0, 'terminal transport must not structurally rerender the AudioFlix library');
assert.equal(button.dataset.afAction, 'play-music-group', 'terminal transport becomes Play Group in place');
assert.match(button.textContent, /Play Group/, 'terminal transport label is patched in place');

const terminalButton = button;
completion.syncTerminalView(() => ({ isPlaying: false }));
assert.equal(button, terminalButton, 'terminal patch must preserve the existing button DOM object');
assert.equal(renders, 0, 'explicit terminal sync must remain non-structural');

const repeating = {
    entries: [{ id: 'track-r', title: 'Repeat' }],
    currentIndex: 0,
    isPlaying: true,
    repeatOne: true,
    playbackRunId: 18
};
let restarts = 0;
const repeatComplete = completion.create({
    snapshot: () => repeating,
    advance: async () => { throw new Error('advance should not run in repeat-one'); },
    restart: async () => { restarts += 1; }
});
assert.equal(repeatComplete({ status: 'Ended', item: { id: 'track-r' }, settle: Promise.resolve() }), true);
await new Promise((resolve) => setTimeout(resolve, 0));
assert.equal(restarts, 1, 'repeat-one still restarts');
assert.equal(renders, 0, 'non-terminal repeat must not force a structural rerender');

button.dataset.afAction = 'stop-music-group';
const owned = { items: ['owned'], currentIndex: 0, isPlaying: true };
let run = 23;
const runtime = completion.createRuntime({
    state: () => ({ music: [{ id: 'owned', title: 'Owned' }] }), queue: () => owned,
    playIndex: () => { throw new Error('Finishing an exhausted queue cannot start playback'); },
    getRun: () => run, setRun: value => { run = value; },
    snapshot: () => ({ entries: [{ id: 'owned' }], currentIndex: 0, isPlaying: owned.isPlaying, playbackRunId: run })
});
assert.equal(typeof runtime.finish, 'function', 'The queue owner must publish terminal state even when another Ended listener advances first');
const priorSyncs = syncs;
runtime.finish();
assert.equal(owned.isPlaying, false);
assert.equal(run, 23, 'Exhaustion must not create a fresh playback run');
assert.equal(syncs, priorSyncs + 1);
assert.equal(button.dataset.afAction, 'play-music-group');
assert.equal(button, terminalButton);
assert.equal(renders, 0, 'Owner-side exhaustion must remain a transport-only patch');

owned.isPlaying = true;
assert.equal(await runtime.restart(), true, 'Restart delegates to the exact active playback owner');
assert.equal(ownedRestarts, 1);
assert.equal(run, 24, 'Owner restart creates one fresh queue run');

console.log('AUDIOFLIX_GROUP_TERMINAL_STATE_SMOKE_OK');
