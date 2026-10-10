'use strict';
// Lane 2: shared queue/completion contract. One accepted Ended for the current
// (entry, playbackRunId) causes exactly one repeat or advance; stale callbacks cause neither.
// Every entry point drives the real EveOS queue (EveAudioflix.queueConnection) with real WAV
// playback. Provider Ended/settle and explicit-release signals are mocked: no live Spotify proof.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { RESULT_DIR, createFixture, snapshot, pointerClick, libraryAction, end, resolveEnd, saveFailure } =
    require('./helpers/audioflix_queue_completion_fixture');

const root = path.resolve(__dirname, '..', '..');
const counts = {};

async function jump(page, index) {
    await page.evaluate(index => window.EveAudioflix.queueConnection.jump(index), index);
    await playingAt(page, index);
    await page.evaluate(() => { window.__queueSmoke.starts.length = 0; });
    return snapshot(page);
}

async function playingAt(page, index) {
    await page.waitForFunction(index => {
        const q = window.EveAudioflix.queueConnection.snapshot();
        const playback = window.EveAudioflixAudio.getPlaybackState();
        return q.isPlaying && q.currentIndex === index && playback.item?.id === q.entries[index]?.id && playback.paused === false;
    }, index, { timeout: 5000 });
}

const action = (page, id) => page.evaluate(id => window.EveAudioflix.queueConnection.action(id), id);
const repeatOne = page => page.evaluate(() => window.EveAudioflix.queueConnection.snapshot().repeatOne === true);
async function setRepeat(page, on) { if ((await repeatOne(page)) !== on) await action(page, 'repeat-one'); }

// Non-Spotify provider Ended: only the canonical coordinator and the resilience fallback listen.
async function endDirect(page, copies = 2) {
    await page.evaluate(copies => {
        const playback = window.EveAudioflixAudio.getPlaybackState();
        const detail = { status: 'Ended', provider: 'direct', item: playback.item, settle: Promise.resolve(true) };
        for (let i = 0; i < copies; i += 1) window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail }));
    }, copies);
}

// Re-deliver the exact Ended detail a provider already reported (late duplicate callback).
const redeliver = page => page.evaluate(() =>
    window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail: window.__queueSmoke.detail })));

// Match managed-client retirement: stop only the real WAV transport, then emit the provider signal.
// Never call Stop Group here: that would update the queue directly and hide the missing consumer.
async function stoppedSignal(page, itemId, { released = true, stopTransport = true } = {}) {
    await page.evaluate(async ({ itemId, released, stopTransport }) => {
        const item = itemId == null ? null : window.EveAudioflixState.getSnapshot().music.find(track => track.id === itemId);
        if (stopTransport) await window.EveAudioflixAudio.stopAll();
        window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail: {
            status: 'Stopped', item, provider: 'spotify', browserOnly: true, remoteManaged: true, released
        } }));
    }, { itemId, released, stopTransport });
}

async function replayFromGroupPointer(page) {
    assert.strictEqual(await page.evaluate(() => window.EveAudioflixAudio.isInternalViewOpen()), false, 'Queue View remains closed');
    await libraryAction(page, 'play-music-group');
    await playingAt(page, 0);
    assert.strictEqual(await page.evaluate(() => window.EveAudioflixAudio.isInternalViewOpen()), false, 'pointer replay never opens Queue View');
}

// Let every listener (coordinator, Spotify fast path, 0ms resilience fallback) and any start settle.
async function settled(page) {
    await page.waitForTimeout(350);
    await page.waitForFunction(() => !window.__queueSmoke.pending, undefined, { timeout: 3000 });
    return snapshot(page);
}

