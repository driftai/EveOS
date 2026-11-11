#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');
const evidence = { cases: [], pageErrors: [] };
const resultFile = path.join(ROOT, `data/runtime/smoke-results/audioflix-hidden-queue-browser-${Date.now()}.json`);

async function hiddenQueueLifecycle(page) {
    const result = await page.evaluate(async () => {
        const queue = { entries: Array.from({ length: 25000 }, (_, index) => ({
            id: `large-${index}`, title: `Large track ${index}`
        })), currentIndex: 0, playbackRunId: 1, isPlaying: true, repeatOne: false };
        const calls = { jump: [], move: [], advance: 0 };
        const c = window.EveAudioflixInternalPlayer.createController({ onJump: index => calls.jump.push(index) });
        window.EveAudioflix = { queueConnection: {
            snapshot: () => queue,
            move(from, to) {
                const currentId = queue.entries[queue.currentIndex].id;
                queue.entries.splice(to, 0, queue.entries.splice(from, 1)[0]);
                queue.currentIndex = queue.entries.findIndex(entry => entry.id === currentId);
                calls.move.push([from, to]); c.setQueue(queue.entries, queue.currentIndex);
            }
        } };
        const rows = () => c.getStage().querySelector('.audioflix-provider-queue-list').children;
        const read = () => ({ rows: rows().length, nodes: c.getStage().querySelectorAll('*').length,
            grips: c.getStage().querySelectorAll('.audioflix-queue-drag-handle').length,
            orderButtons: c.getStage().querySelectorAll('[data-queue-move]').length,
            current: rows()[queue.currentIndex]?.textContent.trim(), index: queue.currentIndex,
            item: c.getItem()?.id, title: c.getStage().querySelector('header strong').textContent,
            gain: Number(c.getStage().querySelector('.audioflix-provider-volume').value) });
        c.setQueue(queue.entries, 0);
        const hidden = read();
        c.open({ id: 'large-0', title: 'Large track 0', volume: 0.41 }, 'Direct audio', { visible: false });
        c.setQueue(queue.entries, 0);
        const transport = read();
        c.setExpanded(true);
        const immediateShownRows = rows().length;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const shown = read();
        queue.currentIndex = 7; queue.playbackRunId += 1;
        c.sync({ item: { id: 'large-7', title: 'Latest handoff', volume: 0.29 }, paused: false, duration: 90 });
        c.setVolume(0.29); c.setQueue(queue.entries, 7);
        window.EveAudioflix.queueConnection.move(7, 3);
        const reordered = read();
        c.hide();
        const released = read();
        queue.entries[3].title = 'Hidden & latest'; queue.repeatOne = true;
        c.setQueue(queue.entries, 3);
        const hiddenLatest = read();
        c.setExpanded(true);
        const reopened = { ...read(), repeat: c.getStage().querySelector('[data-url-player-action="repeat-one"]').getAttribute('aria-pressed'),
            prevDisabled: c.getStage().querySelector('[data-url-player-action="prev"]').disabled,
            nextDisabled: c.getStage().querySelector('[data-url-player-action="next"]').disabled };
        c.setQueue(queue.entries, queue.currentIndex);
        c.getStage().querySelector('.audioflix-provider-queue-list').replaceChildren();
        c.setQueue(queue.entries.slice(), queue.currentIndex);
        const invalidated = read();
        c.getStage().querySelector('[data-url-player-action="collapse"]').click();
        const collapsed = read();
        c.open({ id: 'large-3', title: 'Collapsed handoff', volume: 0.29 }, 'Direct audio', { expanded: true });
        c.setQueue(queue.entries, queue.currentIndex);
        const collapsedHandoff = { ...read(), collapsed: c.getStage().classList.contains('is-collapsed') };
        c.getStage().querySelector('[data-url-player-action="collapse"]').click();
        const expanded = read();
        c.setTransportOnly(true);
        const transportReleased = read();
        c.setTransportOnly(false);
        const transportRestored = read();
        c.revealTransportFallback();
        const fallbackReleased = read();
        c.setExpanded(true); c.setQueue([], 0);
        const emptied = read();
        const completion = window.EveAudioflixQueueCompletion.create({ snapshot: () => queue,
            advance: () => { calls.advance += 1; queue.currentIndex += 1; queue.playbackRunId += 1; },
            restart: () => { throw new Error('unexpected repeat'); } });
        queue.repeatOne = false;
        const beforeEnd = { ...calls, jump: calls.jump.slice(), move: calls.move.slice() };
        const detail = { status: 'Ended', item: queue.entries[queue.currentIndex] };
        const ended = [completion(detail), completion(detail)];
        await new Promise(resolve => setTimeout(resolve, 0));
        c.destroy(); c.setQueue(queue.entries, queue.currentIndex);
        const destroyedHidden = read();
        c.setExpanded(true);
        const recreated = read();
        c.destroy();
        return { hidden, transport, immediateShownRows, shown, reordered, released, hiddenLatest, reopened, invalidated, collapsed, collapsedHandoff, expanded,
            transportReleased, transportRestored, fallbackReleased, emptied, beforeEnd, ended, calls, destroyedHidden, recreated };
    });
    evidence.lifecycle = result;
    assert.equal(result.immediateShownRows, 25000, 'show mounts latest rows synchronously, without a new scheduler');
    assert.equal(result.shown.grips, 25000, 'actual reorder decorator enhances every visible row');
    assert.equal(result.shown.orderButtons, 50000, 'actual reorder decorator provides both order controls on every row');
    for (const phase of ['hidden', 'transport', 'released', 'hiddenLatest', 'collapsed', 'transportReleased', 'fallbackReleased', 'emptied', 'destroyedHidden']) {
        assert.equal(result[phase].rows, 0, `${phase}: invisible/empty queue must release every row`);
        assert.ok(result[phase].nodes < 100, `${phase}: hidden controller DOM stays independent of 25k queue entries`);
    }
    for (const phase of ['shown', 'reordered', 'reopened', 'invalidated', 'expanded', 'transportRestored', 'recreated']) {
        assert.equal(result[phase].rows, 25000, `${phase}: visible queue restores all canonical rows immediately`);
    }
    assert.equal(result.reordered.current, '▶ Large track 7');
    assert.equal(result.reordered.index, 3, 'reorder retains the current track identity');
    assert.equal(result.reopened.current, '▶ Hidden & latest', 'reopen renders latest escaped metadata');
    assert.equal(result.invalidated.current, '▶ Hidden & latest', 'identical semantic state restores invalidated row DOM');
    assert.equal(result.reopened.item, 'large-7', 'queue DOM lifecycle cannot switch playback identity');
    assert.equal(result.reopened.title, 'Latest handoff', 'handoff title stays synchronized');
    assert.equal(result.reopened.gain, 0.29, 'handoff volume stays synchronized');
    assert.equal(result.collapsedHandoff.collapsed, true,
        'a song handoff must preserve the user-collapsed Internal Player');
    assert.equal(result.reopened.repeat, 'true');
    assert.equal(result.reopened.prevDisabled, false); assert.equal(result.reopened.nextDisabled, false);
    assert.deepEqual(result.beforeEnd, { jump: [], move: [[7, 3]], advance: 0 }, 'visibility lifecycle causes no queue jump/advance');
    assert.deepEqual(result.ended, [true, false], 'one real completion owner claims the Ended callback once');
    assert.equal(result.calls.advance, 1, 'deferred row mounting never adds a second queue advancement');
    evidence.cases.push('hidden-25k-lifecycle', 'handoff-reorder-latest-identity', 'completion-owner-unchanged');
}

