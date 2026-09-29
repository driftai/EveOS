'use strict';

const fs = require('fs');
const http = require('http');
const path = require('path');
const { launchChromiumOrConnect } = require('./playwright-browser');

const ROOT = path.resolve(__dirname, '..', '..');
const asset = (...parts) => path.join(ROOT, 'tools', 'World-Book', 'app', ...parts);
const read = (...parts) => fs.readFileSync(asset(...parts), 'utf8');
const expect = (condition, message) => {
    if (!condition) throw new Error(message);
};

async function listen(server) {
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
    });
    return server.address().port;
}

async function main() {
    const server = http.createServer((_request, response) => {
        response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        response.end('<!doctype html><html><head></head><body></body></html>');
    });
    const port = await listen(server);
    const launched = await launchChromiumOrConnect({ headless: true });
    const context = await launched.browser.newContext();
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    try {
        await page.goto(`http://127.0.0.1:${port}/`);
        const fragment = read('fragments', 'dialogs-narration.html');
        await page.setContent(`<!doctype html><html><head></head><body>${fragment}</body></html>`);
        for (const css of [
            asset('assets', 'css', 'layers', '00-foundation.css'),
            asset('assets', 'css', 'layers', '10-tree-layout.css'),
            asset('assets', 'css', 'layers', '30-focus-links.css'),
            asset('assets', 'css', 'layers', '68-narration.css'),
            asset('assets', 'css', 'layers', '69-narration-responsive.css'),
            asset('assets', 'css', 'layers', '71-narration-quality.css'),
        ]) await page.addStyleTag({ path: css });

        await page.addScriptTag({ path: asset('assets', 'js', 'narration', 'text.js') });
        await page.addScriptTag({ path: asset('assets', 'js', 'narration', 'integrity.js') });
        await page.addScriptTag({ path: asset('assets', 'js', 'narration', 'store.js') });
        await page.addScriptTag({ path: asset('assets', 'js', 'narration', 'gemini.js') });

        const cache = await page.evaluate(async () => {
            const rejections = [];
            const onRejection = event => rejections.push(String(event.reason?.message || event.reason || 'unknown'));
            window.addEventListener('unhandledrejection', onRejection);
            const missing = await window.WorldBook.NarrationStore.getAudio(`missing-${Date.now()}`);
            await new Promise(resolve => setTimeout(resolve, 40));
            window.removeEventListener('unhandledrejection', onRejection);
            return { missingIsNull: missing === null, rejections };
        });
        expect(cache.missingIsNull, 'an IndexedDB cache miss returned a browser request instead of null');
        expect(cache.rejections.length === 0, `cache miss caused unhandled rejection: ${cache.rejections.join('; ')}`);

        const audio = await page.evaluate(async () => {
            let createBufferCalls = 0;
            class FakeAudioContext {
                constructor() {
                    this.currentTime = 0;
                    this.destination = {};
                }
                async resume() {}
                createBuffer(_channels, frames) {
                    createBufferCalls += 1;
                    return { getChannelData() { return new Float32Array(frames); } };
                }
                createBufferSource() {
                    const source = {
                        connect(node) { return node; },
                        start() { setTimeout(() => source.onended?.(), 0); },
                        stop() { setTimeout(() => source.onended?.(), 0); },
                    };
                    return source;
                }
                createGain() {
                    return { gain: { value: 1 }, connect() { return this; } };
                }
            }
            window.AudioContext = FakeAudioContext;
            const narrator = new window.WorldBook.GeminiNarrator();
            let invalidError = '';
            try {
                await narrator.play({ pcm: new ArrayBuffer(0), sampleRate: 24000 });
            } catch (error) {
                invalidError = error.message || String(error);
            }
            const callsAfterInvalid = createBufferCalls;
            await narrator.play({ pcm: new Int16Array([0, 1000, -1000, 0]).buffer, sampleRate: 24000 });
            return { invalidError, callsAfterInvalid, createBufferCalls };
        });
        expect(/empty or corrupt/i.test(audio.invalidError), `empty PCM was not rejected clearly: ${audio.invalidError}`);
        expect(audio.callsAfterInvalid === 0, 'empty PCM reached AudioContext.createBuffer');
        expect(audio.createBufferCalls === 1, 'valid PCM did not reach AudioContext exactly once');

        const marker = await page.evaluate(() => {
            const text = 'First sentence. Second bright word here.';
            const start = text.indexOf('bright');
            const range = window.WorldBook.NarrationText.markerRange(text, {
                charIndex: start,
                charLength: 'bright'.length,
            });
            const estimated = window.WorldBook.NarrationText.progressMarker(text, 0.7);
            return {
                sentence: text.slice(range.sentenceStart, range.sentenceEnd).trim(),
                word: text.slice(range.wordStart, range.wordEnd),
                estimatedValid: estimated.wordEnd > estimated.wordStart,
            };
        });
        expect(marker.sentence === 'Second bright word here.', `wrong sentence marker: ${marker.sentence}`);
        expect(marker.word === 'bright', `wrong word marker: ${marker.word}`);
        expect(marker.estimatedValid, 'Gemini progress did not resolve to a word marker');

        await page.evaluate(() => {
            const controller = new EventTarget();
            controller.browser = { voices() { return []; } };
            controller.source = { id: 'virtual:marker', title: 'Marker smoke' };
            controller.passages = ['First sentence. Second bright word here.'];
            for (const method of ['load', 'play', 'pause', 'stop', 'next', 'previous', 'seek', 'clearAudioCache', 'clearSourceCache', 'deleteCachedAudio']) {
                controller[method] = () => {};
            }
            const calls = { seeks: [], focuses: [] };
            controller.snapshot = () => ({ status: 'playing' });
            controller.seekProgress = (value, autoplay) => calls.seeks.push({ value: Number(value), autoplay });
            controller.focusCachedPassage = record => {
                calls.focuses.push(record.key);
                return { ok: true, message: `Moved to clip ${Number(record.passageIndex) + 1}.` };
            };
            controller.inspectCachedRecord = () => ({
                reading: { status: 'reading', label: 'Reading now' },
                source: { status: 'current', label: 'Source is current' },
                transcript: { status: 'match', label: 'Transcript matches source', similarity: 1 },
            });
            window.WorldBook.NarrationStore.inventory = async () => [{
                key: 'cache:marker:0',
                sourceId: 'virtual:marker',
                sourceTitle: 'Info',
                sourceLocator: 'World Book Manager / Characters / Leon / Info',
                passageIndex: 0,
                passageCount: 3,
                passagePreview: 'First sentence. Second bright word here.',
                voice: 'Aoede',
                model: 'models/gemini-2.5-flash-native-audio-latest',
                durationSec: 8.5,
                size: 2048,
                lastUsed: Date.now(),
                narrationPolicy: 'verbatim',
            }];
            window.WorldBook.API = {
                async getReaderDocuments() { return { documents: [] }; },
                readerDocumentDownloadUrl() { return '#'; },
            };
            window.WorldBook.Narration = controller;
            window.__readerSmokeController = controller;
            window.__readerSmokeCalls = calls;
        });
        await page.addScriptTag({ path: asset('assets', 'js', 'narration', 'cache-ui.js') });
        await page.addScriptTag({ path: asset('assets', 'js', 'narration', 'layout.js') });
        await page.addScriptTag({ path: asset('assets', 'js', 'narration', 'presentation.js') });
        await page.addScriptTag({ path: asset('assets', 'js', 'narration', 'ui.js') });
        const highlight = await page.evaluate(() => {
            const passage = 'First sentence. Second bright word here.';
            const start = passage.indexOf('bright');
            const marker = window.WorldBook.NarrationText.markerRange(passage, {
                charIndex: start,
                charLength: 'bright'.length,
            });
            window.__readerSmokeController.dispatchEvent(new CustomEvent('state', { detail: {
                status: 'playing',
                source: { title: 'Marker smoke' },
                index: 0,
                passageCount: 1,
                passage,
                passageRatio: 0.5,
                overallRatio: 0.5,
                engine: 'browser',
                marker: { ...marker, kind: 'word' },
            } }));
            const preview = document.getElementById('reader-passage-preview');
            return {
                text: preview.textContent,
                sentence: preview.querySelector('.narration-highlight-sentence')?.textContent || '',
                word: preview.querySelector('.narration-highlight-word')?.textContent || '',
                progress: Number(document.getElementById('reader-progress').value),
                progressLabel: document.getElementById('reader-progress-label').textContent,
            };
        });
        expect(highlight.text === 'First sentence. Second bright word here.', 'highlight rendering changed passage text');
        expect(highlight.sentence.trim() === 'Second bright word here.', 'active sentence was not highlighted');
        expect(highlight.word === 'bright', 'active word was not highlighted');
        expect(highlight.progress === 500 && /50%/.test(highlight.progressLabel),
            `continuous narration progress was not rendered: ${JSON.stringify(highlight)}`);

        const seek = await page.evaluate(() => {
            const progress = document.getElementById('reader-progress');
            progress.value = '725';
            progress.dispatchEvent(new Event('change', { bubbles: true }));
            return window.__readerSmokeCalls.seeks.at(-1);
        });
        expect(seek?.value === 725 && seek.autoplay === true,
            `progress scrubbing did not seek the active source: ${JSON.stringify(seek)}`);

        const cacheUi = await page.evaluate(async () => {
            await window.WorldBook.NarrationCacheUI.refresh();
            const row = document.querySelector('.narration-cache-passage');
            const source = document.querySelector('.narration-cache-source');
            const goTo = row.querySelector('.narration-cache-actions .button');
            goTo.click();
            return {
                title: row.title,
                details: row.textContent,
                locator: source.querySelector('.narration-cache-locator')?.textContent || '',
                focusCalls: window.__readerSmokeCalls.focuses.slice(),
            };
        });
        expect(/Clip 1 of 3/.test(cacheUi.title) && /Reading now/.test(cacheUi.title),
            `cached clip hover status is incomplete: ${cacheUi.title}`);
        expect(/gemini-2.5-flash-native-audio-latest/.test(cacheUi.details)
            && /Transcript matches source/.test(cacheUi.details),
            'cache manager omitted model or transcript integrity metadata');
        expect(/Characters > Leon > Info/.test(cacheUi.locator),
            `duplicate-title cache source lacks a useful path: ${cacheUi.locator}`);
        expect(cacheUi.focusCalls.includes('cache:marker:0'), 'Go to did not focus the cached clip');

        await page.evaluate(() => document.getElementById('reader-library-dialog').showModal());
        const collapse = await page.evaluate(() => {
            window.WorldBook.NarrationLayout.apply(false, false);
            document.getElementById('reader-library-toggle').click();
            const collapsed = {
                active: document.querySelector('.narration-layout').classList.contains('is-library-collapsed'),
                expanded: document.getElementById('reader-library-toggle').getAttribute('aria-expanded'),
                libraryDisplay: getComputedStyle(document.getElementById('reader-library-panel')).display,
            };
            document.getElementById('reader-library-toggle').click();
            collapsed.restored = !document.querySelector('.narration-layout').classList.contains('is-library-collapsed');
            return collapsed;
        });
        expect(collapse.active && collapse.expanded === 'false' && collapse.libraryDisplay === 'none'
            && collapse.restored, `private-document panel did not collapse accessibly: ${JSON.stringify(collapse)}`);
        for (const viewport of [
            { width: 1280, height: 900 },
            { width: 760, height: 760 },
            { width: 430, height: 700 },
        ]) {
            await page.setViewportSize(viewport);
            await page.waitForTimeout(30);
            const layout = await page.evaluate(() => {
                const card = document.querySelector('.narration-dialog-card');
                const controls = document.querySelector('.narration-player-controls');
                const buttons = [...controls.querySelectorAll('.button')].map(button => {
                    const rect = button.getBoundingClientRect();
                    return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom, width: rect.width, height: rect.height };
                });
                const cardRect = card.getBoundingClientRect();
                const overlaps = buttons.some((a, index) => buttons.slice(index + 1).some(b => (
                    Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1
                    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1
                )));
                return {
                    cardInsideViewport: cardRect.top >= -1 && cardRect.bottom <= innerHeight + 1
                        && cardRect.left >= -1 && cardRect.right <= innerWidth + 1,
                    horizontalOverflow: card.scrollWidth > card.clientWidth + 1
                        || controls.scrollWidth > controls.clientWidth + 1,
                    minButtonHeight: Math.min(...buttons.map(button => button.height)),
                    minButtonWidth: Math.min(...buttons.map(button => button.width)),
                    overlaps,
                };
            });
            expect(layout.cardInsideViewport, `reader escaped ${viewport.width}x${viewport.height} viewport`);
            expect(!layout.horizontalOverflow, `reader overflowed horizontally at ${viewport.width}px`);
            expect(layout.minButtonHeight >= 39, `reader controls were undersized at ${viewport.width}px`);
            expect(layout.minButtonWidth >= 64, `reader controls became too narrow at ${viewport.width}px`);
            expect(!layout.overlaps, `reader controls overlapped at ${viewport.width}px`);

            const collapsedLayout = await page.evaluate(() => {
                window.WorldBook.NarrationLayout.apply(true, false);
                const card = document.querySelector('.narration-dialog-card');
                const player = document.querySelector('.narration-player-panel');
                const cardRect = card.getBoundingClientRect();
                const playerRect = player.getBoundingClientRect();
                const result = {
                    libraryHidden: getComputedStyle(document.getElementById('reader-library-panel')).display === 'none',
                    horizontalOverflow: card.scrollWidth > card.clientWidth + 1,
                    playerInsideCard: playerRect.left >= cardRect.left - 1 && playerRect.right <= cardRect.right + 1,
                };
                window.WorldBook.NarrationLayout.apply(false, false);
                return result;
            });
            expect(collapsedLayout.libraryHidden && !collapsedLayout.horizontalOverflow
                && collapsedLayout.playerInsideCard,
                `collapsed reader layout failed at ${viewport.width}px: ${JSON.stringify(collapsedLayout)}`);
        }

        expect(pageErrors.length === 0, `reader browser errors: ${pageErrors.join('; ')}`);
        console.log('WORLD_BOOK_NARRATION_BROWSER_SMOKE_OK');
    } finally {
        await context.close();
        if (launched.mode === 'launch') await launched.browser.close();
        await new Promise(resolve => server.close(resolve));
    }
}

main().catch(error => {
    console.error(error);
    process.exit(1);
});
