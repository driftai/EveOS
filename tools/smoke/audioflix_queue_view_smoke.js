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

    // The Nexus launcher is a real split control: primary opens the full panel, the compact side
    // opens Fast Track search without taking over the library.
    assert(await page.locator('[data-af-action="toggle-nexus"][data-af-type="music"]').count() === 1,
        'Nexus Audio Link keeps its normal primary button');
    assert(await page.locator('[data-af-action="open-nexus-quick"][data-af-type="music"]').count() === 1,
        'Nexus Audio Link exposes a dedicated Fast Track search segment');
    await page.click('[data-af-action="toggle-nexus"][data-af-type="music"]');
    await page.waitForSelector('.audioflix-nexus-panel');
    await page.click('[data-af-action="toggle-nexus"][data-af-type="music"]');
    await page.waitForFunction(() => !document.querySelector('.audioflix-nexus-panel'));
    progress('Nexus primary launcher toggles its full panel open/closed');
    await page.click('[data-af-action="open-nexus-quick"][data-af-type="music"]');
    await page.fill('.audioflix-nexus-quick input[type="search"]', 'Beta');
    await page.waitForFunction(() => document.querySelectorAll('.audioflix-nexus-quick-row').length === 1);
    assert(/Backend · whole library/.test(await page.locator('.audioflix-nexus-quick-scope').textContent()),
        'backend Fast Track searches the whole music library');
    assert(/Beta/.test(await page.locator('.audioflix-nexus-quick-row strong').textContent()),
        'backend Fast Track returns the matching song');
    await page.click('.audioflix-nexus-quick-row [data-quick-action="jump"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.audioflix-item-card')].some(card =>
        card.classList.contains('is-nexus-jump-target') && /Beta/.test(card.textContent || '')));
    progress('Nexus Fast Track backend search + jump OK');

    await page.click('[data-af-action="toggle-view-mode"]');   // backend -> frontend
    await page.click('[data-af-action="select-frontend-group"][data-af-type="music"][data-af-group="Vibes"]');
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

    const queued = (await page.locator('.audioflix-provider-queue-list li').allTextContents()).map((text) => text.trim());
    assert(queued.length === 3, `queue lists every track in the group (got ${queued.length})`);
    const currentLabel = await page.$eval('.audioflix-provider-queue-list li:first-child [data-url-player-action="queue-jump"]', (button) => button.textContent.trim());
    assert(/^▶/.test(currentLabel), `the current track is marked on its queue-jump control (got "${currentLabel}")`);
    await page.waitForSelector('.audioflix-provider-queue-list .audioflix-queue-order-buttons');
    const queueHeight = await page.$eval('.audioflix-provider-queue', element => element.getBoundingClientRect().height);
    assert(queueHeight >= 140, `queue workspace is tall enough to manage ordering (got ${queueHeight}px)`);

    // Group membership is live queue membership: removing a non-current song drops it from this
    // group's queue, and adding it back appends it without restarting the current track.
    const gammaMembershipId = await page.evaluate(() =>
        window.EveAudioflixState.getSnapshot().music.find((track) => track.title === 'Gamma')?.id || '');
    await page.click('[data-url-player-action="collapse"]');
    await page.click(`[data-af-action="item-info"][data-af-type="music"][data-af-id="${gammaMembershipId}"]`);
    const gammaGroupBox = `.audioflix-info-modal .audioflix-group-cb[data-af-id="${gammaMembershipId}"][data-af-group="Vibes"]`;
    await page.uncheck(gammaGroupBox);
    await page.waitForFunction(() => {
        const q = window.EveAudioflix?.queueConnection?.snapshot?.();
        return q?.entries?.length === 2 && !q.entries.some((entry) => entry.title === 'Gamma');
    });
    await page.check(gammaGroupBox);
    await page.waitForFunction(() => {
        const q = window.EveAudioflix?.queueConnection?.snapshot?.();
        return q?.entries?.length === 3 && q.entries[2]?.title === 'Gamma';
    });
    await page.click('.audioflix-info-close-btn');
    await page.click('[data-url-player-action="collapse"]');
    progress('group membership OK — queue removes and re-adds tracks live');

    // Up/down controls reorder without restarting the current song, and numbering follows.
    await page.click('.audioflix-provider-queue-list li:nth-child(2) [data-queue-move="1"]');
    await page.waitForFunction(() => /Gamma/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.textContent || ''));
    await page.click('.audioflix-provider-queue-list li:nth-child(3) [data-queue-move="-1"]');
    await page.waitForFunction(() => /Beta/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.textContent || ''));

    // Dragging uses the same single queue mutation path.
    await page.dragAndDrop(
        '.audioflix-provider-queue-list li:nth-child(3) .audioflix-queue-drag-handle',
        '.audioflix-provider-queue-list li:nth-child(2)'
    );
    await page.waitForFunction(() => /Gamma/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.textContent || ''));
    await page.evaluate(() => window.EveAudioflix.queueConnection.move(1, 2));
    await page.waitForFunction(() => /Beta/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.textContent || ''));
    progress('queue manual ordering OK — arrows and drag share one queue owner');

    // Frontend Fast Track is bounded to the visible scope and can promote a result to Play next.
    await page.click('[data-af-action="open-nexus-quick"][data-af-type="music"]');
    await page.fill('.audioflix-nexus-quick input[type="search"]', 'Gamma');
    await page.waitForFunction(() => document.querySelectorAll('.audioflix-nexus-quick-row').length === 1);
    assert(/Frontend/.test(await page.locator('.audioflix-nexus-quick-scope').textContent()),
        'frontend Fast Track reports its current frontend scope');
    assert(await page.locator('.audioflix-nexus-quick-row [data-quick-action="next"]').count() === 1,
        'frontend Fast Track exposes Play next while a group queue is active');
    await page.click('.audioflix-nexus-quick-row [data-quick-action="next"]');
    await page.waitForFunction(() => /Gamma/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.textContent || ''));
    const gammaId = await page.evaluate(() => window.EveAudioflixState.getSnapshot().music.find(track => track.title === 'Gamma')?.id || '');
    assert(await page.$eval(`.audioflix-item-card [data-af-id="${gammaId}"]`, button =>
        /#2\s+Queued/.test(button.closest('.audioflix-item-card')?.textContent || '')),
        'Play next updates the queue number on the frontend song card');
    await page.evaluate(() => window.EveAudioflix.queueConnection.move(1, 2));
    await page.waitForFunction(() => /Beta/.test(document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.textContent || ''));
    await page.click('.audioflix-nexus-quick [data-quick-action="close"]');
    progress('Nexus Fast Track frontend scope + Play next OK');

    const playerUi = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
        const prev = rect('[data-url-player-action="prev"]');
        const toggle = rect('[data-url-player-action="toggle"]');
        const next = rect('[data-url-player-action="next"]');
        return {
            actions: ['restart', 'repeat-one', 'details'].map(action =>
                !!document.querySelector(`[data-url-player-action="${action}"]`)),
            widths: { prev: prev?.width || 0, toggle: toggle?.width || 0, next: next?.width || 0 }
        };
    });
    assert(playerUi.actions.every(Boolean), 'Internal Player exposes Restart, Loop track, and Track details');
    assert(playerUi.widths.prev <= 60 && playerUi.widths.next <= 60 && playerUi.widths.toggle > playerUi.widths.prev,
        'prev/next stay compact while the central play button owns the flexible width');

    // Custom ranges must map 0 and max to the actual ends of the painted track.
    const rangeEdges = await page.evaluate(() => {
        const seek = document.querySelector('.audioflix-provider-seek');
        seek.max = '100'; seek.value = '0'; seek.dispatchEvent(new Event('input', { bubbles: true }));
        const seekZero = seek.style.getPropertyValue('--progress');
        seek.value = '100'; seek.dispatchEvent(new Event('input', { bubbles: true }));
        const seekFull = seek.style.getPropertyValue('--progress');
        const volume = document.querySelector('.audioflix-provider-volume');
        volume.value = '0'; volume.dispatchEvent(new Event('input', { bubbles: true }));
        const volumeZero = volume.style.getPropertyValue('--volume');
        volume.value = '1'; volume.dispatchEvent(new Event('input', { bubbles: true }));
        const volumeFull = volume.style.getPropertyValue('--volume');
        return { seekZero, seekFull, volumeZero, volumeFull };
    });
    assert(rangeEdges.seekZero === '0%' && rangeEdges.seekFull === '100%', 'seek fill reaches exact 0% and 100% endpoints');
    assert(rangeEdges.volumeZero === '0%' && rangeEdges.volumeFull === '100%', 'volume fill reaches exact 0% and 100% endpoints');

    const atStart = await page.evaluate(() => ({
        prevDisabled: document.querySelector('[data-url-player-action="prev"]').disabled,
        nextDisabled: document.querySelector('[data-url-player-action="next"]').disabled,
        index: window.EveAudioflixState.getSnapshot() && null
    }));
    assert(atStart.prevDisabled === true, 'prev is disabled on the first queue track');
    assert(atStart.nextDisabled === false, 'next is available when tracks remain');

    // Step forward twice, then back once — the marked track must follow.
    await page.click('[data-url-player-action="next"]');
    await page.waitForFunction(() => document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.classList.contains('is-current'), undefined, { timeout: 5000 });
    await page.click('[data-url-player-action="next"]');
    await page.waitForFunction(() => document.querySelectorAll('.audioflix-provider-queue-list li')[2]?.classList.contains('is-current'), undefined, { timeout: 5000 });
    assert(await page.$eval('[data-url-player-action="next"]', (b) => b.disabled), 'next is disabled on the last queue track');

    await page.click('[data-url-player-action="prev"]');
    await page.waitForFunction(() => document.querySelectorAll('.audioflix-provider-queue-list li')[1]?.classList.contains('is-current'), undefined, { timeout: 5000 });
    progress('queue view OK — lists the group queue and steps both directions');

    // Jumping straight to an entry works too.
    await page.click('.audioflix-provider-queue-list li:first-child button');
    await page.waitForFunction(() => document.querySelectorAll('.audioflix-provider-queue-list li')[0]?.classList.contains('is-current'), undefined, { timeout: 5000 });

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

    // Restart uses the same active player rather than creating a second audio session.
    await page.evaluate(() => window.EveAudioflixAudio.seek(12));
    await page.click('[data-url-player-action="restart"]');
    await page.waitForFunction(() => (window.EveAudioflixAudio?.getPlaybackState?.()?.currentTime || 99) < 1.5, undefined, { timeout: 5000 });
    progress('restart OK — active queue track returns to the beginning');

    // Track Details is the existing Audioflix settings modal, raised above the Internal Player.
    await page.click('[data-url-player-action="details"]');
    await page.waitForSelector('.audioflix-info-modal .audioflix-info-card', { timeout: 5000 });
    const detailsLayer = await page.evaluate(() => ({
        title: document.querySelector('.audioflix-info-title')?.textContent || '',
        overlayZ: Number(getComputedStyle(document.querySelector('#audioflix-overlay')).zIndex) || 0,
        playerZ: Number(getComputedStyle(document.querySelector('.audioflix-provider-stage')).zIndex) || 0,
        raised: document.querySelector('#audioflix-overlay')?.classList.contains('audioflix-info-over-internal')
    }));
    assert(detailsLayer.title === 'Beta', `Track Details follows the queue's current song (got "${detailsLayer.title}")`);
    assert(detailsLayer.raised && detailsLayer.overlayZ > detailsLayer.playerZ, 'Track Details is layered above the Internal Player');
    await page.click('.audioflix-info-close-btn');
    await page.waitForFunction(() => !document.querySelector('.audioflix-info-modal'), undefined, { timeout: 5000 });

    // Repeat-one must consume Ended without advancing the queue or starting a second track.
    await page.click('[data-url-player-action="repeat-one"]');
    await page.waitForFunction(() => document.querySelector('[data-url-player-action="repeat-one"]')?.getAttribute('aria-pressed') === 'true');
    const repeatTitle = await page.evaluate(() => window.EveAudioflixAudio?.getPlaybackState?.()?.item?.title || '');
    await page.evaluate(() => {
        const item = window.EveAudioflixAudio?.getPlaybackState?.()?.item;
        const detail = { status: 'Ended', item };
        window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail }));
        window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail }));
    });
    await page.waitForFunction((title) => {
        const current = document.querySelector('.audioflix-provider-queue-list li.is-current');
        return (window.EveAudioflixAudio?.getPlaybackState?.()?.item?.title || '') === title && current?.textContent.includes(title);
    }, repeatTitle, { timeout: 5000 });
    assert((await page.locator('.audioflix-provider-queue-list li.is-current').count()) === 1, 'repeat-one keeps exactly one current queue entry');
    await page.click('[data-url-player-action="repeat-one"]');
    await page.waitForFunction(() => document.querySelector('[data-url-player-action="repeat-one"]')?.getAttribute('aria-pressed') === 'false');
    await page.evaluate(() => {
        const item = window.EveAudioflixAudio?.getPlaybackState?.()?.item;
        window.dispatchEvent(new CustomEvent('eve:audioflix-playback', { detail: { status: 'Ended', item } }));
    });
    await page.waitForFunction(() => document.querySelectorAll('.audioflix-provider-queue-list li')[2]?.classList.contains('is-current'), undefined, { timeout: 5000 });
    progress('repeat-one OK — loops only the current song, then normal queue advance resumes when disabled');

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
    const hiddenExpectedNext = await page.locator('.audioflix-provider-queue-list li').nth(1)
        .locator('[data-url-player-action="queue-jump"]').textContent()
        .then((text) => String(text || '').replace(/^▶\s*/, '').trim());
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

    // Fast Track can hand its exact query to the full Nexus Audio Link panel for deeper facets/tools.
    await page.click('[data-af-action="open-nexus-quick"][data-af-type="music"]');
    await page.fill('.audioflix-nexus-quick input[type="search"]', 'Beta');
    await page.click('.audioflix-nexus-quick [data-quick-action="open-nexus"]');
    await page.waitForSelector('.audioflix-nexus-panel [data-af-nexus-search][data-af-type="music"]', { timeout: 5000 });
    assert(await page.inputValue('.audioflix-nexus-panel [data-af-nexus-search][data-af-type="music"]') === 'Beta',
        'Fast Track transfers the current query into the main Nexus Audio Link panel');
    await page.waitForSelector('.audioflix-nexus-panel [data-af-action="nexus-jump-card"][data-af-type="music"]');
    const nexusLayer = await page.evaluate(() => ({
        raised: document.querySelector('#audioflix-overlay')?.classList.contains('audioflix-nexus-over-internal'),
        overlayZ: Number(getComputedStyle(document.querySelector('#audioflix-overlay')).zIndex) || 0,
        playerZ: Number(getComputedStyle(document.querySelector('.audioflix-provider-stage')).zIndex) || 0
    }));
    assert(nexusLayer.raised && nexusLayer.overlayZ > nexusLayer.playerZ,
        'full Nexus panel is raised above the Internal Player while interactive');
    await page.click('.audioflix-nexus-panel [data-af-action="nexus-jump-card"][data-af-type="music"]');
    await page.waitForFunction(() => [...document.querySelectorAll('.audioflix-item-card')].some(card =>
        card.classList.contains('is-nexus-jump-target') && /Beta/.test(card.textContent || '')), undefined, { timeout: 5000 });
    assert(await page.locator('.audioflix-nexus-panel').count() === 0, 'main Nexus Jump to card closes the manager panel before navigation');
    progress('main Nexus result Jump to card OK');

    assert(pageErrors.length === 0, 'no uncaught page errors: ' + pageErrors.join(' | '));
    await browser.close();
    console.log('AUDIOFLIX_QUEUE_VIEW_SMOKE_OK');
}

main().catch((err) => { console.error(err); process.exit(1); });
