import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createLongQueueHarness, normalizeSpotify, spotifyTrackId } from '../smoke/audioflix_spotify_long_queue_live_support.mjs';
import { installBackendWriteBarrier, readBackendAudioflixSnapshot, assertBackendAudioflixUnchanged } from '../smoke/audioflix_spotify_live_isolation.shared.js';

// Opt-in live acceptance. The native browser uses its own temporary profile;
// the normal managed helper owns the existing signed-in Spotify session.
const require = createRequire(import.meta.url);
const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const OUT = path.join(ROOT, 'data/runtime/smoke-results');
fs.mkdirSync(OUT, { recursive: true });
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/eveos-ports.json'), 'utf8'));
const port = registry.ports.EVEOS_WEB_PORT.port;
assert.ok(Number.isInteger(port) && port > 0 && port < 65536, 'Registered web port required');
const base = `http://127.0.0.1:${port}`;
const engineUrl = base + '/audioflix-spotify-engine.html';
const controllerUrl = pathToFileURL(fs.realpathSync(path.join(ROOT, 'EveOS.html'))).href;
const resultPath = path.join(OUT, 'LAST-LANE3-FILE-ACCEPTANCE.json');
const suffix = randomUUID();
const groupName = `Lane3 file isolated ${suffix}`;
const fixturePrefix = `lane3-file-${suffix}-`;
const H = createLongQueueHarness({ base, controllerUrl, engineUrl, groupName, fixturePrefix,
    transitionTimeout: 60000, tailSeconds: 3, shouldStart: true, takeOver: false });
const E = { schemaVersion: 1, head: execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
    controllerUrl, nativeController: true, realSpotify: true, ok: false, phase: 'preflight',
    startedAt: new Date().toISOString(), cases: [], pageErrors: [], skips: [], events: [], counterSamples: [] };
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const write = () => fs.writeFileSync(resultPath, JSON.stringify(E, null, 2));
const redact = value => String(value || '').replace(/([?&]pair=)[^\s&#]+/g, '$1[redacted]')
    .replace(/\b[A-Za-z0-9_-]{30,}\b/g, '[redacted]').slice(0, 300);
let browser, context, page, approvalContext, approvalPage, barrier, before, ownedEngine = false;
let urls = [], expectedIds = [], commandIssued = false, approvalStats;
async function inputClick(targetPage, targetContext, selector) {
    const cdp = await targetContext.newCDPSession(targetPage);
    await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
    try { await targetPage.locator(selector).click(); }
    finally { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }); await cdp.detach();
        (E.inputFocusScopes ||= []).push({ selector, disabledAt: new Date().toISOString() }); }
}

