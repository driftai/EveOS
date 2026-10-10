import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { createLongQueueHarness, normalizeSpotify, spotifyTrackId } from '../smoke/audioflix_spotify_long_queue_live_support.mjs';
import { installBackendWriteBarrier, readBackendAudioflixSnapshot, assertBackendAudioflixUnchanged } from '../smoke/audioflix_spotify_live_isolation.shared.js';
const require = createRequire(import.meta.url);
const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const OUT = path.join(ROOT, 'data/runtime/smoke-results');
fs.mkdirSync(OUT, { recursive: true });
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/eveos-ports.json'), 'utf8'));
const port = registry.ports.EVEOS_WEB_PORT.port;
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Registered web port required');
const native = process.argv.includes('--native');
const continueNative = process.argv.includes('--continue-native');
const volumeOnly = process.argv.includes('--volume-transition');
const takeOver = process.argv.includes('--take-over');
const httpOnly = process.argv.includes('--http-only');
const repeatProbe = process.argv.includes('--repeat-probe');
const inputFocus = process.argv.includes('--input-focus');
const recoveryOnly = process.argv.includes('--recovery-only');
const resultPath = path.join(OUT, recoveryOnly ? 'LAST-LANE3-RECOVERY-CLOSURE.json' : repeatProbe ? 'LAST-LANE3-REPEAT-PROBE.json' : volumeOnly ? 'LAST-LANE3-VOLUME-TRANSITION.json' : native ? 'LAST-LANE3-NATIVE-RUNTIME-ACCEPTANCE.json' : 'LAST-LANE3-RUNTIME-ACCEPTANCE.json');
const E = { head: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), realSpotify: true,
    ok: false, cases: [], entries: [], timing: {}, notices: [], startedAt: new Date().toISOString() };
const base = `http://127.0.0.1:${port}`, engineUrl = base + '/audioflix-spotify-engine.html';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = () => fs.writeFileSync(resultPath, JSON.stringify(E, null, 2));
const times = (name, value) => { (E.timing[name] ||= []).push(value); };
const backend = () => readBackendAudioflixSnapshot(async () => {
    const response = await fetch(base + '/api/eve-state/modular/load', { signal: AbortSignal.timeout(10000) });
    assert.ok(response.ok); return response.json();
});
let sampler, browser, context, page, H, barrier, tick, ownedEngine = false;
let before, expectedIds, urls, qSamples = [], pageErrors = [], transitions = [], events = [], sourceTracks;
async function inputClick(selector) {
    const cdp = inputFocus ? await context.newCDPSession(page) : null;
    if (cdp) await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    try { await page.locator(selector).click(); }
    finally {
        if (cdp) { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await cdp.detach();
            (E.inputFocusScopes ||= []).push({ selector, disabledAt: new Date().toISOString() }); }
    }
}
async function record(name, run) {
    E.phase = name; write(); const started = performance.now();
    const details = await run(); assert.equal(pageErrors.length, 0, 'No controller errors allowed');
    E.cases.push({ name, ok: true, ms: performance.now() - started, details });
    write(); console.log('LANE3_CASE_OK ' + name);
}
async function state() {
    return page.evaluate(() => {
        const q = window.EveAudioflix.queueConnection.snapshot();
        const m = window.EveAudioflixSpotifyAnyBrowser.snapshot();
        const current = q.entries[q.currentIndex];
        const observationAbsent = m.observation == null
            || (typeof m.observation === 'object' && !Array.isArray(m.observation) && Object.keys(m.observation).length === 0);
        const observation = m.active === false && observationAbsent
            ? { watchRequests: 0, watchJobs: 0, progressRequests: 0, retryTimers: 0, progressTimers: 0,
                recoveryRequests: 0, recoveryTimers: 0 }
            : m.observation;
        return { queue: q, itemId: current?.id, visibility: document.visibilityState,
            playerOpen: window.EveAudioflixAudio.isInternalViewOpen() || window.EveAudioflixSpotifyEngineSurface?.snapshot?.().open === true,
            managed: { active: m.active, ended: m.ended, paused: m.playback.paused,
                time: m.playback.currentTime, duration: m.playback.duration,
                isOwner: m.relay.lastState?.isOwner, ownerEpoch: m.relay.lastState?.ownerEpoch, engineEpoch: m.relay.lastState?.engineEpoch,
                trackGeneration: m.relay.lastState?.trackGeneration, connected: m.relay.connected,
                observation, status: m.relay.lastState?.engine?.status,
                eventCursor: m.relay.lastState?.engine?.eventCursor,
                completionId: m.relay.lastState?.engine?.completionId }, volume: window.EveAudioflixSpotifyAnyBrowser.volumeDiagnostics(),
            diagnostics: window.EveAudioflixDiagnostics.snapshot() };
    });
}
const OBSERVATION_COUNTERS = ['watchJobs', 'watchRequests', 'progressRequests', 'retryTimers', 'progressTimers',
    'recoveryRequests', 'recoveryTimers'];
