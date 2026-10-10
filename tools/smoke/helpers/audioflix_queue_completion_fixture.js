'use strict';
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

const LIST = '.audioflix-provider-stage:not([hidden]) .audioflix-provider-queue-list';
const RESULT_DIR = path.resolve(__dirname, '../../../data/runtime/smoke-results/audioflix-queue-reorder');

function silentWav() {
    const rate = 8000, count = rate * 90;
    const wav = Buffer.alloc(44 + count * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
    return `data:audio/wav;base64,${wav.toString('base64')}`;
}

async function snapshot(page) {
    return page.evaluate(() => {
        const queue = window.EveAudioflix?.queueConnection?.snapshot?.();
        const playback = window.EveAudioflixAudio?.getPlaybackState?.();
        return { queue, playback: { id: playback?.item?.id, title: playback?.item?.title, paused: playback?.paused },
            starts: [...(window.__queueSmoke?.starts || [])], pending: window.__queueSmoke?.pending === true,
            seekPending: window.__queueSmoke?.seekPending === true };
    });
}

async function pointerClick(page, selector) {
    try {
        const target = page.locator(selector);
        await target.waitFor({ state: 'visible', timeout: 10000 });
        // UI rerenders replace nodes between protocol hops. Sample geometry on the connected
        // current node, then let the locator reacquire it for real pointer/actionability input.
        await page.waitForFunction(selector => {
            const element = document.querySelector(selector);
            const rect = element?.getBoundingClientRect();
            return element?.isConnected && rect?.width > 0 && rect.height > 0;
        }, selector, { timeout: 10000 });
        // locator.click uses real mouse input and reacquires a row if a normal render detaches it.
        await target.click({ timeout: 10000 });
    } catch (error) {
        throw new Error(`pointer ${selector}: ${error.message}`);
    }
}

async function libraryAction(page, action) {
    const stage = page.locator('.audioflix-provider-stage:not([hidden])');
    if (await stage.count() && !(await stage.evaluate(el => el.classList.contains('is-collapsed')))) {
        await pointerClick(page, '[data-url-player-action="collapse"]');
    }
    await pointerClick(page, `[data-af-action="${action}"]`);
    if (await stage.count() && await stage.evaluate(el => el.classList.contains('is-collapsed'))) {
        await pointerClick(page, '[data-url-player-action="collapse"]');
    }
}

async function select(page, index) {
    await pointerClick(page, `${LIST} li:nth-child(${index + 1}) [data-url-player-action="queue-jump"]`);
    await page.waitForFunction(index => {
        const q = window.EveAudioflix.queueConnection.snapshot();
        const playback = window.EveAudioflixAudio.getPlaybackState();
        return q.currentIndex === index && playback.item?.id === q.entries[index]?.id && playback.paused === false;
    }, index, { timeout: 5000 });
    await page.evaluate(() => { window.__queueSmoke.starts.length = 0; });
    return snapshot(page);
}

async function createFixture(browser, root, { queueView = true } = {}) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 1000 } });
    const page = await context.newPage();
    const diagnostics = { console: [], pageErrors: [], pageErrorCount: 0, requests: [] };
    const retain = (values, value) => { if (values.length < 150) values.push(value); };
    page.on('console', message => retain(diagnostics.console, { type: message.type(), text: message.text().slice(0, 600) }));
    page.on('pageerror', error => { diagnostics.pageErrorCount += 1; retain(diagnostics.pageErrors, String(error)); });
    page.on('requestfailed', request => retain(diagnostics.requests, { url: request.url().slice(0, 300), error: request.failure()?.errorText }));
    try {
    // Fresh storage and blocked HTTP/WS prevent access to profiles, services, or live providers.
    await context.route(/^https?:\/\//, route => route.abort());
    await context.routeWebSocket(/.*/, socket => socket.close());
    await context.addInitScript(() => {
        try { localStorage.clear(); } catch {}
        window.__eveSmokeNoAutoGemini = true;
    });
    await context.tracing.start({ screenshots: true, snapshots: true });
    await page.goto(pathToFileURL(path.join(root, 'EveOS.html')).href, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(() => window.EveAudioflix?.queueConnection && window.EveAudioflixState
        && window.__EVE_DEFERRED_SCRIPT_STATE?.completedAt, undefined, { timeout: 120000 });
    await page.evaluate(src => {
        const state = window.EveAudioflixState;
        state.addMusicGroup('Queue completion fixture');
        ['Alpha', 'Beta', 'Gamma', 'Delta'].forEach(title => {
            const item = state.addItem('music', { title, url: src, folder: 'Queue completion fixture' });
            state.toggleMusicGroup(item.id, 'Queue completion fixture', true);
        });
        const probe = window.__queueSmoke = { starts: [], pending: false, resolve: null, detail: null };
        for (const name of ['playItem', 'openInternalView']) {
            const original = window.EveAudioflixAudio[name].bind(window.EveAudioflixAudio);
            window.EveAudioflixAudio[name] = async item => {
                probe.starts.push({ id: item.id, title: item.title, method: name });
                // Lane-2 contract: an entry can be marked unavailable so its start throws.
                if (probe.fail?.has(item.id)) throw new Error('Mocked unavailable entry.');
                return original(item);
            };
        }
        // Only the provider Ended/settle signal is mocked. Queue ownership, transitions, UI,
        // pointer input, and WAV transport all use the real application modules.
        probe.end = (pending = false, itemId = '', copies = 2) => {
            const playback = window.EveAudioflixAudio.getPlaybackState();
            const item = itemId ? state.getSnapshot().music.find(track => track.id === itemId) : playback.item;
            const settle = pending ? new Promise(resolve => { probe.resolve = resolve; }) : Promise.resolve();
            probe.pending = pending;
            probe.detail = { status: 'Ended', provider: 'spotify', browserOnly: true,
                item: { ...item, sourceProvider: 'spotify', spotifyUrl: 'https://open.spotify.com/track/mocked' }, settle };
            for (let index = 0; index < copies; index += 1) {
                window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail: probe.detail }));
            }
        };
    }, silentWav());
    await pointerClick(page, '.topbar-audioflix-btn');
    await pointerClick(page, '[data-af-action="tab"][data-af-tab="music"]');
    await pointerClick(page, '[data-af-action="toggle-view-mode"][data-af-type="music"]');
    await pointerClick(page, '.audioflix-group-pill[data-af-action="select-frontend-group"][data-af-type="music"][data-af-group="Queue completion fixture"]');
    // queueView:false starts the group through Play Group without opening the Queue View/internal player.
    await pointerClick(page, `[data-af-action="${queueView ? 'open-queue-view' : 'play-music-group'}"]`);
    await page.waitForFunction(() => window.EveAudioflix.queueConnection.snapshot().entries.length === 4
        && window.EveAudioflixAudio.getPlaybackState()?.paused === false, undefined, { timeout: 5000 });
    return { context, page, diagnostics };
    } catch (error) {
        await saveFailure({ context, page, diagnostics }, 'queue-completion-fixture', error);
        await context.tracing.stop({ path: path.join(RESULT_DIR, 'trace.zip') }).catch(() => {});
        throw error;
    }
}