function healthy() {
    assert.equal(E.pageErrors.length, 0, 'Page/native interception errors occurred; inspect ignored artifact');
    assert.equal(E.skips.length, 0, 'Skipped playback starts occurred; inspect ignored artifact');
}
function audit(target, surface) {
    target.on('pageerror', error => {
        if (E.pageErrors.length < 40) E.pageErrors.push({ surface, phase: E.phase, message: redact(error.message) });
    });
    target.on('console', message => {
        if (message.text().includes('[Audioflix] Skipped') && E.skips.length < 40) E.skips.push({ surface, phase: E.phase });
    });
}
async function until(check, timeout = 60000) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        healthy(); const value = await check(); if (value) return value; await sleep(250);
    }
    throw Error(`Timed out in ${E.phase} after ${timeout}ms`);
}
async function record(name, run) {
    E.phase = name; write(); const started = performance.now();
    const details = await run(); healthy();
    E.cases.push({ name, ok: true, startedAt: new Date(Date.now() - (performance.now() - started)).toISOString(),
        ms: performance.now() - started, details }); write();
}
async function jsonRead(endpoint) {
    const response = await fetch(base + endpoint, { signal: AbortSignal.timeout(12000) });
    assert.ok(response.ok, `Read endpoint failed: ${endpoint}`); return response.json();
}
const backend = () => readBackendAudioflixSnapshot(() => jsonRead('/api/eve-state/modular/load'));
async function spotifySources() {
    const response = await jsonRead('/api/eve-state/modular/load');
    assert.equal(response?.ok, true, 'Canonical backend state read required for fixture discovery');
    const audioflix = response.state?.audioflix ?? response.state?.bookmarks?.config?.audioflix ?? null;
    const seen = new Set();
    return (audioflix?.music || []).map(item => ({ url: item.spotifyUrl || item.url || item.originalUrl || '',
        duration: Number(item.duration || item.resolvedDuration || 0) }))
        .filter(item => /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)[A-Za-z0-9]{22}/i.test(item.url))
        .sort((a, b) => (a.duration > 10 ? a.duration : 10000) - (b.duration > 10 ? b.duration : 10000))
        .filter(item => { const id = item.url.match(/(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)([A-Za-z0-9]{22})/i)?.[1];
            if (!id || seen.has(id)) return false; seen.add(id); return true; })
        .slice(0, 2);
}
const helper = () => jsonRead('/api/audioflix/spotify-browser/status');
const idle = status => status.ok === true && Number(status.playingCount || 0) === 0
    && (status.trackIds || []).length === 0
    && !['playing', 'starting', 'controlling'].includes(String(status.state || '').toLowerCase());
