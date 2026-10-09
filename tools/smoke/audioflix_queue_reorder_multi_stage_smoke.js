'use strict';
// Every internal-player stage (linked audio and the managed Spotify engine) renders the same
// queue list. The reorder layer must give each one the same drag handle and move buttons, with
// row indexes scoped to that list, or the Spotify queue loses its controls and its titles wrap
// one word per line in the 18px handle column.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const fixtureTools = require('./helpers/audioflix_queue_completion_fixture');
const { LIST, RESULT_DIR, createFixture, snapshot, pointerClick, libraryAction, select,
    end, armEndAtPointer, resolveEnd, deferRestartSeek, resolveSeek, unchanged, completedOnce, saveFailure } = fixtureTools;

const root = path.resolve(__dirname, '..', '..');
const reorderSource = fs.readFileSync(path.join(root, 'js/modules/features/audioflix/audioflix.queue.reorder.js'), 'utf8');
const reorderCss = fs.readFileSync(path.join(root, 'js/modules/features/audioflix/audioflix.queue.reorder.css'), 'utf8');

const stage = (name, current) => `
    <section class="audioflix-provider-stage is-internal-view" data-stage="${name}">
        <div class="audioflix-provider-queue"><strong>Up next</strong><ol class="audioflix-provider-queue-list">
            ${['A Quick One Before the Eternal Worm Devours Connecticut', 'Glimpse', 'Third'].map((title, index) =>
                `<li${index === current ? ' class="is-current"' : ''}><button type="button" data-url-player-action="queue-jump" data-queue-index="${index}">${title}</button></li>`).join('')}
        </ol></div>
    </section>`;

async function checkStageGeometry(browser) {
    const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
    try {
        await page.setContent(`<!doctype html><html><head><style>${reorderCss}
            .audioflix-provider-stage { width: 560px; } .audioflix-provider-queue-list { margin: 0; padding: 0; list-style: none; }
            .audioflix-provider-queue-list li button { white-space: normal; }</style></head>
            <body>${stage('linked', 0)}${stage('spotify-engine', 1)}</body></html>`);
        await page.evaluate(() => {
            window.__moves = [];
            window.EveAudioflix = { queueConnection: { move: (from, to) => window.__moves.push([from, to]) } };
        });
        await page.addScriptTag({ content: reorderSource });
        await page.waitForFunction(() => window.EveAudioflixQueueReorder?.ready === true);

        const result = await page.evaluate(() => [...document.querySelectorAll('.audioflix-provider-queue-list')].map((list) => ({
            stage: list.closest('[data-stage]').dataset.stage,
            handles: list.querySelectorAll('.audioflix-queue-drag-handle').length,
            moveButtons: list.querySelectorAll('[data-queue-move]').length,
            firstUpDisabled: list.querySelector('[data-queue-move="-1"]').disabled,
            lastDownDisabled: [...list.querySelectorAll('[data-queue-move="1"]')].pop().disabled,
            titleWidth: list.querySelector('.audioflix-queue-entry-main').getBoundingClientRect().width
        })));
        assert.equal(result.length, 2);
        for (const list of result) {
            assert.equal(list.handles, 3, `${list.stage} queue rows get drag handles`);
            assert.equal(list.moveButtons, 6, `${list.stage} queue rows get up/down buttons`);
            assert.equal(list.firstUpDisabled, true, `${list.stage} first row cannot move up`);
            assert.equal(list.lastDownDisabled, true, `${list.stage} last row cannot move down`);
            assert.ok(list.titleWidth > 300, `${list.stage} title uses the row's main column (${list.titleWidth}px), not the 18px handle column`);
        }

        await pointerClick(page, '[data-stage="spotify-engine"] li:nth-child(2) [data-queue-move="1"]');
        await pointerClick(page, '[data-stage="linked"] li:nth-child(1) [data-queue-move="1"]');
        assert.deepStrictEqual(await page.evaluate(() => window.__moves), [[1, 2], [0, 1]],
            'move buttons report indexes scoped to their own stage list');
    } finally {
        await page.close();
    }
}

