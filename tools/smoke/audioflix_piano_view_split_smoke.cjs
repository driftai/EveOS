#!/usr/bin/env node
'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const repo = path.resolve(__dirname, '../..');
const ui = fs.readFileSync(path.join(repo, 'js/modules/features/audioflix/audioflix.piano.ui.js'), 'utf8');
const mode = fs.readFileSync(path.join(repo, 'js/modules/features/audioflix/audioflix.piano.views.js'), 'utf8');
const css = fs.readFileSync(path.join(repo, 'js/modules/features/audioflix/audioflix.piano.css'), 'utf8');
const html = fs.readFileSync(path.join(repo, 'EveOS.html'), 'utf8');
assert(html.indexOf('audioflix.piano.views.js') < html.indexOf('audioflix.piano.ui.js'), 'mode controller must precede host UI');
assert(ui.includes('data-piano-backend') && ui.includes('data-piano-frontend'), 'both view surfaces must exist');
assert(!ui.includes('window.EveAudioflixPiano.stop() : window.EveAudioflixPiano.start());\n            window.EveAudioflixPianoViews'), 'view switch must not dispatch service lifecycle');

async function probe(browser, width) {
    const page = await browser.newPage({ viewport: { width, height: 850 } });
    try {
        await page.setContent('<!doctype html><html><head></head><body style="background:#090f12;margin:0"><main id="test-root"></main></body></html>');
        await page.addStyleTag({ content: css });
        await page.addScriptTag({ content: mode });
        await page.addScriptTag({ content: fs.readFileSync(path.join(repo, 'js/modules/features/audioflix/audioflix.piano.frontend.js'), 'utf8') });
        await page.addScriptTag({ content: ui });
        await page.evaluate(() => {
            window.EveAudioflixPiano = {
                state: { running: true, installed: true, phase: 'running', url: 'about:blank', message: 'Piano Auto Player is online locally.' },
                serviceUrl: () => 'about:blank',
                refresh: async () => {},
                start: async () => { throw new Error('view switch unexpectedly started service'); },
                stop: async () => { throw new Error('view switch unexpectedly stopped service'); },
                setup: async () => { throw new Error('view switch unexpectedly ran setup'); }
            };
            window.EveAudioflixState = { getSnapshot: () => ({}) };
            const root = document.getElementById('test-root');
            root.innerHTML = window.EveAudioflixPianoUi.render();
            window.EveAudioflixPianoUi.afterRender(root);
            root.addEventListener('click', event => {
                const action = event.target.closest('[data-af-action]');
                if (action) void window.EveAudioflixPianoUi.handleAction(action);
            });
            window.__firstFrame = root.querySelector('[data-piano-frame]');
        });
        await page.waitForFunction(() => document.querySelector('[data-piano-frame]')?.contentWindow?.document?.readyState === 'complete');
        await page.evaluate(() => { window.__firstFrame.contentWindow.keepAliveMarker = 421; });
        const state = () => page.evaluate(() => {
            const panel = document.querySelector('[data-audioflix-piano]');
            const backend = panel.querySelector('[data-piano-backend]');
            const frontend = panel.querySelector('[data-piano-frontend]');
            const frame = panel.querySelector('[data-piano-frame]');
            const stage = panel.querySelector('.audioflix-piano-stage');
            const toggle = panel.querySelector('[data-piano-view-switch]');
            return {
                view: panel.dataset.pianoView, title: panel.querySelector('[data-piano-view-title]').textContent,
                backendHidden: backend.getAttribute('aria-hidden'), backendInert: backend.inert,
                backendOpacity: getComputedStyle(backend).opacity, backendEvents: getComputedStyle(backend).pointerEvents,
                frontendHidden: frontend.hidden, frontendVisible: !!frontend.getClientRects().length,
                frontendChildren: frontend.children.length, frontendInert: frontend.inert,
                buttonText: toggle.textContent, buttonLabel: toggle.getAttribute('aria-label'),
                iframeSame: frame === window.__firstFrame, frameSource: frame.getAttribute('src'),
                iframeMarker: frame.contentWindow.keepAliveMarker, frameHidden: frame.hidden,
                offlineHidden: panel.querySelector('[data-piano-offline]').hidden,
                stageWidth: stage.clientWidth, stageScrollWidth: stage.scrollWidth,
                pageWidth: document.documentElement.clientWidth, pageScroll: document.documentElement.scrollWidth
            };
        });
        let initial = await state();
        assert.equal(initial.view, 'backend');
        assert.match(initial.title, /Backend$/);
        assert.equal(initial.frontendHidden, true);
        assert.equal(initial.iframeMarker, 421);
        assert.equal(initial.backendInert, false);
        await page.locator('[data-piano-view-switch]').click();
        let front = await state();
        assert.equal(front.view, 'frontend');
        assert.equal(front.title, 'Piano Library');
        assert.equal(front.frontendHidden, false);
        assert.equal(front.frontendVisible, true);
        assert.ok(front.frontendChildren > 0, 'frontend must contain the new library surface');
        assert.equal(front.backendHidden, 'true');
        assert.equal(front.backendInert, true);
        assert.equal(front.backendOpacity, '0');
        assert.equal(front.backendEvents, 'none');
        assert.equal(front.iframeSame, true, 'switch may not recreate backend iframe');
        assert.equal(front.iframeMarker, 421, 'switch must not reload backend document');
        assert.equal(front.frameSource, initial.frameSource);
        assert.equal(front.buttonText, 'Backend tools');
        assert(front.pageScroll <= front.pageWidth + 2, `horizontal overflow at ${width}px`);
        // Service changes must still be reflected while viewing the song-first frontend.
        await page.evaluate(() => {
            window.EveAudioflixPiano.state = {
                running: false, installed: true, phase: 'stopped', message: 'Piano Auto Player is stopped.'
            };
            window.EveAudioflixPianoUi.afterRender(document.getElementById('test-root'));
        });
        const offlineFront = await state();
        assert.equal(offlineFront.view, 'frontend');
        assert.equal(offlineFront.frameHidden, true);
        assert.equal(offlineFront.offlineHidden, false);
        assert.equal(offlineFront.frontendVisible, true);
        await page.locator('[data-piano-view-switch]').click();
        const offlineBackend = await state();
        assert.equal(offlineBackend.view, 'backend');
        assert.equal(offlineBackend.offlineHidden, false);
        assert.equal(offlineBackend.frontendHidden, true);
        // Return online; the view must not reset the service or share a second iframe.
        await page.evaluate(() => {
            window.EveAudioflixPiano.state = { running: true, installed: true, phase: 'running', url: 'about:blank' };
            window.EveAudioflixPianoUi.afterRender(document.getElementById('test-root'));
        });
        assert.equal((await state()).iframeSame, true);
        assert.equal((await state()).frameHidden, false);
        await page.locator('[data-piano-view-switch]').click();
        // Ordinary outer UI re-render is allowed to remount, but must restore the selected view.
        await page.evaluate(() => {
            const root = document.getElementById('test-root');
            root.innerHTML = window.EveAudioflixPianoUi.render();
            window.EveAudioflixPianoUi.afterRender(root);
        });
        let remount = await state();
        assert.equal(remount.view, 'frontend', 'view state must survive an ordinary Audioflix rerender');
        assert.ok(remount.frontendChildren > 0);
        console.log(`PIANO_VIEW_SPLIT_BROWSER_OK viewport=${width} backend=PASS song-frontend=PASS iframe-preserved=PASS offline=PASS remount=PASS`);
    } finally {
        await page.close();
    }
}

(async () => {
    const browser = await chromium.launch({ headless: true });
    try {
        for (const width of [1600, 1080, 760, 480]) await probe(browser, width);
        console.log('EVEOS_PIANO_VIEW_SPLIT_BROWSER_PASS');
    } finally {
        await browser.close();
    }
})().catch(err => { console.error(err.stack || err); process.exitCode = 1; });