async function state() {
    return page.evaluate(() => {
        const q = window.EveAudioflix.queueConnection.snapshot();
        const m = window.EveAudioflixSpotifyAnyBrowser.snapshot();
        const r = window.EveAudioflixSpotifyRemote.snapshot();
        const audio = window.EveAudioflixAudio.getPlaybackState();
        const observationAbsent = m.observation == null
            || (typeof m.observation === 'object' && !Array.isArray(m.observation) && Object.keys(m.observation).length === 0);
        const observation = m.active === false && observationAbsent
            ? { watchRequests: 0, watchJobs: 0, progressRequests: 0, retryTimers: 0, progressTimers: 0,
                recoveryRequests: 0, recoveryTimers: 0 }
            : m.observation;
        const rawVolume = window.EveAudioflixSpotifyAnyBrowser.volumeDiagnostics();
        const volume = m.active === false && rawVolume == null ? { inFlight: 0, pending: 0 } : rawVolume;
        return { queue: q, itemId: q.entries[q.currentIndex]?.id || '',
            playerOpen: window.EveAudioflixAudio.isInternalViewOpen()
                || window.EveAudioflixSpotifyEngineSurface?.snapshot?.().open === true, visibility: document.visibilityState,
            managed: { active: m.active, ended: m.ended, paused: m.playback.paused,
                time: m.playback.currentTime, duration: m.playback.duration,
                connected: r.connected, approvalRequired: r.approvalRequired,
                isOwner: m.relay.lastState?.isOwner, engineEpoch: m.relay.lastState?.engineEpoch,
                ownerEpoch: m.relay.lastState?.ownerEpoch, trackGeneration: m.relay.lastState?.trackGeneration,
                observation },
            audio: { itemId: audio?.item?.id || '', status: audio?.status || '',
                time: audio?.currentTime || 0 }, volume,
            diagnosticsAbsent: { observation: observationAbsent, volume: rawVolume == null } };
    });
}
async function ready(index) {
    const result = await until(async () => {
        const s = await state(); assert.equal(s.playerOpen, false, 'Queue View must remain closed');
        assertCounters(s);
        assert.equal(s.queue.groupName, groupName);
        assert.deepEqual(s.queue.entries.map(item => item.id), expectedIds, 'Disposable queue identity drifted');
        if (s.queue.currentIndex !== index || !s.queue.isPlaying || !s.managed.active
            || s.managed.paused || !s.managed.isOwner || s.managed.duration <= 10
            || s.managed.observation.watchJobs !== 1) return false;
        const actual = await helper();
        return actual.ok && actual.helperReachable && actual.sessionPresent
            && actual.pageUrl === engineUrl && actual.playingCount === 1
            && (actual.trackIds || []).length === 1
            && actual.trackIds[0] === spotifyTrackId(urls[index]) && s;
    });
    await H.waitForManagedPlayback(spotifyTrackId(urls[index]));
    const confirmed = await state();
    assert.equal(confirmed.itemId, expectedIds[index]);
    assert.equal(confirmed.queue.playbackRunId, result.queue.playbackRunId, 'Run changed during helper confirmation');
    assert.equal(confirmed.managed.active, true, 'Managed playback must remain active after helper confirmation');
    assert.equal(confirmed.managed.observation.watchJobs, 1, 'Active playback must retain one observer job');
    captureCounters(confirmed);
    return confirmed;
}
function assertCounters(s, settled = false) {
    const observation = s.managed.observation;
    assert.ok(observation && typeof observation === 'object' && !Array.isArray(observation), 'Observer diagnostics required');
    for (const key of ['watchRequests', 'watchJobs', 'progressRequests', 'retryTimers', 'progressTimers',
        'recoveryRequests', 'recoveryTimers']) {
        assert.ok(Number.isInteger(observation[key]) && observation[key] >= 0 && observation[key] <= 1,
            `Observer ${key} must remain bounded to one`);
        if (settled) assert.equal(observation[key], 0, `Observer ${key} must settle after stop`);
    }
    for (const key of ['inFlight', 'pending']) {
        assert.ok(Number.isInteger(s.volume?.[key]) && s.volume[key] >= 0 && s.volume[key] <= 1,
            `Volume ${key} must remain bounded to one`);
        if (settled) assert.equal(s.volume[key], 0, `Volume ${key} must settle after stop`);
    }
}
function captureCounters(s) {
    assertCounters(s);
    if (E.counterSamples.length < 40) E.counterSamples.push({ phase: E.phase, at: Date.now(),
        active: s.managed.active, observation: s.managed.observation, volume: s.volume,
        diagnosticsAbsent: s.diagnosticsAbsent });
}
async function idleWindow(windowMs = 5000, reset = false) {
    let samples = 0; const started = Date.now();
    do {
        healthy(); const actual = await helper(); assert.ok(idle(actual), 'Managed helper must remain idle without autoplay');
        if (reset) {
            const s = await state(); assert.equal(s.playerOpen, false);
            assertCounters(s, true);
            assert.equal(s.queue.isPlaying, false); assert.equal(s.queue.currentIndex, -1);
            assert.equal(s.queue.playbackRunId, 0); assert.equal(s.queue.groupName, '');
            assert.deepEqual(s.queue.entries, []); assert.equal(s.managed.active, false);
            assert.equal(s.managed.observation.progressTimers, 0);
            assert.equal(s.managed.observation.retryTimers, 0);
            assert.equal(s.managed.observation.recoveryRequests, 0);
            assert.equal(s.managed.observation.recoveryTimers, 0);
            assert.equal(s.managed.time, 0); assert.equal(s.audio.itemId, '');
        }
        samples++; await sleep(500);
    } while (Date.now() - started < windowMs);
    return { windowMs: Date.now() - started, samples, noAutoplay: true, reset };
}

