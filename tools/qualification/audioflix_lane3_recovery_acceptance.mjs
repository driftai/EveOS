#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createLongQueueHarness, normalizeSpotify, spotifyTrackId } from '../smoke/audioflix_spotify_long_queue_live_support.mjs';
import { installBackendWriteBarrier, readBackendAudioflixSnapshot, assertBackendAudioflixUnchanged } from '../smoke/audioflix_spotify_live_isolation.shared.js';

const ROOT = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..'));
const ports = JSON.parse(fs.readFileSync(path.join(ROOT, 'config/eveos-ports.json'), 'utf8'));
const port = Number(ports?.ports?.EVEOS_WEB_PORT?.port);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Registered EVEOS_WEB_PORT required');
const base = `http://127.0.0.1:${port}`;
const controllerUrl = `${base}/EveOS.html`, engineUrl = `${base}/audioflix-spotify-engine.html`;
const suffix = randomUUID(), groupName = `Lane3 recovery ${suffix}`, fixturePrefix = `lane3-recovery-${suffix}-`;
const H = createLongQueueHarness({ base, controllerUrl, engineUrl, groupName, fixturePrefix,
    transitionTimeout: 60000, tailSeconds: 3, shouldStart: true, takeOver: process.argv.includes('--take-over') });
const rawBackend = async () => {
    const response = await fetch(`${base}/api/eve-state/modular/load`, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
    if (!response.ok) throw new Error(`Canonical backend state read failed: HTTP ${response.status}`);
    return response.json();
};
const backend = () => readBackendAudioflixSnapshot(rawBackend);
const counters = ['watchJobs', 'watchRequests', 'progressRequests', 'retryTimers', 'progressTimers', 'recoveryRequests', 'recoveryTimers'];
const assertCounters = (observation, settled = false) => {
    H.assert(observation && typeof observation === 'object', 'Observer diagnostics required');
    for (const key of counters) {
        H.assert(Number.isInteger(observation[key]) && observation[key] >= 0 && observation[key] <= 1, `${key} must stay bounded`);
        if (settled) H.assert(observation[key] === 0, `${key} must settle after helper reset`);
    }
};

const before = await backend();
const raw = await rawBackend();
const audioflix = raw?.state?.audioflix ?? raw?.state?.bookmarks?.config?.audioflix ?? null;
const seen = new Set();
const sources = (audioflix?.music || []).map(item => normalizeSpotify(item?.spotifyUrl || item?.url || item?.originalUrl || ''))
    .filter(url => { const id = spotifyTrackId(url); if (!id || seen.has(id)) return false; seen.add(id); return true; }).slice(0, 2);
H.assert(sources.length === 2, 'Two existing real Spotify-linked backend sources required');
const expectedIds = sources.map((_, index) => `${fixturePrefix}${index}`);
const managedPreflight = await H.ensureManagedEngine();
H.assert(managedPreflight.status.authState === 'signed-in', 'Managed Spotify helper must already be signed in');
const browser = await chromium.launch({ headless: !process.argv.includes('--headed') });
const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: 'block' });
const barrier = await installBackendWriteBarrier(context, [base, engineUrl, controllerUrl]);
const page = await context.newPage();
try {
    await page.goto(controllerUrl, { waitUntil: 'load', timeout: 120000 });
    await page.waitForFunction(() => window.EveAudioflix?.ready && window.EveAudioflixSpotifyAnyBrowser?.ready, null, { timeout: 120000 });
    await H.waitForControllerHydration(page); await barrier.proveBlocked(page);
    await page.evaluate(({ tracks, group, prefix }) => {
        const S = window.EveAudioflixState; S.addMusicGroup(group);
        tracks.forEach((url, index) => { const item = S.addItem('music', { id: `${prefix}${index}`, title: `Recovery ${index + 1}`,
            url, spotifyUrl: url, sourceProvider: 'spotify', type: 'music', volume: 0.05 }); S.toggleMusicGroup(item.id, group, true); });
        S.update({ musicViewMode: 'frontend', activeFrontendMusicGroup: group, activeFrontendMusicArtist: '',
            activeFrontendMusicClassifier: '', activeMusicFolderScope: '' }, 'lane3-recovery-fixture');
    }, { tracks: sources, group: groupName, prefix: fixturePrefix });
    await page.click('.topbar-audioflix-btn');
    await page.waitForSelector('#audioflix-overlay:not([hidden]) .audioflix-panel', { timeout: 15000 });
    await page.click('[data-af-action="tab"][data-af-tab="music"]');
    await page.waitForFunction(group => document.querySelector('.audioflix-item-grid[data-af-active-group]')?.dataset.afActiveGroup === group, groupName);
    await page.locator('.audioflix-frontend-subhead [data-af-action="play-music-group"]:visible').click();
    await H.waitForFixtureQueue(page, expectedIds); const owner = await H.waitForOwnership(page, expectedIds);
    await H.waitForTrackReady(page, 0, expectedIds, owner.ownerEpoch, spotifyTrackId(sources[0]));
    await H.waitForManagedPlayback(spotifyTrackId(sources[0]));
    const old = await page.evaluate(() => window.EveAudioflixSpotifyAnyBrowser.snapshot());
    await H.jsonRequest('/api/audioflix/spotify-browser/stop', 'POST', {});
    const degraded = await H.pollNode(async () => { const m = await page.evaluate(() => window.EveAudioflixSpotifyAnyBrowser.snapshot());
        return { ok: m.observation?.state === 'degraded', value: m, reason: `observer not degraded: ${JSON.stringify(m.observation)}` }; }, 20000, 200);
    assertCounters(degraded.observation); H.assert(degraded.observation.recoveryTimers === 1, 'Exactly one degraded recovery sentinel required');
    const restarted = await H.ensureManagedEngine(); H.assert(restarted.status.playingCount === 0, 'Helper restart must not autoplay');
    const retired = await H.pollNode(async () => { const m = await page.evaluate(() => window.EveAudioflixSpotifyAnyBrowser.snapshot());
        return { ok: m.active === false, value: m, reason: 'stale managed playback was not retired after helper reset' }; }, 20000, 200);
    assertCounters(retired.observation || {}, true);
    const idleUntil = Date.now() + 5000; while (Date.now() < idleUntil) { const status = await H.jsonRequest('/api/audioflix/spotify-browser/status');
        H.assert(Number(status.playingCount || 0) === 0, 'No delayed autoplay allowed after helper restart'); await H.sleep(250); }
    await page.locator('.audioflix-frontend-subhead [data-af-action="play-music-group"]:visible').click();
    await H.waitForFixtureQueue(page, expectedIds); const recovered = await H.waitForOwnership(page, expectedIds);
    H.assert(Number(recovered.engineEpoch || 0) > Number(old.relay?.lastState?.engineEpoch || 0), 'Manual replay must bind the new helper epoch');
    const after = await backend(); assertBackendAudioflixUnchanged(before, after);
    console.log('LANE3_RECOVERY_ACCEPTANCE_OK degraded=bounded autoplay=none stale=retired replay=manual');
} finally {
    await page.evaluate(() => window.EveAudioflixSpotifyRemote?.disconnect?.()).catch(() => {});
    await H.disposeControllerProbe(page).catch(() => {}); await browser.close();
}