async function moveCurrentToFirst(page) {
    let before = await snapshot(page);
    while (before.queue.currentIndex > 0) {
        await pointerClick(page, `${LIST} li:nth-child(${before.queue.currentIndex + 1}) [data-queue-move="-1"]`);
        const after = await snapshot(page);
        assert.strictEqual(after.queue.currentIndex, before.queue.currentIndex - 1, 'arrow moves the playing row upward');
        before = after;
    }
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    let fixture, passed = 0;
    const failures = [];
    async function run(id, work) {
        try {
            const priorErrors = fixture?.diagnostics.pageErrorCount || 0;
            await work();
            if (fixture) assert.strictEqual(fixture.diagnostics.pageErrorCount, priorErrors, 'no browser page errors during queue action');
            passed += 1;
        } catch (error) {
            const state = fixture ? await saveFailure(fixture, id, error) : null;
            failures.push({ id, message: String(error.message || error), state });
        } finally {
            if (fixture) {
                await resolveEnd(fixture.page);
                await resolveSeek(fixture.page);
                await fixture.page.waitForTimeout(150);
                // A failing repeat/loop assertion must not change the next case's semantics.
                await fixture.page.evaluate(async () => {
                    const queue = window.EveAudioflix.queueConnection;
                    if (queue.snapshot().repeatOne) queue.action('repeat-one');
                    if (queue.snapshot().loop) await queue.action('loop-music-group');
                });
            }
        }
    }
    try {
        await run('multi-stage-reorder-geometry', () => checkStageGeometry(browser));
        fixture = await createFixture(browser, root);
        const page = fixture.page;

        await run('spotify-ended-after-shuffle', async () => {
            const before = await select(page, 2);
            await libraryAction(page, 'shuffle-music-group');
            const shuffled = await snapshot(page);
            assert.strictEqual(shuffled.queue.currentIndex, 0, 'Shuffle Order rebases the playing item to #1');
            assert.strictEqual(shuffled.playback.id, before.playback.id, 'shuffle preserves the playing item');
            assert.deepStrictEqual(shuffled.starts, [], 'shuffle does not restart playback');
            await end(page);
            await completedOnce(page, shuffled.queue.entries[1].id, 1);
            const advanced = await snapshot(page);
            await end(page, false, before.playback.id);
            await unchanged(page, advanced, 'stale Spotify Ended cannot advance a different playing item');
        });

        await run('spotify-ended-after-arrow-to-first', async () => {
            const before = await select(page, 2);
            await moveCurrentToFirst(page);
            const moved = await snapshot(page);
            assert.strictEqual(moved.playback.id, before.playback.id, 'arrows preserve the playing item');
            assert.deepStrictEqual(moved.starts, [], 'arrows do not restart playback');
            await end(page);
            await completedOnce(page, moved.queue.entries[1].id, 1);
        });

        await run('spotify-ended-after-drag-to-first', async () => {
            const before = await select(page, 2);
            // Native HTML drag uses real browser pointer input, not a synthetic drop event.
            await page.dragAndDrop(`${LIST} li:nth-child(3) .audioflix-queue-drag-handle`, `${LIST} li:first-child`);
            const moved = await snapshot(page);
            assert.strictEqual(moved.queue.currentIndex, 0, 'drag moves the playing item to #1');
            assert.strictEqual(moved.playback.id, before.playback.id, 'drag preserves the playing item');
            assert.deepStrictEqual(moved.starts, [], 'drag does not restart playback');
            await end(page);
            await completedOnce(page, moved.queue.entries[1].id, 1);
        });

        await run('pending-settle-does-not-advance-early', async () => {
            const before = await select(page, 1);
            await end(page, true);
            await unchanged(page, before, 'completion must wait for the provider settle promise');
            await resolveEnd(page);
            await completedOnce(page, before.queue.entries[2].id, 2);
        });

        for (const method of ['arrow', 'shuffle']) {
            await run(`pending-settle-${method}-uses-latest-order`, async () => {
                const before = await select(page, 2);
                const selector = method === 'arrow' ? '[data-queue-move="-1"]' : '[data-af-action="shuffle-music-group"]';
                await armEndAtPointer(page, selector);
                if (method === 'arrow') await moveCurrentToFirst(page);
                else await libraryAction(page, 'shuffle-music-group');
                const reordered = await snapshot(page);
                assert.strictEqual(reordered.queue.currentIndex, 0, 'pending completion keeps playing item at reordered #1');
                assert.strictEqual(reordered.playback.id, before.playback.id, 'pending reorder preserves the playing identity');
                assert.strictEqual(reordered.pending, true, 'provider completion remains pending after pointer reorder');
                await unchanged(page, reordered, 'reorder must not bypass pending completion');
                await resolveEnd(page);
                await completedOnce(page, reordered.queue.entries[1].id, 1);
            });
        }

        for (const choice of ['same', 'different']) {
            await run(`pending-settle-manual-${choice}-selection-invalidates`, async () => {
                await select(page, 1);
                const index = choice === 'same' ? 1 : 3;
                await armEndAtPointer(page, '[data-url-player-action="queue-jump"]');
                const selected = await select(page, index);
                assert.strictEqual(selected.pending, true, 'manual selection occurred while completion was pending');
                await resolveEnd(page);
                await unchanged(page, selected, 'old completion cannot advance a newly selected playback run');
            });
        }

        await run('pending-settle-explicit-restart-invalidates', async () => {
            const before = await select(page, 1);
            await armEndAtPointer(page, '[data-url-player-action="restart"]');
            await pointerClick(page, '[data-url-player-action="restart"]');
            await page.waitForFunction(() => window.__queueSmoke.starts.length > 0
                && window.EveAudioflixAudio.getPlaybackState()?.paused === false, undefined, { timeout: 3000 });
            const restarted = await snapshot(page);
            assert.strictEqual(restarted.pending, true, 'Restart occurred while old completion was pending');
            assert.strictEqual(restarted.playback.id, before.playback.id, 'Restart plays the same item in a new run');
            assert.strictEqual(restarted.queue.currentIndex, 1, 'Restart preserves the queue slot');
            assert.strictEqual(restarted.starts.length, 1, 'explicit Restart starts the item once');
            await unchanged(page, restarted, 'old completion cannot bypass pending settle after Restart');
            await resolveEnd(page);
            await unchanged(page, restarted, 'old completion cannot advance the restarted playback run');
        });

        await run('deferred-restart-manual-selection-invalidates', async () => {
            await select(page, 1);
            await deferRestartSeek(page);
            await pointerClick(page, '[data-url-player-action="restart"]');
            await page.waitForFunction(() => window.__queueSmoke.seekPending === true, undefined, { timeout: 3000 });
            assert.deepStrictEqual((await snapshot(page)).starts, [], 'Restart is still awaiting seek completion');
            const selected = await select(page, 3);
            await resolveSeek(page);
            await unchanged(page, selected, 'old delayed Restart cannot replay over a manually selected song');
        });

        await run('spotify-repeat-one-completion-once', async () => {
            const before = await select(page, 1);
            await pointerClick(page, '[data-url-player-action="repeat-one"]');
            await end(page);
            await completedOnce(page, before.playback.id, 1);
            await pointerClick(page, '[data-url-player-action="repeat-one"]');
        });

        await run('spotify-loop-boundary-completion-once', async () => {
            await libraryAction(page, 'loop-music-group');
            const before = await select(page, 3);
            await end(page);
            const expected = (await snapshot(page)).queue.entries[0].id;
            await completedOnce(page, expected, 0);
            const advanced = await snapshot(page);
            await end(page, false, before.playback.id);
            await unchanged(page, advanced, 'stale Ended after a loop boundary cannot skip #1');
            await libraryAction(page, 'loop-music-group');
        });

        await run('pending-settle-stop-invalidates', async () => {
            await select(page, 1);
            await armEndAtPointer(page, '[data-af-action="stop-music-group"]');
            await libraryAction(page, 'stop-music-group');
            const stopped = await snapshot(page);
            assert.strictEqual(stopped.queue.isPlaying, false, 'Stop ends queue ownership');
            assert.deepStrictEqual(stopped.starts, [], 'Stop cannot start another track');
            await resolveEnd(page);
            await unchanged(page, stopped, 'old completion cannot resume a stopped queue');
        });

        await run('deferred-restart-stop-invalidates', async () => {
            await libraryAction(page, 'play-music-group');
            await page.waitForFunction(() => window.EveAudioflix.queueConnection.snapshot().isPlaying
                && window.EveAudioflixAudio.getPlaybackState()?.paused === false, undefined, { timeout: 5000 });
            await select(page, 1);
            await deferRestartSeek(page);
            await pointerClick(page, '[data-url-player-action="restart"]');
            await page.waitForFunction(() => window.__queueSmoke.seekPending === true, undefined, { timeout: 3000 });
            await libraryAction(page, 'stop-music-group');
            const stopped = await snapshot(page);
            assert.strictEqual(stopped.queue.isPlaying, false, 'Stop ends queue ownership during delayed Restart');
            assert.deepStrictEqual(stopped.starts, [], 'delayed Restart has not started another song');
            await resolveSeek(page);
            await unchanged(page, stopped, 'old delayed Restart cannot resume a stopped queue');
        });

        fs.mkdirSync(RESULT_DIR, { recursive: true });
        fs.writeFileSync(path.join(RESULT_DIR, 'result.json'), JSON.stringify({
            completedAt: new Date().toISOString(), status: failures.length ? 'FAIL' : 'PASS', passed,
            total: passed + failures.length, failures, state: await snapshot(page), ...fixture.diagnostics,
            evidence: 'isolated real queue + WAV + pointer; mocked Spotify-provenance Ended/settle; no live Spotify proof'
        }, null, 2));
        if (failures.length) {
            fs.writeFileSync(path.join(RESULT_DIR, 'summary.json'), JSON.stringify({ passed, failures }, null, 2));
            await fixture.context.tracing.stop({ path: path.join(RESULT_DIR, 'trace.zip') });
            for (const failure of failures) console.error(`FAIL [${failure.id}] ${failure.message.split('\n').slice(0, 2).join(' ')}`);
            console.error(`AUDIOFLIX_QUEUE_REORDER_MULTI_STAGE_SMOKE_FAIL ${passed}/${passed + failures.length}; artifacts: ${RESULT_DIR}`);
            process.exitCode = 1;
        } else {
            await fixture.context.tracing.stop();
            console.log(`AUDIOFLIX_QUEUE_REORDER_MULTI_STAGE_SMOKE_OK ${passed}/${passed} (mocked Spotify Ended; real queue/WAV/pointer)`);
        }
    } finally {
        await browser.close();
    }
}

main().catch(error => {
    console.error(`FAIL [queue-completion-fixture] ${String(error.stack || error).split('\n').slice(0, 8).join('\n')}`);
    process.exitCode = 1;
});