async function approveOwnFileSession() {
    // The pending capability is observed only from this newly created file tab.
    // The approval page supplies its own CSRF internally; no tokens are copied.
    const pending = await until(() => page.evaluate(() => {
        const r = window.EveAudioflixSpotifyRemote.snapshot();
        if (!r.approvalRequired) return false;
        const prompt = document.querySelector('[data-eve-spotify-approval="true"]');
        const rect = prompt?.getBoundingClientRect();
        if (!rect?.width || !rect?.height || !r.code || !prompt.textContent.includes(r.code)) return false;
        return { code: r.code, url: r.approvalUrl, visiblePrompt: Boolean(rect?.width > 0 && rect?.height > 0),
            promptMatches: Boolean(r.code && prompt?.textContent.includes(r.code)), connected: r.connected };
    }), 20000);
    assert.equal(pending.connected, false); assert.equal(pending.visiblePrompt, true); assert.equal(pending.promptMatches, true);
    assert.match(pending.code, /^\d{6}$/);
    const observed = new URL(pending.url);
    assert.equal(observed.origin, base); assert.equal(observed.pathname, '/api/audioflix/spotify-approval');
    assert.equal(observed.hash, ''); assert.deepEqual([...observed.searchParams.keys()], ['pair']);
    const pairId = observed.searchParams.get('pair'); assert.match(pairId, /^[A-Za-z0-9_-]{16,120}$/);
    assert.ok(idle(await helper()), 'Unapproved file tab must not start Spotify');
    approvalContext = await browser.newContext({ viewport: { width: 760, height: 700 }, serviceWorkers: 'block' });
    approvalStats = { deniedWrites: 0, approvalPosts: 0, codeMatched: false, armed: false };
    const approvalPostUrl = new URL('/api/audioflix/spotify-client/approve', observed.origin).href;
    await approvalContext.route('**/*', async route => {
        const request = route.request(); const method = request.method().toUpperCase();
        if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return route.fallback();
        let ownPair = false;
        if (method === 'POST' && request.url() === approvalPostUrl) {
            try { ownPair = request.postDataJSON()?.pairId === pairId; } catch {}
        }
        if (ownPair && approvalStats.codeMatched && approvalStats.armed && approvalStats.approvalPosts === 0) {
            approvalStats.approvalPosts++; approvalStats.armed = false;
            return route.fallback(); // Unmodified normal approval-page POST, with its own CSRF.
        }
        approvalStats.deniedWrites++;
        return route.fulfill({ status: 403, contentType: 'application/json',
            body: JSON.stringify({ ok: false, blockedBy: 'lane3-file-approval-isolation' }) });
    });
    approvalPage = await approvalContext.newPage(); audit(approvalPage, 'trusted-approval');
    await approvalPage.goto(observed.href, { waitUntil: 'load', timeout: 30000 });
    const displayed = await approvalPage.evaluate(() => {
        const code = document.querySelector('main code'), rect = code?.getBoundingClientRect();
        return { url: location.href, code: code?.textContent.trim(), visible: Boolean(rect?.width > 0 && rect?.height > 0),
            enabled: document.querySelector('#approve')?.disabled === false };
    });
    assert.equal(displayed.url, observed.href); assert.equal(displayed.enabled, true);
    assert.equal(displayed.visible, true); assert.equal(displayed.code, pending.code);
    const denial = await approvalPage.evaluate(async endpoint => {
        const response = await fetch(endpoint, { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: '{"isolationProbe":true}' });
        return { status: response.status, blockedBy: (await response.json()).blockedBy };
    }, base + '/api/eve-state/modular/save');
    assert.deepEqual(denial, { status: 403, blockedBy: 'lane3-file-approval-isolation' });
    // Revalidate the exact pending session immediately before allowing its UI click.
    const current = await page.evaluate(() => {
        const r = window.EveAudioflixSpotifyRemote.snapshot(); return { code: r.code, url: r.approvalUrl, required: r.approvalRequired };
    });
    assert.deepEqual(current, { code: pending.code, url: pending.url, required: true });
    approvalStats.codeMatched = true; approvalStats.armed = true;
    await inputClick(approvalPage, approvalContext, '#approve');
    await until(() => page.evaluate(() => {
        const r = window.EveAudioflixSpotifyRemote.snapshot(); return r.connected && !r.approvalRequired;
    }), 20000);
    assert.equal(approvalStats.approvalPosts, 1);
    E.pairing = { codeMatched: true, exactOwnPairOnly: true, actualPointerApproval: true,
        approvalPosts: approvalStats.approvalPosts, deniedWrites: approvalStats.deniedWrites };
    await approvalContext.close(); approvalPage = null; approvalContext = null;
    await page.bringToFront();
}

