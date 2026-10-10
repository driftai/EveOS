#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', '..');

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
        await page.setContent(`<!doctype html><html><head><style>
            body { margin: 24px; font-family: sans-serif; }
            .audioflix-provider-stage { display: block; width: 520px; padding: 12px; }
            .audioflix-provider-queue-list { display: grid; gap: 6px; padding: 0; margin: 8px 0; list-style: none; }
            .audioflix-provider-queue-list button { display: block; width: 100%; min-height: 36px; }
        </style></head><body></body></html>`);

        await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix/audioflix.audio.internal.js') });
        await page.addScriptTag({ path: path.join(ROOT, 'js/modules/features/audioflix/audioflix.queue.completion.js') });

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

        console.log('AUDIOFLIX_QUEUE_VIEW_POINTER_BROWSER_OK stableNode=true realPointer=true jumps=1');
    } finally {
        await browser.close();
    }
})().catch((error) => {
    console.error('AUDIOFLIX_QUEUE_VIEW_POINTER_BROWSER_FAILED');
    console.error(error?.stack || error);
    process.exit(1);
});
