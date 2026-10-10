'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const source = fs.readFileSync(
    path.join(ROOT, 'js/modules/features/audioflix/audioflix.queue.completion.js'),
    'utf8'
);

let renders = 0;
let repeatOne = false;
const window = {
    EveAudioflixQueueCompletion: {},
    EveAudioflixInternalPlayer: {
        createController() {
            return {
                setQueue() { renders += 1; }
            };
        }
    },
    EveAudioflix: {
        queueConnection: {
            snapshot: () => ({ repeatOne })
        }
    }
};

vm.runInNewContext(source, { window, console, Promise }, {
    filename: 'audioflix.queue.completion.js'
});

assert.equal(window.EveAudioflixInternalPlayer.__eveStableQueueViewInstalled, true,
    'queue stability hook must install before URL playback creates its controller');

const controller = window.EveAudioflixInternalPlayer.createController({});
const alphaBeta = [{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta' }];
controller.setQueue(alphaBeta, 0);
assert.equal(renders, 1, 'first queue render passes through');

controller.setQueue(alphaBeta, 0);
controller.setQueue(alphaBeta.map(entry => ({ ...entry })), 0);
assert.equal(renders, 1, 'semantic no-op syncs preserve the existing queue row DOM');

controller.setQueue(alphaBeta, 1);
assert.equal(renders, 2, 'current-index changes still render');

repeatOne = true;
controller.setQueue(alphaBeta, 1);
assert.equal(renders, 3, 'repeat-one presentation changes still render');

controller.setQueue([{ id: 'a', title: 'Alpha' }, { id: 'b', title: 'Beta renamed' }], 1);
assert.equal(renders, 4, 'title changes still render');

controller.setQueue([{ id: 'b', title: 'Beta renamed' }, { id: 'a', title: 'Alpha' }], 1);
assert.equal(renders, 5, 'queue reorder still renders');

controller.setQueue([], 0);
assert.equal(renders, 6, 'leaving queue mode still renders');
controller.setQueue([], 0);
assert.equal(renders, 6, 'empty queue no-op sync stays stable');

console.log('AUDIOFLIX_QUEUE_VIEW_STABILITY_OK renders=6 redundantSyncsSuppressed=true');
