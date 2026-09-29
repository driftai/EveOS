/**
 * audioflix_queue_view_smoke.js
 *
 * Queue View + playback speed for the internal ("open inside EveOS") player.
 *
 * Queue View differs from the per-song internal view: it is bound to the GROUP's queue, so it
 * shows what is coming next and can step backwards/forwards through it. Speed applies to both
 * views and must survive moving between queue tracks.
 */
const path = require('path');
const { chromium } = require('playwright');

const REPO_ROOT = path.resolve(__dirname, '..', '..');
const FILE_URL = 'file:///' + path.join(REPO_ROOT, 'EveOS.html').replace(/\\/g, '/');

function assert(cond, msg) { if (!cond) throw new Error('ASSERT FAILED: ' + msg); }
const progress = (...args) => { if (process.argv.includes('--verbose')) console.log(...args); };

async function clickLibraryAction(page, selector) {
    const player = page.locator('.audioflix-provider-stage');
    if (await player.isVisible() && !(await player.evaluate(element => element.classList.contains('is-collapsed')))) {
        await page.click('[data-url-player-action="collapse"]');
    }
    if (await player.isVisible()) {
        assert(!(await page.locator('.audioflix-provider-queue').isVisible()), 'Minimize hides the queue without stopping playback');
    }
    await page.click(selector);
    if (await player.isVisible() && await player.evaluate(element => element.classList.contains('is-collapsed'))) {
        await page.click('[data-url-player-action="collapse"]');
    }
}

function silentWav() {
    // Long enough that a track does not end (and hide the stage) mid-test.
    const rate = 8000, count = 8000 * 90;
    const wav = Buffer.alloc(44 + count * 2);
    wav.write('RIFF', 0); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
    wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
    wav.writeUInt32LE(rate, 24); wav.writeUInt32LE(rate * 2, 28); wav.writeUInt16LE(2, 32);
    wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(count * 2, 40);
    return `data:audio/wav;base64,${wav.toString('base64')}`;
}

