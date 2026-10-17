'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const root = path.join(__dirname, '..');
const moduleText = fs.readFileSync(path.join(root, 'js/modules/features/audioflix/audioflix.spotify.queue-handoff.js'), 'utf8');
const uri = i => `spotify:track:${i}`;
const ids = ['4cOdK2wGLETKBW3PvgPWqT', '5cOdK2wGLETKBW3PvgPWqT'];
function harness() {
    const calls = [];
    const list = ids.map((id, i) => ({ id: `music-${i}`, title: `Song ${i}`, url: uri(id), duration: 12 }));
    const queue = { items: list.map(item => item.id), currentIndex: 0, isPlaying: true, loop: false };
    let run = 8, adopted = 0;
    const win = {
        addEventListener() {},
        EveAudioflixSpotifyQueueHandoff: {},
        EveAudioflixSpotifyMedia: { fromItem: item => item && {
            spotifyUri: item.url, spotifyId: item.url.slice(-22), mediaType: 'track' } },
        EveAudioflixSpotifyVolume: { effectiveGain: () => 1 },
        EveAudioflixSpotifyAnyBrowser: { snapshot: () => ({ active: true }) },
        EveAudioflixSpotifyRemote: {
            snapshot: () => ({ connected: true, lastState: { isOwner: true,
                engine: { spotifyUri: uri(ids[0]), generation: 17, status: 'playing' } } }),
            async send(action, payload) {
                calls.push({ action, payload });
                if (action === 'queue-arm') return { ok: true, queueLease: { leaseId: 'lease-a', runId: 8, index: 0, state: 'active' } };
                return { ok: true };
            }
        },
        EveAudioflix: { queueConnection: {
            snapshot: () => ({ ...queue, entries: list, playbackRunId: run }),
            adoptManagedSpotify({ runId, index, itemId, finished }) {
                if (runId !== run || queue.items[index] !== itemId) return null;
                queue.currentIndex = index; queue.isPlaying = !finished;
                adopted++;
                return list[index];
            }
        } },
        EveAudioflixDiagnostics: { record() {} }
    };
    vm.runInNewContext(moduleText, { window: win, console });
    return { win, calls, queue, list, get adopted() { return adopted; }, setRun(v) { run = v; } };
}

test('a Spotify-only queue is armed through existing authenticated remote', async () => {
    const h = harness();
    assert.equal(await h.win.EveAudioflixSpotifyQueueHandoff.arm(h.queue, i => h.list[i]), true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.calls[0].action, 'queue-arm');
    assert.equal(h.calls[0].payload.entries.length, 2);
    assert.equal(h.win.EveAudioflixSpotifyQueueHandoff.isDelegated(), true);
});

test('owner index receipt is adopted without invoking a second play', async () => {
    const h = harness();
    const handoff = h.win.EveAudioflixSpotifyQueueHandoff;
    await handoff.arm(h.queue, i => h.list[i]);
    const adoptedItems = [];
    assert.equal(handoff.adopt({ queueLease: { leaseId: 'lease-a', runId: 8,
        index: 1, itemId: 'music-1', state: 'active' }, engine: { spotifyUri: uri(ids[1]) } },
        item => adoptedItems.push(item.id)), true);
    assert.equal(h.queue.currentIndex, 1);
    assert.equal(adoptedItems[0], 'music-1');
    assert.equal(h.calls.filter(x => x.action === 'play').length, 0);
});

test('replaced queue run cannot adopt an old lease', async () => {
    const h = harness();
    await h.win.EveAudioflixSpotifyQueueHandoff.arm(h.queue, i => h.list[i]);
    h.setRun(9);
    assert.equal(h.win.EveAudioflixSpotifyQueueHandoff.adopt({ queueLease: {
        leaseId: 'lease-a', runId: 8, index: 1, itemId: 'music-1', state: 'active'
    } }), false);
    assert.equal(h.queue.currentIndex, 0);
});

test('lost queue-arm ACK remains owned until receipt reconciliation, never double-advances', async () => {
    const h = harness();
    const handoff = h.win.EveAudioflixSpotifyQueueHandoff;
    h.win.EveAudioflixSpotifyRemote.send = async (action, payload) => {
        h.calls.push({ action, payload });
        return { ok: false, timeout: true };
    };
    assert.equal(await handoff.arm(h.queue, i => h.list[i]), false);
    assert.equal(handoff.isDelegated(), true, 'lost ACK cannot restore competing frontend authority');
    const receipt = { queueLease: { leaseId: 'late-lease', runId: 8,
        index: 1, itemId: 'music-1', state: 'active' }, engine: { spotifyUri: uri(ids[1]) } };
    assert.equal(handoff.adopt(receipt), true);
    assert.equal(h.queue.currentIndex, 1);
    assert.equal(h.calls.filter(x => x.action === 'play').length, 0);
});

test('shuffle-loop queue refuses unsafe static-order delegation', async () => {
    const h = harness();
    h.queue.shuffle = true;
    h.queue.loop = true;
    assert.equal(await h.win.EveAudioflixSpotifyQueueHandoff.arm(h.queue, i => h.list[i]), false);
    assert.equal(h.calls.length, 0);
});

test('uncertain lease never replays work in the frontend', async () => {
    const h = harness();
    const handoff = h.win.EveAudioflixSpotifyQueueHandoff;
    await handoff.arm(h.queue, i => h.list[i]);
    assert.equal(handoff.adopt({ queueLease: {
        leaseId: 'lease-a', runId: 8, index: 0, state: 'uncertain'
    } }), true);
    assert.equal(h.calls.length, 1);
    assert.equal(h.queue.currentIndex, 0);
    assert.equal(handoff.isDelegated(), true);
});
