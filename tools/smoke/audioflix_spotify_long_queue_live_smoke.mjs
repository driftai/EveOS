#!/usr/bin/env node

import process from 'node:process';
import { chromium } from 'playwright';
import { normalizeSpotify, createLongQueueHarness } from './audioflix_spotify_long_queue_live_support.mjs';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (name, fallback = '') => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const base = value('--base', 'http://127.0.0.1:8765').replace(/\/$/, '');
const controllerUrl = value('--controller', value('--page', `${base}/EveOS.html`));
const engineUrl = value('--engine', `${base}/audioflix-spotify-engine.html`);
const count = Math.max(8, Math.min(40, Number(value('--count', '20')) || 20));
const tailSeconds = Math.max(1.25, Math.min(8, Number(value('--tail-seconds', '2.5')) || 2.5));
const transitionTimeout = Math.max(8000, Math.min(60000, Number(value('--transition-timeout', '25000')) || 25000));
const headless = has('--headless');
const allowVisible = has('--allow-visible-controller');
const shouldStart = has('--start');
const takeOver = has('--take-over');
const nonce = Date.now().toString(36);
const groupName = `EveOS Live Queue ${nonce}`;
const fixturePrefix = `live-queue-${nonce}-`;

const supplied = String(value('--tracks', process.env.EVE_AUDIOFLIX_SPOTIFY_LIVE_TRACKS || '') || '')
    .split(/[;,\n]+/).map(normalizeSpotify).filter(Boolean);
const single = normalizeSpotify(value('--track', process.env.EVE_AUDIOFLIX_SPOTIFY_LIVE_TRACK || ''));
if (!supplied.length && single) supplied.push(single);

const H = createLongQueueHarness({
    base, controllerUrl, engineUrl, groupName, fixturePrefix,
    transitionTimeout, tailSeconds, shouldStart, takeOver
});
H.validateUrls();

