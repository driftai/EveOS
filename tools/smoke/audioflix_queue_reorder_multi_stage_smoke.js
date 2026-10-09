'use strict';
// Every internal-player stage (linked audio and the managed Spotify engine) renders the same
// queue list. The reorder layer must give each one the same drag handle and move buttons, with
// row indexes scoped to that list, or the Spotify queue loses its controls and its titles wrap
// one word per line in the 18px handle column.
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

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

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        const page = await browser.newPage({ viewport: { width: 900, height: 900 } });
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

        await page.click('[data-stage="spotify-engine"] li:nth-child(2) [data-queue-move="1"]');
        await page.click('[data-stage="linked"] li:nth-child(1) [data-queue-move="1"]');
        assert.deepStrictEqual(await page.evaluate(() => window.__moves), [[1, 2], [0, 1]],
            'move buttons report indexes scoped to their own stage list');
        console.log('AUDIOFLIX_QUEUE_REORDER_MULTI_STAGE_SMOKE_OK');
    } finally {
        await browser.close();
    }
})().catch((error) => { console.error(error); process.exit(1); });