function assertObservationCounters(observation, settled = false) {
    assert.ok(observation && typeof observation === 'object' && !Array.isArray(observation), 'Observer diagnostics required');
    for (const key of OBSERVATION_COUNTERS) {
        assert.ok(Number.isInteger(observation[key]) && observation[key] >= 0 && observation[key] <= 1,
            `${key} must stay bounded to one`);
        if (settled) assert.equal(observation[key], 0, `${key} must settle after stop/reset`);
    }
}

async function until(check, timeout = 60000) {
    const deadline = Date.now() + timeout; let last;
    while (Date.now() < deadline) { last = await check(); if (last) return last; await sleep(250); }
    throw Error(`Phase ${E.phase} timed out after ${timeout}ms`);
}
async function ready(index = null) {
    return until(async () => {
        const s = await state(); assert.equal(s.queue.groupName, H.groupName || E.group);
        assert.ok(s.queue.entries.every(item => item.id.startsWith(E.prefix)));
        if (s.managed.active) assertObservationCounters(s.managed.observation);
        if (index !== null && s.queue.currentIndex !== index) return false;
        if (!s.managed.active || s.managed.paused || s.managed.duration <= 60 || !s.managed.isOwner
            || s.managed.observation.watchJobs !== 1) return false;
        const position = s.queue.entries.findIndex(item => item.id === s.itemId);
        const sourceIndex = Number(s.itemId.slice(E.prefix.length));
        await H.waitForManagedPlayback(spotifyTrackId(urls[sourceIndex]));
        return { ...s, position, sourceIndex };
    });
}
async function idleWindow(ms = 5000, reset = false) {
    const started = Date.now(); let samples = 0;
    do {
        const actual = await H.jsonRequest('/api/audioflix/spotify-browser/status');
        assert.equal(actual.playingCount, 0, 'No delayed autoplay allowed during idle window');
        assert.ok(!['playing', 'starting', 'controlling'].includes(actual.state));
        const s = await state();
        if (reset) {
            assert.equal((actual.trackIds || []).length, 0, 'Reload must unload the old provider track');
            assert.equal(s.queue.isPlaying, false); assert.equal(s.queue.currentIndex, -1);
            assert.equal(s.queue.playbackRunId, 0); assert.equal(s.queue.groupName, '');
            assert.equal(s.queue.entries.length, 0); assert.equal(s.itemId, undefined);
            assert.equal(s.managed.active, false); assert.equal(s.managed.time, 0);
            assert.equal(s.playerOpen, false);
            const audioId = await page.evaluate(() => window.EveAudioflixAudio.getPlaybackState()?.item?.id || '');
            assert.equal(audioId, '');
        }
        assertObservationCounters(s.managed.observation, reset);
        samples++; await sleep(500);
    } while (Date.now() - started < ms);
    return { ms: Date.now() - started, samples, noDelayedAutoplay: true, reset };
}
async function awaitNaturalChange(old, repeat = false) {
    assert.ok(old.managed.duration <= 360, 'Short closure requires a track <=6 minutes');
    const limit = Math.ceil((old.managed.duration - old.managed.time + 80) * 1000);
    const changed = await until(async () => {
        const s = await state();
        assert.equal(s.playerOpen, false, 'Queue View must remain closed');
        if (s.queue.playbackRunId === old.queue.playbackRunId) return false;
        assert.equal(s.queue.currentIndex, repeat ? old.queue.currentIndex : old.queue.currentIndex + 1);
        assert.equal(s.itemId, repeat ? old.itemId : old.queue.entries[old.queue.currentIndex + 1]?.id);
        return s;
    }, limit);
    const playing = await ready(changed.queue.currentIndex);
    assert.equal(playing.queue.playbackRunId, old.queue.playbackRunId + 1, 'One natural Ended must create exactly one queue run');
    assert.equal(playing.managed.ownerEpoch, old.managed.ownerEpoch, 'Natural handoff must retain the controller owner');
    assert.equal(playing.managed.engineEpoch, old.managed.engineEpoch, 'Natural handoff must not restart the engine');
    const lastEnd = [...events].reverse().find(event => event.status === 'Ended' && event.itemId === old.itemId
        && event.run === old.queue.playbackRunId);
    assert.ok(lastEnd, 'Natural handoff must consume an Ended event for the old track');
    const elapsed = Date.now() - lastEnd.at; transitions.push(elapsed); times('natural-ended-to-confirmed-playing', elapsed);
    return { beforeRun: old.queue.playbackRunId, afterRun: playing.queue.playbackRunId,
        currentIndex: playing.queue.currentIndex, duration: playing.managed.duration, visibility: playing.visibility,
        noSeek: true, repeat };
}
async function foreground() {
    const cdp = await context.newCDPSession(page); const { windowId } = await cdp.send('Browser.getWindowForTarget');
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.detach(); await page.bringToFront();
    if (!inputFocus) await until(async () => (await state()).visibility === 'visible');
}
async function tailTransition(old) {
    const beforeTime = performance.now();
    await page.evaluate(duration => window.EveAudioflixAudio.seek(duration - 3), old.managed.duration);
    const changed = await until(async () => {
        const s = await state(); return s.queue.playbackRunId !== old.queue.playbackRunId && s;
    });
    assert.equal(changed.itemId, old.queue.entries[old.queue.currentIndex + 1]?.id);
    const playing = await ready(changed.queue.currentIndex); times('seek-assisted-tail-to-playing', performance.now() - beforeTime);
    return { currentIndex: playing.queue.currentIndex, seekAssisted: true };
}
async function volumeFromQueueView(gain) {
    const old = await ready();
    const prior = await H.jsonRequest('/api/audioflix/spotify-browser/status');
    const rect = await page.locator('.audioflix-provider-volume:visible').boundingBox();
    assert.ok(rect && rect.width > 20, 'Visible Queue View volume slider required');
    await page.mouse.click(rect.x + 8 + (rect.width - 16) * gain, rect.y + rect.height / 2);
    const ui = await page.evaluate(() => {
        const input = [...document.querySelectorAll('.audioflix-provider-volume')].find(node => node.getBoundingClientRect().width > 0);
        const id = window.EveAudioflix.queueConnection.snapshot().entries[window.EveAudioflix.queueConnection.snapshot().currentIndex]?.id;
        return { raw: Number(input.value), id, expected: window.EveAudioflixOutputPort?.effective?.(Number(input.value)) ?? Number(input.value),
            heading: input.closest('.audioflix-provider-stage')?.querySelector('header strong')?.textContent,
            playbackId: window.EveAudioflixAudio.getPlaybackState()?.item?.id };
    });
    const deadline = Date.now() + 10000; let actual;
    do { actual = await H.jsonRequest('/api/audioflix/spotify-browser/status');
        if (Math.abs(actual.desiredVolume - ui.expected) < 0.0001 && actual.lastAppliedAt > prior.lastAppliedAt) break;
        await sleep(250);
    } while (Date.now() < deadline);
    const proof = { currentId: old.itemId, before: old.managed, ui,
        applied: actual.desiredVolume, appliedAt: actual.lastAppliedAt, priorAt: prior.lastAppliedAt,
        managed: (await state()).managed, volume: (await state()).volume };
    (E.queueVolumeProof ||= []).push(proof); write();
    assert.equal(ui.id, old.itemId); assert.equal(ui.playbackId, old.itemId);
    assert.ok(Math.abs(actual.desiredVolume - ui.expected) < 0.0001 && actual.lastAppliedAt > prior.lastAppliedAt,
        `Queue View volume disconnected at index ${old.queue.currentIndex}: expected ${ui.expected}, helper ${actual.desiredVolume}`);
    return proof;
}
async function attach(entry) {
    E.entry = entry; E.group = `Lane3 isolated ${Date.now().toString(36)}`; E.prefix = `lane3-closure-${Date.now().toString(36)}-`;
    const controllerUrl = entry === 'http' ? base + '/EveOS.html' : pathToFileURL(path.join(ROOT, 'EveOS.html')).href;
    H = createLongQueueHarness({ base, controllerUrl, engineUrl, groupName: E.group,
        fixturePrefix: E.prefix, transitionTimeout: 60000, tailSeconds: 3, shouldStart: true, takeOver });
    const bootStart = performance.now(); const preflight = await H.ensureManagedEngine(); ownedEngine = preflight.startedBySmoke;
    assert.equal(preflight.status.authState, 'signed-in');
    times('managed-engine-start-and-idle', performance.now() - bootStart);
    context = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: 'block' });
    barrier = await installBackendWriteBarrier(context, [base, engineUrl]); page = await context.newPage();
    pageErrors = []; events = []; qSamples = [];
    page.on('pageerror', error => pageErrors.push(error.message));
    page.on('console', message => { if (message.text().includes('[Audioflix] Skipped')) E.notices.push(message.text().slice(0, 300)); });
    await page.exposeFunction('__lane3Event', data => { events.push({ ...data, at: Date.now() }); if (events.length > 120) events.shift(); });
    const loaded = performance.now(); await page.goto(controllerUrl, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.EveAudioflix?.ready && window.EveAudioflixSpotifyAnyBrowser?.ready
        && window.EveAudioflixDiagnostics?.ready, null, { timeout: 120000 });
    await page.waitForFunction(() => window.__eveCoreDataLoaded === true, null, { timeout: 120000 });
    await H.waitForControllerHydration(page); await barrier.proveBlocked(page);
    times('controller-navigation-hydration', performance.now() - loaded);
    await page.evaluate(() => window.addEventListener('eve:audioflix-playback', event => {
        const m = window.EveAudioflixSpotifyAnyBrowser.snapshot(), r = m.relay.lastState || {}, e = r.engine || {};
        window.__lane3Event({ status: String(event.detail?.status || ''), itemId: String(event.detail?.item?.id || ''),
            run: window.EveAudioflix.queueConnection.snapshot().playbackRunId, visibility: document.visibilityState,
            engine: { status: e.status, ended: e.ended, completionId: e.completionId, eventCursor: e.eventCursor,
                ownerEpoch: r.ownerEpoch, engineEpoch: r.engineEpoch, generation: r.trackGeneration,
                engineGeneration: e.generation, time: e.currentTime } });
    }));
    if (!sourceTracks) sourceTracks = await page.evaluate(() => {
        const seen = new Set();
        return (window.EveAudioflixState.ensure().music || []).map(item => ({ url: item.spotifyUrl || item.url || item.originalUrl || '',
            duration: Number(item.duration || item.resolvedDuration || 0) }))
            .filter(item => /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)[A-Za-z0-9]{22}/i.test(item.url))
            .sort((a, b) => (a.duration > 60 ? a.duration : 10000) - (b.duration > 60 ? b.duration : 10000))
            .filter(item => { const id = item.url.match(/[A-Za-z0-9]{22}/)?.[0]; if (seen.has(id)) return false; seen.add(id); return true; }).slice(0, 3);
    });
    assert.equal(sourceTracks.length, 3, 'Need three real Spotify-linked sources');
    urls = sourceTracks.map(item => normalizeSpotify(item.url));
    expectedIds = urls.map((_, index) => E.prefix + index);
    await page.evaluate(({ urls, group, prefix }) => {
        const S = window.EveAudioflixState; S.addMusicGroup(group);
        urls.forEach((url, index) => { const added = S.addItem('music', { id: prefix + index,
            title: `Lane3 isolated ${index + 1}`, url, spotifyUrl: url, sourceProvider: 'spotify', type: 'music', volume: 0.04 });
            S.toggleMusicGroup(added.id, group, true); });
        S.update({ musicViewMode: 'frontend', activeFrontendMusicGroup: group,
            activeFrontendMusicArtist: '', activeFrontendMusicClassifier: '', activeMusicFolderScope: '' }, 'lane3-disposable-qualification');
    }, { urls, group: E.group, prefix: E.prefix });
    await page.evaluate(() => window.EveAudioflix.open());
    E.workspaceOpenedThroughPublicApi = true;
    await inputClick('[data-af-action="tab"][data-af-tab="music"]');
    await page.waitForFunction(group => document.querySelector('.audioflix-item-grid[data-af-active-group]')?.dataset.afActiveGroup === group, E.group);
    tick = setInterval(() => state().then(s => { qSamples.push({ at: Date.now(), observation: s.managed.observation, volume: s.volume,
        index: s.queue.currentIndex, run: s.queue.playbackRunId, paused: s.managed.paused, visibility: s.visibility });
        if (qSamples.length > 220) qSamples.shift(); E.live = qSamples.at(-1); write(); }).catch(() => {}), 5000);
    await inputClick('.audioflix-frontend-subhead [data-af-action="play-music-group"]:visible');
    await H.waitForFixtureQueue(page, expectedIds); await ready(0);
}
async function detach() {
    clearInterval(tick); if (!page) return;
    E.entries.push({ entry: E.entry, observerSamples: qSamples, barrier: barrier.summary(), events,
        final: await state().catch(() => null), pageErrors });
    await page.evaluate(async () => { const q = window.EveAudioflix.queueConnection.snapshot();
        if (q.repeatOne) window.EveAudioflix.queueConnection.action('repeat-one');
        await window.EveAudioflixAudio.stopAll(); }).catch(() => {});
    await H.disposeControllerProbe(page).catch(() => {}); await context.close(); page = null;
    if (ownedEngine) await H.jsonRequest('/api/audioflix/spotify-browser/stop', 'POST', {});
    ownedEngine = false; E.libraryAfter = await backend(); assertBackendAudioflixUnchanged(before, E.libraryAfter);
}
(async () => {
    before = await backend(); E.libraryBefore = before; write();
    browser = native ? await require('./lane3-native-controller.cjs').launch() : await chromium.launch({ headless: false });
    E.controllerDriver = native ? 'headed Chromium/raw CDP, no forced focus' : 'Playwright headed Chromium';
    if (inputFocus) E.controllerDriver = 'headed Chromium/raw CDP; focus emulation only for control clicks, disabled during every playback/lifecycle measurement';
    const rootSession = await browser.newBrowserCDPSession();
    const processes = await rootSession.send('SystemInfo.getProcessInfo');
    const roots = processes.processInfo.filter(item => item.type === 'browser').map(item => item.id); await rootSession.detach();
    const { createRuntimeSampler } = require('./lane3-runtime-metrics.cjs');
    sampler = createRuntimeSampler({ backendPort: port, controllerRootPids: roots, intervalMs: 5000, maxSamples: 220 });
    await sampler.start('http-start');
    await record('http-signed-in-play-group-no-queue-view', async () => { await attach('http'); return { duration: (await state()).managed.duration }; });
    if (repeatProbe) {
        await record('seek-assisted-repeat-exactly-one-new-run', async () => {
            const old = await ready(0); await page.evaluate(() => window.EveAudioflix.queueConnection.action('repeat-one'));
            await page.evaluate(duration => window.EveAudioflixAudio.seek(duration - 3), old.managed.duration);
            await until(async () => (await state()).queue.playbackRunId !== old.queue.playbackRunId);
            const repeated = await ready(0);
            assert.equal(repeated.queue.playbackRunId, old.queue.playbackRunId + 1);
            await sleep(2000); assert.equal((await state()).queue.playbackRunId, repeated.queue.playbackRunId);
            return { seekAssisted: true, beforeRun: old.queue.playbackRunId, afterRun: repeated.queue.playbackRunId };
        }); E.ok = true; return;
    }
    if (!recoveryOnly) await record('real-status-command-volume-timing', async () => {
        for (let i = 0; i < 12; i++) {
            const measured = await page.evaluate(async () => { const start = performance.now();
                const result = await window.EveAudioflixSpotifyRemote.status(); return { ok: result.ok, ms: performance.now() - start }; });
            assert.ok(measured.ok); times('frontend-status-roundtrip', measured.ms);
        }
        for (const action of ['pause', 'resume', 'pause', 'resume']) {
            const measured = await page.evaluate(async action => { const start = performance.now();
                const result = await window.EveAudioflixSpotifyRemote.send(action, {}); return { ok: result.ok, ms: performance.now() - start }; }, action);
            assert.ok(measured.ok); times('frontend-command-' + action, measured.ms);
        }
        for (const gain of [0.02, 0.06, 0.03, 0.04]) {
            const start = performance.now(); const current = await state();
            const previous = await H.jsonRequest('/api/audioflix/spotify-browser/status');
            const expected = await page.evaluate(gain => window.EveAudioflixOutputPort?.effective?.(gain) ?? gain, gain);
            await page.evaluate(({ id, gain }) => window.EveAudioflixAudio.updateItemVolume(id, gain), { id: current.itemId, gain });
            await until(async () => { const s = await state(); return !s.volume?.inFlight && !s.volume?.queued && s.volume?.pending === 0; }, 10000);
            const actual = await H.jsonRequest('/api/audioflix/spotify-browser/status');
            assert.ok(Math.abs(actual.desiredVolume - expected) < 0.0001, `Volume ${gain} was not applied by the real helper`);
            assert.ok(actual.lastAppliedAt > previous.lastAppliedAt, 'Volume helper application timestamp must advance');
            (E.volumeProof ||= []).push({ gain, expected, applied: actual.desiredVolume, playingCount: actual.playingCount });
            times('frontend-volume-drain', performance.now() - start);
        }
        return { noSeek: true };
    });
    if (volumeOnly) {
        await record('queue-view-volume-first-and-two-next-tracks', async () => {
            await page.evaluate(() => { const q = window.EveAudioflix.queueConnection.snapshot();
                return window.EveAudioflixAudio.openInternalView(window.EveAudioflixSpotifyAnyBrowser.snapshot().item); });
            await page.waitForFunction(() => window.EveAudioflixSpotifyEngineSurface.snapshot().open);
            await volumeFromQueueView(0.07);
            await tailTransition(await ready(0)); await volumeFromQueueView(0.13);
            await tailTransition(await ready(1)); await volumeFromQueueView(0.08);
            return { actualPointerInputs: true, transitions: 2, seekAssisted: true, reopened: false };
        });
        E.ok = true; return;
    }
    if (!recoveryOnly) {
    if (!continueNative) await record(inputFocus ? 'native-full-duration-natural-handoff' : 'foreground-full-duration-natural-handoff', async () => awaitNaturalChange(await ready(0)));
    else await record('native-resume-at-second-track', async () => {
        await page.evaluate(() => window.EveAudioflix.queueConnection.jump(1)); await ready(1);
        return { foregroundProof: 'LAST-LANE3-RUNTIME-ACCEPTANCE.json', explicitJump: true };
    });
    await record('hidden-full-duration-natural-handoff', async () => {
        const cdp = await context.newCDPSession(page); const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }); await cdp.detach();
        await until(async () => (await state()).visibility === 'hidden');
        const old = await ready(1), details = await awaitNaturalChange(old);
        assert.equal(details.visibility, 'hidden');
        const ending = [...events].reverse().find(event => event.status === 'Ended' && event.itemId === old.itemId);
        assert.equal(ending.visibility, 'hidden', 'Ended must execute while genuinely hidden');
        await foreground(); return details;
    });
    await record('repeat-on-full-duration-natural-ended', async () => {
        const old = await ready(2); await page.evaluate(() => window.EveAudioflix.queueConnection.action('repeat-one'));
        assert.equal((await state()).queue.repeatOne, true); return awaitNaturalChange(old, true);
    });
    await record('repeat-off-full-duration-natural-queue-advance', async () => {
        // Move current to #1 and make another existing entry #2; keep the same active playback run.
        const old = await ready(2); await page.evaluate(() => { const q = window.EveAudioflix.queueConnection;
            q.action('repeat-one'); q.move(q.snapshot().currentIndex, 0); });
        const moved = await ready(0); assert.equal(moved.queue.playbackRunId, old.queue.playbackRunId);
        assert.equal(moved.itemId, old.itemId);
        const cdp = await context.newCDPSession(page); const { windowId } = await cdp.send('Browser.getWindowForTarget');
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } }); await cdp.detach();
        await until(async () => (await state()).visibility === 'hidden');
        const details = await awaitNaturalChange(moved);
        assert.equal(details.visibility, 'hidden');
        const ending = [...events].reverse().find(event => event.status === 'Ended' && event.itemId === moved.itemId
            && event.run === moved.queue.playbackRunId);
        assert.equal(ending.visibility, 'hidden'); await foreground(); return details;
    });
    await record('shuffle-current-to-one-next-track', async () => {
        const old = await ready(); await inputClick('[data-af-action="shuffle-music-group"]:visible');
        const shuffled = await ready(0); assert.equal(shuffled.itemId, old.itemId);
        assert.equal(shuffled.queue.playbackRunId, old.queue.playbackRunId); return tailTransition(shuffled);
    });
    }
    await record('relay-disconnect-reconnect-no-autoplay', async () => {
        await page.evaluate(() => window.EveAudioflixSpotifyRemote.disconnect()); await sleep(2500);
        assert.equal((await H.jsonRequest('/api/audioflix/spotify-browser/status')).playingCount, 0);
        await page.evaluate(() => window.EveAudioflixSpotifyRemote.retry());
        await until(async () => (await state()).managed.connected);
        assert.equal((await H.jsonRequest('/api/audioflix/spotify-browser/status')).playingCount, 0);
        const sustainedIdle = await idleWindow();
        await inputClick('.audioflix-frontend-subhead [data-af-action="play-music-group"]:visible'); await ready(0);
        return { stoppedOnDisconnect: true, noAutoplay: true, sustainedIdle, explicitReplay: true };
    });
    await record('helper-restart-bounded-observer-no-autoplay', async () => {
        const old = await ready(0);
        const stopped = await H.jsonRequest('/api/audioflix/spotify-browser/stop', 'POST', {}); assert.ok(stopped.ok);
        await until(async () => (await state()).managed.observation.state === 'degraded', 20000);
        const degraded = await state(); assert.equal(degraded.queue.playbackRunId, old.queue.playbackRunId);
        assert.equal(degraded.itemId, old.itemId); assert.equal(degraded.managed.observation.progressTimers, 0);
        assertObservationCounters(degraded.managed.observation);
        assert.equal(degraded.managed.observation.recoveryRequests, 0);
        assert.equal(degraded.managed.observation.recoveryTimers, 1, 'Degraded playback must retain exactly one recovery sentinel');
        const restarted = await H.ensureManagedEngine(); assert.equal(restarted.status.authState, 'signed-in');
        assert.equal(restarted.status.playingCount, 0, 'Helper restart must not invent Play');
        const sustainedIdle = await idleWindow();
        const retired = await state();
        assert.equal(retired.managed.active, false, 'Fresh helper reset must retire stale managed playback before replay');
        assertObservationCounters(retired.managed.observation, true);
        await inputClick('.audioflix-frontend-subhead [data-af-action="play-music-group"]:visible');
        const recovered = await ready(0); assert.ok(recovered.managed.engineEpoch > old.managed.engineEpoch);
        return { degraded: degraded.managed.observation, noAutoplay: true,
            previousEngineEpoch: old.managed.engineEpoch, currentEngineEpoch: recovered.managed.engineEpoch, sustainedIdle };
    });
    await record('http-reload-stop-reset', async () => {
        await page.goto(base + '/EveOS.html', { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.EveAudioflix?.ready && window.EveAudioflixSpotifyAnyBrowser?.ready, null, { timeout: 120000 });
        await H.waitForControllerHydration(page);
        await until(async () => (await H.jsonRequest('/api/audioflix/spotify-browser/status')).playingCount === 0);
        const reloaded = await state(); assert.equal(reloaded.queue.isPlaying, false);
        const sustainedIdle = await idleWindow(5000, true);
        return { stopped: true, reset: true, sustainedIdle };
    });
    await detach();
    if (httpOnly) {
        assert.equal(E.notices.length, 0, 'No skipped starts allowed'); E.ok = true; return;
    }
    await record('file-signed-in-play-group-no-queue-view', async () => { await attach('file'); return { duration: (await state()).managed.duration }; });
    await record('file-seek-assisted-next', async () => tailTransition(await ready(0)));
    await detach(); E.libraryAfter = await backend(); assertBackendAudioflixUnchanged(before, E.libraryAfter);
    assert.equal(E.notices.length, 0, 'No skipped starts allowed'); E.ok = true;
})().catch(async error => {
    E.failure = { phase: E.phase, message: error.message, stack: error.stack?.split('\n').slice(0, 8) };
    if (page) { E.failureState = await state().catch(() => null);
        E.failureHelper = await H?.jsonRequest('/api/audioflix/spotify-browser/status').catch(() => null);
        await page.screenshot({ path: path.join(OUT, 'lane3-runtime-failure.png') }).catch(() => {}); }
    console.error('LANE3_RUNTIME_ACCEPTANCE_FAIL ' + E.phase + ': ' + error.message); process.exitCode = 1;
}).finally(async () => {
    await detach().catch(error => { E.cleanupError = error.message; E.ok = false; process.exitCode = 1; });
    if (sampler) E.resources = await sampler.stop(); await browser?.close();
    E.finishedAt = new Date().toISOString(); write();
    console.log(`LANE3_RUNTIME_ACCEPTANCE_${E.ok ? 'OK' : 'INCOMPLETE'} cases=${E.cases.length} evidence=${resultPath}`);
});