async function main() {
    const engine = await H.ensureManagedEngine();
    console.log('LIVE_QUEUE_ENGINE_READY', JSON.stringify({
        pageUrl: engine.status.pageUrl,
        authState: engine.status.authState,
        browserChannel: engine.status.browserChannel,
        startedBySmoke: engine.startedBySmoke
    }));

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    let foreground = null;
    let originalState = null;
    let fixtureInstalled = false;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));

    try {
        await page.goto(controllerUrl, { waitUntil: 'load', timeout: 180000 });
        await page.waitForFunction(() => window.EveAudioflix?.ready
            && window.EveAudioflixState?.ready
            && window.EveAudioflixSpotifyAnyBrowser?.ready
            && window.EveAudioflixDiagnostics?.ready, undefined, { timeout: 120000 });

        const preflight = await H.queueSnapshot(page);
        H.assert(!preflight.queue?.isPlaying,
            `Disposable controller already has a live queue (${preflight.queue?.groupName || 'unknown'}). Stop it before running this proof.`);

        let sourceTracks = [...supplied];
        if (!sourceTracks.length) {
            sourceTracks = await page.evaluate(() => (window.EveAudioflixState?.ensure?.().music || [])
                .map((item) => String(item.spotifyUrl || item.url || item.originalUrl || ''))
                .filter((url) => /(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)[A-Za-z0-9]{22}/i.test(url))
                .slice(0, 8));
            sourceTracks = sourceTracks.map(normalizeSpotify).filter(Boolean);
        }
        if (!sourceTracks.length) {
            throw new Error('No Spotify-linked track exists in this EveOS controller state. Pass --track=<Spotify URL/ID> or --tracks=<a;b;c>.');
        }
        const urls = Array.from({ length: count }, (_, index) => sourceTracks[index % sourceTracks.length]);

        originalState = await page.evaluate(() => JSON.parse(JSON.stringify(window.EveAudioflixState.ensure())));
        await page.evaluate(() => {
            window.__eveLongQueueOriginalSaveConfig = window.saveConfig;
            window.saveConfig = async () => true;
        });

        const expectedIds = await page.evaluate(({ tracks, group, prefix }) => {
            const S = window.EveAudioflixState;
            S.addMusicGroup(group);
            const ids = [];
            tracks.forEach((url, index) => {
                const wantedId = `${prefix}${index}`;
                const added = S.addItem('music', {
                    id: wantedId,
                    title: `Live Queue ${String(index + 1).padStart(2, '0')}`,
                    url,
                    spotifyUrl: url,
                    sourceProvider: 'spotify',
                    type: 'music',
                    volume: 0.05
                });
                ids.push(added.id);
                S.toggleMusicGroup(added.id, group, true);
            });
            S.update({
                musicViewMode: 'frontend',
                activeFrontendMusicGroup: group,
                activeFrontendMusicArtist: '',
                activeFrontendMusicClassifier: '',
                activeMusicFolderScope: ''
            }, 'audioflix-live-long-queue-fixture');
            return ids;
        }, { tracks: urls, group: groupName, prefix: fixturePrefix });
        fixtureInstalled = true;

        H.assert(expectedIds.length === count, `fixture created ${expectedIds.length} tracks; expected ${count}`);
        H.assert(expectedIds.every((id) => String(id).startsWith(fixturePrefix)),
            `fixture ids were rewritten unexpectedly: ${JSON.stringify(expectedIds)}`);

        await page.click('.topbar-audioflix-btn');
        await page.waitForSelector('#audioflix-overlay:not([hidden]) .audioflix-panel', { timeout: 15000 });
        await page.click('[data-af-action="tab"][data-af-tab="music"]');
        await page.waitForFunction((group) => {
            const root = document.querySelector('.audioflix-item-grid[data-af-active-group]');
            return root?.dataset.afActiveGroup === group;
        }, groupName, { timeout: 15000 });
        const playButtons = page.locator('#audioflix-overlay:not([hidden]) [data-af-action="play-music-group"]:visible');
        H.assert(await playButtons.count() === 1,
            `Expected exactly one visible Play Group button for fixture "${groupName}", found ${await playButtons.count()}.`);
        await playButtons.first().click();

        const authoritative = await H.waitForFixtureQueue(page, expectedIds);
        H.assertFixtureQueue(authoritative, expectedIds, 0);
        const ownership = await H.waitForOwnership(page, expectedIds);
        const ownerEpoch = Number(ownership.ownerEpoch || 0);
        H.assert(ownerEpoch > 0, 'Spotify owner epoch was not established.');
        await H.waitForTrackReady(page, 0, expectedIds, ownerEpoch);
        await H.waitForManagedPlayback();

        const transitions = [];
        let hiddenObserved = false;
        const backgroundAt = Math.max(2, Math.floor(count / 4));

        for (let index = 0; index < count; index += 1) {
            const track = await H.waitForTrackReady(page, index, expectedIds, ownerEpoch);

            if (!foreground && index === backgroundAt) {
                foreground = await context.newPage();
                await foreground.setContent('<title>EveOS long queue foreground guard</title><p>Controller intentionally backgrounded.</p>');
                await foreground.bringToFront();
                try {
                    await H.pollNode(async () => {
                        const visibility = await page.evaluate(() => document.visibilityState);
                        return { ok: visibility === 'hidden', value: visibility, reason: `controller visibility remained ${visibility}` };
                    }, 5000, 100);
                    hiddenObserved = true;
                } catch {
                    if (!allowVisible) {
                        throw new Error('Controller tab did not become hidden. Re-run headed, or pass --allow-visible-controller for environments without real tab visibility.');
                    }
                }
            }

            const startedAt = Date.now();
            await page.evaluate(async ({ duration, tail }) => {
                await window.EveAudioflixAudio.seek(Math.max(0, duration - tail));
            }, { duration: track.duration, tail: tailSeconds });
            const landed = await H.waitForSeekLanding(page, index, expectedIds, ownerEpoch, track.duration);

            if (index < count - 1) {
                if (!landed.advanced) {
                    await H.pollNode(async () => {
                        const snapshot = await H.queueSnapshot(page);
                        // Fixture identity is invariant and must fail fast, but currentIndex is the
                        // condition we are waiting to change. Do not assert the successor index on
                        // the first poll while the just-ended track is still completing.
                        H.assertFixtureQueue(snapshot, expectedIds);
                        const currentOwnership = snapshot.managed?.ownership;
                        H.assert(currentOwnership?.isOwner === true && Number(currentOwnership.ownerEpoch || 0) === ownerEpoch,
                            `Spotify ownership changed during transition ${index} -> ${index + 1}`);
                        const ok = snapshot.queue?.isPlaying === true && snapshot.queue.currentIndex === index + 1;
                        return { ok, value: snapshot, reason: `queue did not advance from ${index} to ${index + 1}; last=${JSON.stringify(snapshot)}` };
                    });
                }
                await H.sleep(250);
                const after = await H.queueSnapshot(page);
                H.assertFixtureQueue(after, expectedIds, index + 1);
            } else {
                await H.pollNode(async () => {
                    const snapshot = await H.queueSnapshot(page);
                    H.assertFixtureQueue(snapshot, expectedIds, count - 1);
                    return { ok: snapshot.queue?.isPlaying === false, value: snapshot, reason: `final queue item never completed; last=${JSON.stringify(snapshot)}` };
                });
            }

            const elapsedMs = Date.now() - startedAt;
            transitions.push({ from: index, to: index < count - 1 ? index + 1 : 'complete', elapsedMs, hidden: hiddenObserved });
            console.log(`LIVE_QUEUE_STEP ${index + 1}/${count} -> ${index < count - 1 ? index + 2 : 'complete'} ${elapsedMs}ms${hiddenObserved ? ' [controller hidden]' : ''}`);
        }

        const result = await page.evaluate(() => ({
            queue: window.EveAudioflix.queueConnection.snapshot(),
            diagnostics: window.EveAudioflixDiagnostics.snapshot(),
            managed: window.EveAudioflixSpotifyAnyBrowser.snapshot()
        }));
        H.assertFixtureQueue({ queue: result.queue }, expectedIds, count - 1);
        H.assert(result.queue.isPlaying === false, 'long queue did not finish coherently');
        H.assert((result.diagnostics.summary['queue:between-songs']?.count || 0) >= count - 1,
            'diagnostics did not observe every between-song handoff');
        H.assert((result.diagnostics.summary['spotify:status-watch']?.count || 0) >= count,
            'status-watch did not remain active across the long queue');
        if (!allowVisible && !headless) H.assert(hiddenObserved, 'headed proof never observed a hidden controller tab');
        H.assert(pageErrors.length === 0, `controller page emitted errors: ${pageErrors.join(' | ')}`);

        const sorted = [...transitions].sort((a, b) => a.elapsedMs - b.elapsedMs);
        console.log(JSON.stringify({
            ok: true,
            tracks: count,
            sourceTrackCount: sourceTracks.length,
            controllerUrl,
            engineUrl,
            ownerEpoch,
            hiddenControllerProved: hiddenObserved,
            maxTransitionMs: Math.max(...transitions.map((entry) => entry.elapsedMs)),
            p50TransitionMs: sorted[Math.floor(sorted.length / 2)].elapsedMs,
            diagnostics: result.diagnostics.summary
        }, null, 2));
        console.log(`AUDIOFLIX_SPOTIFY_LONG_QUEUE_LIVE_OK ${count}/${count}`);
    } finally {
        try {
            await page.evaluate(() => window.EveAudioflixAudio?.stopAll?.());
            if (fixtureInstalled && originalState) {
                await page.evaluate((state) => {
                    const originalSave = window.__eveLongQueueOriginalSaveConfig;
                    window.EveAudioflixState?.replaceState?.(state, 'audioflix-live-long-queue-cleanup');
                    if (originalSave) window.saveConfig = originalSave;
                    delete window.__eveLongQueueOriginalSaveConfig;
                }, originalState);
            }
        } catch {}
        if (engine.startedBySmoke) {
            await H.jsonRequest('/api/audioflix/spotify-browser/stop', 'POST', {}).catch(() => {});
        }
        await browser.close().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
});