async function end(page, pending = false, itemId = '') {
    await page.evaluate(({ pending, itemId }) => window.__queueSmoke.end(pending, itemId), { pending, itemId });
}

async function armEndAtPointer(page, selector) {
    // Window capture precedes the application's document/element click listeners. The real
    // pointer action therefore reorders or selects while Ended's settle promise is pending,
    // before the legacy 0ms fallback can disguise the race by starting another track.
    await page.evaluate(selector => {
        const listener = event => {
            if (!event.target.closest?.(selector)) return;
            window.removeEventListener('click', listener, true);
            window.__queueSmoke.end(true);
        };
        window.addEventListener('click', listener, true);
    }, selector);
}

async function resolveEnd(page) {
    await page.evaluate(() => {
        window.__queueSmoke.pending = false;
        window.__queueSmoke.resolve?.();
        window.__queueSmoke.resolve = null;
    });
}

async function deferRestartSeek(page) {
    await page.evaluate(() => {
        const audio = window.EveAudioflixAudio, probe = window.__queueSmoke;
        probe.originalSeek = audio.seek;
        audio.seek = async position => {
            if (Number(position) !== 0) return probe.originalSeek.call(audio, position);
            probe.seekPending = true;
            const pending = new Promise(resolve => { probe.resolveSeek = resolve; });
            const result = await probe.originalSeek.call(audio, position);
            // The real seek is applied; only its asynchronous completion acknowledgement is held.
            await pending;
            probe.seekPending = false;
            return result;
        };
    });
}

async function resolveSeek(page) {
    await page.evaluate(() => {
        const probe = window.__queueSmoke;
        if (probe.originalSeek) window.EveAudioflixAudio.seek = probe.originalSeek;
        probe.originalSeek = null;
        probe.resolveSeek?.();
        probe.resolveSeek = null;
    });
}

async function unchanged(page, expected, message) {
    await page.waitForTimeout(120);
    const actual = await snapshot(page);
    assert.strictEqual(actual.queue.currentIndex, expected.queue.currentIndex, `${message}: queue index`);
    assert.strictEqual(actual.playback.id, expected.playback.id, `${message}: playing identity`);
    assert.deepStrictEqual(actual.starts, expected.starts, `${message}: no extra playback start`);
}

async function completedOnce(page, expectedId, index) {
    await page.waitForFunction(({ expectedId, index }) => {
        const q = window.EveAudioflix.queueConnection.snapshot();
        const playback = window.EveAudioflixAudio.getPlaybackState();
        return q.currentIndex === index && q.entries[index]?.id === expectedId
            && playback.item?.id === expectedId && playback.paused === false;
    }, { expectedId, index }, { timeout: 3000 });
    await page.waitForTimeout(150);
    const actual = await snapshot(page);
    assert.strictEqual(actual.starts.length, 1, 'one completion starts exactly one song');
    assert.strictEqual(actual.starts[0].id, expectedId, 'completion starts the latest queue successor');
    assert.strictEqual(actual.queue.currentIndex, index, 'no duplicate completion skips a slot');
    assert.strictEqual(await page.locator(`${LIST} li.is-current`).count(), 1, 'exactly one visible current row');
}

async function saveFailure(fixture, id, error) {
    fs.mkdirSync(RESULT_DIR, { recursive: true });
    const state = await snapshot(fixture.page).catch(() => null);
    const prefix = path.join(RESULT_DIR, id);
    await fixture.page.screenshot({ path: `${prefix}.png`, fullPage: true }).catch(() => {});
    fs.writeFileSync(`${prefix}.html`, await fixture.page.content().catch(() => ''), 'utf8');
    fs.writeFileSync(`${prefix}.json`, JSON.stringify({ id, error: String(error.stack || error), state,
        evidence: 'isolated real queue + WAV playback; mocked Spotify-provenance Ended/settle; no live Spotify proof',
        ...fixture.diagnostics }, null, 2), 'utf8');
    return state;
}

module.exports = { LIST, RESULT_DIR, createFixture, snapshot, pointerClick, libraryAction, select,
    end, armEndAtPointer, resolveEnd, deferRestartSeek, resolveSeek, unchanged, completedOnce, saveFailure };