(async () => {
    let browser;
    try {
        browser = await chromium.launch({ headless: true });
    } catch (error) {
        console.error('AUDIOFLIX_QUEUE_VIEW_POINTER_BROWSER_SETUP_FAILED');
        console.error(error?.message || error);
        console.error('Install the tracked Playwright Chromium runtime with: npx playwright install chromium');
        process.exit(2);
    }

    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
        page.on('pageerror', error => evidence.pageErrors.push(String(error)));
        await page.setContent(`<!doctype html><html><head><style>
            [hidden] { display: none !important; }
            body { margin: 24px; font-family: sans-serif; }
            .audioflix-provider-stage { display: block; width: 520px; padding: 12px; }
            .audioflix-provider-queue-list { display: grid; gap: 6px; padding: 0; margin: 8px 0; list-style: none; }
            .audioflix-provider-queue-list button { display: block; width: 100%; min-height: 36px; }
        </style></head><body></body></html>`);

        await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix/audioflix.audio.internal.queue.js') });
        await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix/audioflix.audio.internal.js') });
        await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix/audioflix.queue.completion.js') });
        await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix/audioflix.queue.reorder.js') });
        await hiddenQueueLifecycle(page);

        await page.evaluate(() => {
            window.EveAudioflix = window.EveAudioflix || {};
            window.EveAudioflix.queueConnection = {
                snapshot: () => ({ repeatOne: false })
            };
            window.__queueJumps = [];
            window.__queueEntries = [
                { id: 'alpha', title: 'Alpha' },
                { id: 'beta', title: 'Beta' },
                { id: 'gamma', title: 'Gamma' }
            ];
            window.__queueController = window.EveAudioflixInternalPlayer.createController({
                onJump(index) { window.__queueJumps.push(index); }
            });
            window.__queueController.setQueue(window.__queueEntries, 0);
            window.__queueController.setExpanded(true);
            window.__heldButton = document.querySelector('[data-url-player-action="queue-jump"][data-queue-index="1"]');
            if (!window.__heldButton) throw new Error('target queue button was not rendered');
        });

        const button = page.locator('[data-url-player-action="queue-jump"][data-queue-index="1"]');
        const box = await button.boundingBox();
        assert.ok(box, 'queue-jump button must be visible to real pointer input');
        const x = box.x + box.width / 2;
        const y = box.y + box.height / 2;

        await page.mouse.move(x, y);
        await page.mouse.down();
        const preserved = await page.evaluate(() => {
            for (let index = 0; index < 30; index += 1) {
                window.__queueController.setQueue(
                    window.__queueEntries.map((entry) => ({ ...entry })),
                    0
                );
            }
            return document.querySelector('[data-url-player-action="queue-jump"][data-queue-index="1"]') === window.__heldButton;
        });
        await page.mouse.up();
        await page.waitForTimeout(25);

        assert.equal(preserved, true,
            'redundant queue synchronization must preserve the exact hovered/pressed DOM button');
        const jumps = await page.evaluate(() => window.__queueJumps.slice());
        assert.deepEqual(jumps, [1],
            'one real pointer down/up sequence across redundant queue sync must dispatch exactly one queue jump');
        assert.deepEqual(evidence.pageErrors, [], 'no browser page errors');
        evidence.cases.push('real-pointer-stable-no-op'); evidence.passed = true;
        console.log('AUDIOFLIX_QUEUE_VIEW_POINTER_BROWSER_OK PASS 4/4 hidden25kRows=0 restored=25000 stableNode=true realPointer=true jumps=1');
    } finally {
        fs.mkdirSync(path.dirname(resultFile), { recursive: true });
        fs.writeFileSync(resultFile, JSON.stringify(evidence, null, 2));
        await browser.close();
    }
})().catch((error) => {
    console.error('AUDIOFLIX_QUEUE_VIEW_POINTER_BROWSER_FAILED');
    console.error(error?.stack || error);
    process.exit(1);
});