async function main() {
    const browser = await chromium.launch({ headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const pageErrors = [];
    page.on('pageerror', (e) => { console.error('[BROWSER ERROR]', e); pageErrors.push(String(e)); });

    await page.addInitScript(() => {
        try { localStorage.clear(); } catch {}
        window.__eveSmokeNoAutoGemini = true;
    });
    await page.goto(FILE_URL, { waitUntil: 'load', timeout: 180000 });
    await page.waitForFunction(
        () => !!window.EveAudioflix?.open && !!window.EveAudioflixState && !!window.__EVE_DEFERRED_SCRIPT_STATE?.completedAt,
        undefined, { timeout: 120000 });

    // Three tracks in one group, all data: URLs so playback needs no network or server.
    await page.evaluate((src) => {
        const S = window.EveAudioflixState;
        S.addMusicGroup('Vibes');
        ['Alpha', 'Beta', 'Gamma'].forEach((title) => {
            const added = S.addItem('music', { title, url: src, folder: 'Vibes' });
            S.toggleMusicGroup(added.id, 'Vibes', true);
        });
    }, silentWav());

    await page.click('.topbar-audioflix-btn');
    await page.waitForSelector('#audioflix-overlay:not([hidden]) .audioflix-panel', { timeout: 10000 });
    await page.click('[data-af-action="tab"][data-af-tab="music"]');
    await page.click('[data-af-action="toggle-view-mode"]');   // backend -> frontend
    await page.waitForSelector('[data-af-action="open-queue-view"]', { timeout: 10000 });

    // The new button sits with the other group controls, not on an individual song.
    const siblings = await page.$$eval('[data-af-action="open-queue-view"]', (els) => {
        const row = els[0].parentElement;
        return Array.from(row.querySelectorAll('[data-af-action]')).map((b) => b.dataset.afAction);
    });
    ['play-music-group', 'shuffle-music-group', 'loop-music-group', 'open-queue-view'].forEach((a) =>
        assert(siblings.includes(a), `Queue View sits beside the other group controls (missing ${a})`));

    await page.click('[data-af-action="open-queue-view"]');
    await page.waitForSelector('.audioflix-provider-queue:not([hidden])', { timeout: 10000 });

    const queued = await page.$$eval('.audioflix-provider-queue-list li', (li) => li.map((n) => n.textContent.trim()));
    assert(queued.length === 3, `queue lists every track in the group (got ${queued.length})`);
    assert(/^▶/.test(queued[0]), `the current track is marked (got "${queued[0]}")`);

    const atStart = await page.evaluate(() => ({
        prevDisabled: document.querySelector('[data-url-player-action="prev"]').disabled,
        nextDisabled: document.querySelector('[data-url-player-action="next"]').disabled,
        index: window.EveAudioflixState.getSnapshot() && null
    }));
    assert(atStart.prevDisabled === true, 'prev is disabled on the first queue track');
    assert(atStart.nextDisabled === false, 'next is available when tracks remain');

    // Step forward twice, then back once — the marked track must follow.
    await page.click('[data-url-player-action="next"]');
    await page.waitForFunction(() => /^▶/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.textContent.trim() || ''), undefined, { timeout: 5000 });
    await page.click('[data-url-player-action="next"]');
    await page.waitForFunction(() => /^▶/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[2]?.textContent.trim() || ''), undefined, { timeout: 5000 });
    assert(await page.$eval('[data-url-player-action="next"]', (b) => b.disabled), 'next is disabled on the last queue track');

    await page.click('[data-url-player-action="prev"]');
    await page.waitForFunction(() => /^▶/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.textContent.trim() || ''), undefined, { timeout: 5000 });
    progress('queue view OK — lists the group queue and steps both directions');

    // Jumping straight to an entry works too.
    await page.click('.audioflix-provider-queue-list li:first-child button');
    await page.waitForFunction(() => /^▶/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[0]?.textContent.trim() || ''), undefined, { timeout: 5000 });

    // Speed: the picker drives the real element, and the choice carries to the next queue track.
    await page.selectOption('.audioflix-provider-rate', '2');
    await page.waitForTimeout(200);
    assert(await page.evaluate(() => window.EveAudioflixAudio.getPlaybackRate()) === 2, 'speed selection reached the controller');
    await page.click('[data-url-player-action="next"]');
    await page.waitForTimeout(400);
    const rateAfterStep = await page.evaluate(() => ({
        controller: window.EveAudioflixAudio.getPlaybackRate(),
        picker: Number(document.querySelector('.audioflix-provider-rate').value)
    }));
    assert(rateAfterStep.controller === 2, 'speed survives moving to the next queue track');
    assert(rateAfterStep.picker === 2, 'the picker still shows the chosen speed');
    progress('speed OK — 2x applied and carried across a queue step');

    // Physical regression: Play Group -> manually choose a different song -> Shuffle while
    // Queue View is open. Old provider lifecycle events must not bounce the queue back, and the
    // chosen song stays #1 until its ONE Ended transition advances to exactly #2.
    const betaId = await page.evaluate(() =>
        window.EveAudioflixState.getSnapshot().music.find((track) => track.title === 'Beta')?.id || '');
    // The expanded floating player intentionally covers library cards. Use its real
    // Minimize/Expand controls rather than forcing clicks through that foreground window.
    await clickLibraryAction(page, `[data-af-action="play"][data-af-id="${betaId}"]`);
    await page.waitForFunction(() => window.EveAudioflixAudio?.getPlaybackState?.()?.item?.title === 'Beta', undefined, { timeout: 5000 });
    await clickLibraryAction(page, '[data-af-action="shuffle-music-group"]');
    await page.waitForFunction(() => {
        const first = document.querySelector('.audioflix-provider-queue-list li:first-child');
        return first?.classList.contains('is-current') && /Beta/.test(first.textContent || '');
    }, undefined, { timeout: 5000 });

    await page.evaluate(() => {
        const alpha = window.EveAudioflixState.getSnapshot().music.find((track) => track.title === 'Alpha');
        for (const status of ['Paused', 'Stopped', 'Playing Alpha']) {
            window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail: { status, item: alpha } }));
        }
    });
    await page.waitForTimeout(150);
    assert(await page.$eval('.audioflix-provider-queue-list li:first-child', (row) =>
        row.classList.contains('is-current') && /Beta/.test(row.textContent || '')),
        'stale lifecycle events from the old track cannot rewrite the rebased queue index');

    await page.evaluate(() => {
        const beta = window.EveAudioflixState.getSnapshot().music.find((track) => track.title === 'Beta');
        window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail: { status: 'Ended', item: beta } }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.classList.contains('is-current'), undefined, { timeout: 5000 });
    await page.evaluate(() => {
        const beta = window.EveAudioflixState.getSnapshot().music.find((track) => track.title === 'Beta');
        window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail: { status: 'Ended', item: beta } }));
    });
    await page.waitForTimeout(250);
    const afterStaleEnd = await page.$$eval('.audioflix-provider-queue-list li', (rows) =>
        rows.map((row) => row.classList.contains('is-current')));
    assert(afterStaleEnd[1] === true && afterStaleEnd.filter(Boolean).length === 1,
        'manual-select + shuffle advances exactly once; stale Ended cannot fork into another song');
    progress('manual select + shuffle queue ownership OK');

    // Regression: two listeners used to handle the same Ended event. At the loop boundary that
    // started #1 and then immediately #2. Repeating the terminal event must advance only once.
    await clickLibraryAction(page, '[data-af-action="loop-music-group"]');
    await page.click('.audioflix-provider-queue-list li:last-child button');
    await page.waitForFunction(() => document.querySelector('.audioflix-provider-queue-list li:last-child')?.classList.contains('is-current'), undefined, { timeout: 5000 });
    await page.evaluate(() => {
        const item = window.EveAudioflixAudio?.getPlaybackState?.()?.item;
        const detail = { status: 'Ended', item };
        window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail }));
        window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail }));
    });
    await page.waitForFunction(() => document.querySelector('.audioflix-provider-queue-list li:first-child')?.classList.contains('is-current'), undefined, { timeout: 5000 });
    await page.waitForTimeout(350);
    const wrappedOnce = await page.$$eval('.audioflix-provider-queue-list li', (rows) =>
        rows.map((row) => row.classList.contains('is-current')));
    assert(wrappedOnce[0] === true && wrappedOnce[1] === false, 'duplicate Ended events wrap to #1 only, never #2');

    // Hiding Queue View must not stop or fork the queue. The next Ended advances while hidden;
    // reopening attaches the panel to that same #2 playback session.
    const hiddenExpectedNext = await page.$$eval('.audioflix-provider-queue-list li', (rows) =>
        (rows[1]?.textContent || '').replace(/^▶\s*/, '').trim());
    await clickLibraryAction(page, '[data-af-action="open-queue-view"]');
    assert(await page.$eval('.audioflix-provider-stage', (stage) => stage.hidden), 'closing Queue View only hides the shared player');
    await page.evaluate(() => {
        const item = window.EveAudioflixAudio?.getPlaybackState?.()?.item;
        window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail: { status: 'Ended', item } }));
    });
    await page.waitForFunction((expected) => {
        const playback = window.EveAudioflixAudio?.getPlaybackState?.();
        return playback?.item?.title === expected && playback.paused === false;
    }, hiddenExpectedNext, { timeout: 5000 });
    await clickLibraryAction(page, '[data-af-action="open-queue-view"]');
    await page.waitForFunction(() => document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.classList.contains('is-current'), undefined, { timeout: 5000 });
    const reopened = await page.waitForFunction(() => document.querySelector('.audioflix-provider-stage')?.hidden === false, undefined, { timeout: 5000 })
        .then(() => true, () => false);
    if (!reopened) {
        console.error('reopen diagnostic:', await page.evaluate(() => ({
            stageHidden: document.querySelector('.audioflix-provider-stage')?.hidden,
            stageStatus: document.querySelector('.audioflix-provider-status')?.textContent,
            playback: {
                title: window.EveAudioflixAudio?.getPlaybackState?.()?.item?.title,
                paused: window.EveAudioflixAudio?.getPlaybackState?.()?.paused
            }
        })));
    }
    assert(reopened, 'reopening Queue View attaches to the live queue');
    progress('queue ownership OK - loop wrap advances once and hidden/internal views stay synchronized');

    assert(pageErrors.length === 0, 'no uncaught page errors: ' + pageErrors.join(' | '));
    await browser.close();
    console.log('AUDIOFLIX_QUEUE_VIEW_SMOKE_OK');
}

main().catch((err) => { console.error(err); process.exit(1); });