async function seedAndPlay() {
    // Canonical file:// hydration may intentionally expose no persisted library rows to the page.
    // Discover two existing real Spotify links through the same read-only backend load used by the
    // isolation snapshot, then seed only disposable in-page fixture items. No backend write occurs.
    const sources = await spotifySources();
    assert.equal(sources.length, 2, 'Two existing real Spotify-linked backend sources required');
    urls = sources.map(item => normalizeSpotify(item.url)); expectedIds = urls.map((_, index) => fixturePrefix + index);
    await page.evaluate(({ urls, group, prefix, base }) => {
        const S = window.EveAudioflixState; S.addMusicGroup(group);
        urls.forEach((url, index) => {
            const item = S.addItem('music', { id: prefix + index, title: `Lane3 file isolated ${index + 1}`,
                url, spotifyUrl: url, sourceProvider: 'spotify', type: 'music', volume: 0.04 });
            S.toggleMusicGroup(item.id, group, true);
        });
        S.update({ nativeBridgeBase: base, musicViewMode: 'frontend', activeFrontendMusicGroup: group,
            activeFrontendMusicArtist: '', activeFrontendMusicClassifier: '', activeMusicFolderScope: '' }, 'lane3-file-disposable-qualification');
    }, { urls, group: groupName, prefix: fixturePrefix, base });
    await page.evaluate(() => window.EveAudioflix.open());
    E.workspaceOpenedThroughPublicApi = true;
    await inputClick(page, context, '[data-af-action="tab"][data-af-tab="music"]');
    await page.waitForFunction(group => document.querySelector('.audioflix-item-grid[data-af-active-group]')?.dataset.afActiveGroup === group, groupName);
    assert.equal((await state()).playerOpen, false);
    commandIssued = true;
    await inputClick(page, context, '.audioflix-frontend-subhead [data-af-action="play-music-group"]:visible');
    await approveOwnFileSession(); await H.waitForFixtureQueue(page, expectedIds);
    const playing = await ready(0);
    return { actualPointerPlayGroup: true, queueViewClosed: true, exactHelperTrack: true,
        duration: playing.managed.duration, pairing: E.pairing };
}
async function volume(gain, index) {
    const old = await ready(index), prior = await helper();
    const expected = await page.evaluate(gain => window.EveAudioflixOutputPort?.effective?.(gain) ?? gain, gain);
    await page.evaluate(({ id, gain }) => window.EveAudioflixAudio.updateItemVolume(id, gain), { id: old.itemId, gain });
    const applied = await until(async () => {
        const s = await state(), actual = await helper(); assert.equal(s.itemId, old.itemId); assert.equal(s.playerOpen, false);
        assertCounters(s);
        return !s.volume.inFlight && !s.volume.queued && s.volume.pending === 0
            && Math.abs(actual.desiredVolume - expected) < 0.0001 && actual.lastAppliedAt > prior.lastAppliedAt && actual;
    }, 12000);
    await ready(index);
    return { gain, expected, applied: applied.desiredVolume, timestampAdvanced: true, throughAudioApi: true, index };
}
async function cleanup() {
    let failure;
    const attempt = async run => { try { return await run(); } catch (error) { failure ||= error; } };
    if (page && commandIssued) {
        const s = await attempt(state);
        if (s?.managed.isOwner && s.itemId.startsWith(fixturePrefix)) {
            await attempt(() => page.evaluate(() => window.EveAudioflixAudio.stopAll()));
        }
    }
    if (page) await attempt(() => H.disposeControllerProbe(page));
    await attempt(() => approvalContext?.close()); approvalContext = null; approvalPage = null;
    await attempt(() => context?.close()); context = null; page = null;
    if (ownedEngine) await attempt(async () => {
        const status = await helper();
        assert.ok(idle(status), 'Refusing helper cleanup while another playback is active');
        const stopped = await H.jsonRequest('/api/audioflix/spotify-browser/stop', 'POST', {});
        assert.ok(stopped.ok); ownedEngine = false;
    });
    await attempt(() => browser?.close()); browser = null;
    if (before) await attempt(async () => { E.libraryAfter = await backend(); assertBackendAudioflixUnchanged(before, E.libraryAfter); });
    E.finishedHead = execFileSync('git', ['-C', ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
    assert.equal(E.finishedHead, E.head, 'HEAD changed during live file qualification');
    if (barrier) E.controllerWriteBarrier = barrier.summary();
    healthy(); if (failure) throw failure;
}

(async () => {
    H.validateUrls(); before = await backend(); E.libraryBefore = before; write();
    await record('signed-in-idle-managed-engine', async () => {
        const initial = await helper();
        if (initial.browserRunning || initial.helperReachable) {
            assert.equal(initial.pageUrl, engineUrl, 'Existing helper must already own the normal engine page');
            assert.ok(idle(initial), 'Another controller owns playback; release it before running this harness');
        }
        const preflight = await H.ensureManagedEngine(); ownedEngine = preflight.startedBySmoke;
        assert.equal(preflight.status.authState, 'signed-in');
        return { signedIn: true, idle: true, startedByFixture: ownedEngine };
    });
    browser = await require('./lane3-native-controller.cjs').launch();
    context = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: 'block' });
    barrier = await installBackendWriteBarrier(context, [base, engineUrl]);
    page = await context.newPage(); audit(page, 'file-controller');
    await page.exposeFunction('__lane3FileEvent', event => { if (E.events.length < 80) E.events.push({ ...event, at: Date.now() }); });
    await record('canonical-file-navigation-and-write-isolation', async () => {
        await page.goto(controllerUrl, { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.EveAudioflix?.ready && window.EveAudioflixSpotifyAnyBrowser?.ready
            && window.EveAudioflixSpotifyRemote?.ready, null, { timeout: 120000 });
        assert.equal(await page.evaluate(() => location.href), controllerUrl);
        await page.waitForFunction(() => window.__eveCoreDataLoaded === true, null, { timeout: 120000 });
        await H.waitForControllerHydration(page); await barrier.proveBlocked(page);
        await page.evaluate(() => window.addEventListener('eve:audioflix-playback', event => {
            const q = window.EveAudioflix.queueConnection.snapshot();
            window.__lane3FileEvent({ status: String(event.detail?.status || '').slice(0, 40),
                index: q.currentIndex, run: q.playbackRunId });
        }));
        return { canonicalFile: true, writeBarrierDenied: true };
    });
    await record('file-own-session-ui-pairing-play-group-no-queue-view', seedAndPlay);
    await record('file-first-track-volume-through-audio-api', () => volume(0.03, 0));
    await record('file-seek-assisted-next-real-helper-track', async () => {
        const old = await ready(0); const started = performance.now();
        await page.evaluate(duration => window.EveAudioflixAudio.seek(duration - 3), old.managed.duration);
        await until(async () => {
            const s = await state(); assert.equal(s.playerOpen, false);
            if (s.queue.playbackRunId === old.queue.playbackRunId) return false;
            assert.equal(s.queue.currentIndex, 1); assert.equal(s.itemId, expectedIds[1]); return s;
        });
        const next = await ready(1);
        assert.equal(next.queue.playbackRunId, old.queue.playbackRunId + 1, 'Exactly one next-track run required');
        return { seekAssisted: true, naturalCompletionClaimed: false, exactHelperTrack: true,
            currentIndex: next.queue.currentIndex, ms: performance.now() - started };
    });
    await record('file-next-track-volume-through-audio-api', () => volume(0.05, 1));
    await record('file-explicit-stop-settles-observer-volume-and-replay', async () => {
        captureCounters(await ready(1));
        // Exercise the actual user-level queue stop. Audio.stopAll() is deliberately transport-only:
        // it must not mutate EveAudioflix.queueConnection's queue authority. Stop Group first
        // invalidates the queue run / clears isPlaying, then delegates to Audio.stopAll().
        await inputClick(page, context, '.audioflix-frontend-subhead [data-af-action="stop-music-group"]:visible');
        const settled = await until(async () => {
            const s = await state(); assertCounters(s);
            const o = s.managed.observation, v = s.volume;
            return !s.managed.active && !s.diagnosticsAbsent.observation && !s.diagnosticsAbsent.volume
                && !o.watchRequests && !o.watchJobs && !o.progressRequests
                && !o.retryTimers && !o.progressTimers && !o.recoveryRequests && !o.recoveryTimers
                && !v.inFlight && !v.pending
                && s.queue?.isPlaying === false
                && idle(await helper()) && s;
        }, 30000);
        assertCounters(settled, true); captureCounters(settled);
        assert.equal(settled.diagnosticsAbsent.observation, false, 'Explicit stop must expose actual observer counters');
        assert.equal(settled.diagnosticsAbsent.volume, false, 'Explicit stop must expose actual volume counters');
        const stopped = await idleWindow(5000);
        assert.equal(
            await page.evaluate(() => {
                const button = document.querySelector('.audioflix-frontend-subhead [data-af-action="play-music-group"]');
                const rect = button?.getBoundingClientRect();
                return Boolean(button && rect?.width > 0 && rect?.height > 0);
            }),
            true,
            'Play Group should be visible after explicit Stop Group retires queue ownership'
        );
        await inputClick(page, context, '.audioflix-frontend-subhead [data-af-action="play-music-group"]:visible');
        const replay = await ready(0);
        return { stopped, settledObservation: settled.managed.observation, settledVolume: settled.volume,
            explicitPointerReplay: true, replayIndex: replay.queue.currentIndex };
    });
    await record('file-reload-stop-reset-sustained-idle', async () => {
        await page.goto(controllerUrl, { waitUntil: 'load', timeout: 120000 });
        await page.waitForFunction(() => window.EveAudioflix?.ready && window.EveAudioflixSpotifyAnyBrowser?.ready
            && window.EveAudioflixSpotifyRemote?.ready, null, { timeout: 120000 });
        await H.waitForControllerHydration(page); await barrier.proveBlocked(page);
        await until(async () => idle(await helper()), 20000);
        const connection = await page.evaluate(async () => {
            const r = await window.EveAudioflixSpotifyRemote.connect();
            return { connected: r.connected, approvalRequired: r.approvalRequired };
        });
        assert.deepEqual(connection, { connected: true, approvalRequired: false }, 'Reload should preserve the approved disposable file session');
        return idleWindow(5000, true);
    });
    E.finalState = await state(); await cleanup(); E.ok = true;
})().catch(async error => {
    E.failure = { phase: E.phase, message: redact(error.message), stack: error.stack?.split('\n').slice(0, 8).map(redact) };
    if (page) {
        E.failureState = await state().catch(() => null);
        await page.screenshot({ path: path.join(OUT, 'lane3-file-failure.png') }).catch(() => {});
    }
    process.exitCode = 1;
}).finally(async () => {
    if (browser || ownedEngine) await cleanup().catch(error => {
        E.cleanupError = redact(error.message); E.ok = false; process.exitCode = 1;
    });
    E.finishedAt = new Date().toISOString(); write();
    if (!E.ok) console.error(`LANE3_FILE_ACCEPTANCE_FAIL ${E.failure?.phase || E.phase}: ${E.failure?.message || E.cleanupError || 'incomplete'} evidence=${resultPath}`);
    else console.log(`LANE3_FILE_ACCEPTANCE_OK cases=${E.cases.length} evidence=${resultPath}`);
});