function expectOutcome(id, state, expected) {
    const ids = state.starts.map(start => start.id);
    assert.deepStrictEqual(ids, expected.starts, `${id}: playback starts`);
    assert.strictEqual(state.queue.currentIndex, expected.index, `${id}: queue index`);
    if (expected.method) assert(state.starts.every(start => start.method === expected.method), `${id}: started via ${expected.method}`);
    counts[id] = { repeat: expected.repeat || 0, advance: expected.advance || 0, starts: ids.length };
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    const failures = [];
    let passed = 0, fixture;
    async function run(id, work) {
        try {
            const prior = fixture.diagnostics.pageErrorCount;
            await work(fixture.page);
            assert.strictEqual(fixture.diagnostics.pageErrorCount, prior, 'no page errors');
            passed += 1;
        } catch (error) {
            failures.push({ id, message: String(error.message || error), state: await saveFailure(fixture, id, error) });
        } finally {
            await resolveEnd(fixture.page);
            await fixture.page.evaluate(() => { window.__queueSmoke.fail = null; });
            await setRepeat(fixture.page, false).catch(() => {});
            await fixture.page.waitForTimeout(150);
        }
    }
    try {
        // 1. Play Group without Queue View: completion owner must not depend on the view.
        fixture = await createFixture(browser, root, { queueView: false });
        await run('play-group-no-queue-view', async page => {
            const before = await jump(page, 0);
            assert.strictEqual(await page.evaluate(() => window.EveAudioflixAudio.isInternalViewOpen()), false, 'Queue View is closed');
            await end(page);
            expectOutcome('play-group-no-queue-view', await settled(page), { starts: [before.queue.entries[1].id], index: 1, method: 'playItem', advance: 1 });
        });
        await run('direct-provider-ended-two-copies', async page => {
            const before = await jump(page, 1);
            await endDirect(page);
            expectOutcome('direct-provider-ended-two-copies', await settled(page), { starts: [before.queue.entries[2].id], index: 2, advance: 1 });
        });
        // 8. Failed start: the unavailable entry is skipped inside the same advance, never twice.
        await run('failed-start-skips-once', async page => {
            const before = await jump(page, 0);
            const [alpha, beta, gamma] = before.queue.entries.map(entry => entry.id);
            await page.evaluate(id => { window.__queueSmoke.fail = new Set([id]); }, beta);
            await end(page);
            const after = await settled(page);
            expectOutcome('failed-start-skips-once', after, { starts: [beta, gamma], index: 2, advance: 1 });
            await end(page, false, alpha);
            const stale = await settled(page);
            assert.deepStrictEqual(stale.starts.map(start => start.id), [beta, gamma], 'stale Ended after a skip does nothing');
        });
        await run('explicit-release-no-queue-view-pointer-replay', async page => {
            const before = await jump(page, 0), current = before.queue.entries[0].id;
            await stoppedSignal(page, current);
            const released = await settled(page);
            assert.strictEqual(released.queue.isPlaying, false, 'explicit release retires canonical queue ownership');
            assert.strictEqual(released.queue.playbackRunId, before.queue.playbackRunId + 1, 'release invalidates exactly one queue run');
            assert.strictEqual(released.queue.groupName, before.queue.groupName, 'release preserves the queue source');
            assert.deepStrictEqual(released.queue.entries, before.queue.entries, 'release preserves the queue order');
            assert.strictEqual(released.playback.paused, true, 'real WAV transport is stopped before provider release');
            expectOutcome('explicit-release-no-queue-view', released, { starts: [], index: 0 });
            await replayFromGroupPointer(page);
            const replayed = await settled(page);
            assert(replayed.queue.playbackRunId > released.queue.playbackRunId, 'explicit pointer replay owns a fresh run');
            expectOutcome('explicit-release-pointer-replay', replayed, { starts: [current], index: 0, method: 'playItem' });
        });
        await run('generic-and-stale-entry-stops-ignore-release', async page => {
            const before = await jump(page, 1), current = before.queue.entries[1].id;
            await stoppedSignal(page, current, { released: false, stopTransport: false });
            await stoppedSignal(page, before.queue.entries[0].id, { stopTransport: false });
            await stoppedSignal(page, null, { stopTransport: false });
            const ignored = await settled(page);
            assert.strictEqual(ignored.queue.isPlaying, true, 'ordinary, stale-entry, and identityless stops cannot retire this queue');
            assert.strictEqual(ignored.queue.playbackRunId, before.queue.playbackRunId, 'ignored stop does not invalidate a run');
            assert.strictEqual(ignored.playback.id, current, 'unrelated stop preserves actual current WAV playback');
            assert.strictEqual(ignored.playback.paused, false);
            expectOutcome('generic-and-stale-entry-stops-ignore-release', ignored, { starts: [], index: 1 });
        });
        await run('explicit-release-invalidates-pending-ended', async page => {
            const before = await jump(page, 0), current = before.queue.entries[0].id;
            await end(page, true);
            await stoppedSignal(page, current);
            const released = await snapshot(page);
            assert.strictEqual(released.queue.isPlaying, false);
            assert.strictEqual(released.queue.playbackRunId, before.queue.playbackRunId + 1);
            assert.deepStrictEqual(released.starts, [], 'pending Ended cannot start anything during release');
            // Replay the SAME entry before old Ended settles: its stale run must not advance replay.
            await replayFromGroupPointer(page);
            const replayRun = (await snapshot(page)).queue.playbackRunId;
            await resolveEnd(page);
            const after = await settled(page);
            assert.strictEqual(after.queue.isPlaying, true, 'explicit replay remains the active owner');
            assert.strictEqual(after.queue.playbackRunId, replayRun, 'old Ended cannot invalidate the replay run');
            expectOutcome('explicit-release-invalidates-pending-ended', after, { starts: [current], index: 0, method: 'playItem' });
        });
        // 9. Stop/reset while the completion settle is pending, with no Queue View.
        await run('stop-during-pending-settle-no-queue-view', async page => {
            await jump(page, 1);
            await end(page, true);
            await libraryAction(page, 'stop-music-group');
            await resolveEnd(page);
            const after = await settled(page);
            assert.strictEqual(after.queue.isPlaying, false, 'Stop ends queue ownership');
            expectOutcome('stop-during-pending-settle-no-queue-view', after, { starts: [], index: -1 });
        });
        await fixture.context.close();

        fixture = await createFixture(browser, root);
        // 2. Queue View.
        await run('queue-view-ended-once', async page => {
            const before = await jump(page, 0);
            await end(page);
            expectOutcome('queue-view-ended-once', await settled(page), { starts: [before.queue.entries[1].id], index: 1, method: 'openInternalView', advance: 1 });
        });
        // 3. Internal Player transport (its own Next control), then completion.
        await run('internal-player-next-then-ended', async page => {
            const before = await jump(page, 0);
            await pointerClick(page, '.audioflix-provider-stage:not([hidden]) [data-url-player-action="next"]');
            await playingAt(page, 1);
            await page.evaluate(() => { window.__queueSmoke.starts.length = 0; });
            await end(page);
            expectOutcome('internal-player-next-then-ended', await settled(page), { starts: [before.queue.entries[2].id], index: 2, advance: 1 });
        });
        // 4 + 5. WatchFusion drives only queueConnection move/jump/action; move current to #1.
        await run('watchfusion-move-current-to-first', async page => {
            const before = await jump(page, 2);
            const playing = before.queue.entries[2].id;
            for (const from of [2, 1]) await page.evaluate(from => window.EveAudioflix.queueConnection.move(from, from - 1), from);
            const moved = await snapshot(page);
            assert.strictEqual(moved.queue.entries[0].id, playing, 'playing item is #1');
            assert.deepStrictEqual(moved.starts, [], 'reorder does not restart');
            await end(page);
            expectOutcome('watchfusion-move-current-to-first', await settled(page), { starts: [moved.queue.entries[1].id], index: 1, advance: 1 });
        });
        await run('watchfusion-shuffle-then-ended', async page => {
            const before = await jump(page, 2);
            await action(page, 'shuffle-music-group');
            const shuffled = await snapshot(page);
            assert.strictEqual(shuffled.queue.entries[0].id, before.queue.entries[2].id, 'shuffle rebases playing item to #1');
            await end(page);
            expectOutcome('watchfusion-shuffle-then-ended', await settled(page), { starts: [shuffled.queue.entries[1].id], index: 1, advance: 1 });
            await action(page, 'shuffle-music-group');
        });
        // 6. Repeat on -> off across repeated playback.
        await run('repeat-on-then-off', async page => {
            const before = await jump(page, 1);
            const current = before.queue.entries[1].id;
            await setRepeat(page, true);
            await end(page);
            let state = await settled(page);
            expectOutcome('repeat-on-then-off:repeat', state, { starts: [current], index: 1, repeat: 1 });
            await end(page);
            state = await settled(page);
            expectOutcome('repeat-on-then-off:repeat-2', state, { starts: [current, current], index: 1, repeat: 1 });
            await setRepeat(page, false);
            await end(page);
            state = await settled(page);
            expectOutcome('repeat-on-then-off:advance', state, { starts: [current, current, before.queue.entries[2].id], index: 2, advance: 1 });
        });
        for (const [label, from, to] of [['off-during-settle', true, false], ['on-during-settle', false, true]]) {
            await run(`repeat-${label}`, async page => {
                const before = await jump(page, 1);
                await setRepeat(page, from);
                await end(page, true);
                await setRepeat(page, to);
                await resolveEnd(page);
                const expected = to ? [before.queue.entries[1].id] : [before.queue.entries[2].id];
                expectOutcome(`repeat-${label}`, await settled(page), { starts: expected, index: to ? 1 : 2, repeat: to ? 1 : 0, advance: to ? 0 : 1 });
            });
        }
        // 7. Same Spotify URI in consecutive entries (every mocked Ended carries the same URI).
        await run('same-spotify-uri-consecutive', async page => {
            const before = await jump(page, 1);
            const ids = before.queue.entries.map(entry => entry.id);
            await end(page);
            await settled(page);
            await end(page, false, ids[1]);
            let state = await settled(page);
            expectOutcome('same-spotify-uri-consecutive:stale', state, { starts: [ids[2]], index: 2, advance: 1 });
            await end(page);
            state = await settled(page);
            expectOutcome('same-spotify-uri-consecutive', state, { starts: [ids[2], ids[3]], index: 3, advance: 1 });
        });
        // 10. Stale Ended from a superseded playback run.
        await run('stale-ended-superseded-by-jump', async page => {
            await jump(page, 1);
            await end(page, true);
            const selected = await jump(page, 3);
            await resolveEnd(page);
            expectOutcome('stale-ended-superseded-by-jump', await settled(page), { starts: [], index: selected.queue.currentIndex });
        });
        await run('stale-ended-redelivered-after-repeat', async page => {
            const before = await jump(page, 1);
            await setRepeat(page, true);
            await end(page);
            await settled(page);
            await redeliver(page);
            expectOutcome('stale-ended-redelivered-after-repeat', await settled(page), { starts: [before.queue.entries[1].id], index: 1, repeat: 1 });
        });
        await run('stale-ended-redelivered-after-advance', async page => {
            const before = await jump(page, 0);
            await end(page);
            await settled(page);
            await redeliver(page);
            expectOutcome('stale-ended-redelivered-after-advance', await settled(page), { starts: [before.queue.entries[1].id], index: 1, advance: 1 });
        });

        fs.mkdirSync(RESULT_DIR, { recursive: true });
        fs.writeFileSync(path.join(RESULT_DIR, 'contract-result.json'), JSON.stringify({
            completedAt: new Date().toISOString(), status: failures.length ? 'FAIL' : 'PASS', passed,
            total: passed + failures.length, failures, counts,
            evidence: 'real queue + WAV + pointer replay; mocked Ended/settle/released Stop; no live Spotify proof'
        }, null, 2));
        if (failures.length) {
            for (const failure of failures) console.error(`FAIL [${failure.id}] ${failure.message.split('\n').slice(0, 3).join(' ')}`);
            console.error(`AUDIOFLIX_QUEUE_COMPLETION_CONTRACT_SMOKE_FAIL ${passed}/${passed + failures.length}`);
            process.exitCode = 1;
        } else {
            console.log(`AUDIOFLIX_QUEUE_COMPLETION_CONTRACT_SMOKE_OK ${passed}/${passed}`);
            if (process.argv.includes('--verbose')) console.log(JSON.stringify(counts));
        }
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(`FAIL [queue-completion-contract] ${String(error.stack || error).split('\n').slice(0, 8).join('\n')}`);
    process.exitCode = 1;
});
