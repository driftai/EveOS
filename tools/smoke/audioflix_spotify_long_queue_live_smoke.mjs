#!/usr/bin/env node

import process from 'node:process';
import { chromium } from 'playwright';
import { createLongQueueHarness, normalizeSpotify, spotifyTrackId } from './audioflix_spotify_long_queue_live_support.mjs';
import { validateBackendUrls, installBackendWriteBarrier, readBackendAudioflixSnapshot,
    assertBackendAudioflixUnchanged } from './audioflix_spotify_live_isolation.shared.js';

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
const groupName = `EveOS Live Queue ${Date.now().toString(36)}`;
const fixtureNonce = Date.now().toString(36);
const fixturePrefix = `live-queue-${fixtureNonce}-`;
const supplied = String(value('--tracks', process.env.EVE_AUDIOFLIX_SPOTIFY_LIVE_TRACKS || '') || '')
    .split(/[;,\n]+/).map(normalizeSpotify).filter(Boolean);
const single = normalizeSpotify(value('--track', process.env.EVE_AUDIOFLIX_SPOTIFY_LIVE_TRACK || ''));
if (!supplied.length && single) supplied.push(single);

const H = createLongQueueHarness({
    base, controllerUrl, engineUrl, groupName, fixturePrefix,
    transitionTimeout, tailSeconds, shouldStart, takeOver
});

async function main() {
    H.validateUrls();
    const backendUrls = [base, engineUrl];
    if (/^https?:$/.test(new URL(controllerUrl).protocol)) backendUrls.push(controllerUrl);
    validateBackendUrls(backendUrls);
    const readBackend = () => readBackendAudioflixSnapshot(async () => {
        const response = await fetch(`${base}/api/eve-state/modular/load`, { signal: AbortSignal.timeout(10000), cache: 'no-store' });
        if (!response.ok) throw new Error(`Backend Audioflix snapshot failed: HTTP ${response.status}`);
        return response.json();
    });
    const backendBefore = await readBackend();
    const managedPreflight = await H.ensureManagedEngine();
    console.log('LIVE_QUEUE_ENGINE_READY', JSON.stringify({
        pageUrl: managedPreflight.status.pageUrl,
        authState: managedPreflight.status.authState,
        browserChannel: managedPreflight.status.browserChannel,
        startedBySmoke: managedPreflight.startedBySmoke
    }));

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 }, serviceWorkers: 'block' });
    const isolation = await installBackendWriteBarrier(context, backendUrls);
    const page = await context.newPage();
    let foreground = null;
    let hiddenMethod = '';
    let completed = null;
    let isolationEvidence = null;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));
    // Surface silent queue skips: playQueueIndex logs "[Audioflix] Skipped <title>: <reason>" and
    // advances inside the same run, which otherwise only shows up as an index mismatch.
    const audioflixWarnings = [];
    page.on('console', (message) => {
        const text = message.text();
        if (!/\[Audioflix\]/.test(text) || !['warning', 'error', 'info'].includes(message.type())) return;
        const entry = { at: new Date().toISOString(), type: message.type(), text: text.slice(0, 400) };
        audioflixWarnings.push(entry);
        if (audioflixWarnings.length > 40) audioflixWarnings.shift();
        if (/Skipped /.test(text)) console.error('LIVE_QUEUE_SKIPPED_START', JSON.stringify(entry));
    });

    try {
        await page.goto(controllerUrl, { waitUntil: 'load', timeout: 180000 });
        await page.waitForFunction(() => window.EveAudioflix?.ready
            && window.EveAudioflixState?.ready
            && window.EveAudioflixSpotifyAnyBrowser?.ready
            && window.EveAudioflixDiagnostics?.ready, undefined, { timeout: 120000 });
        const hydration = await H.waitForControllerHydration(page);
        console.log('LIVE_QUEUE_CONTROLLER_STABLE', JSON.stringify(hydration));
        await isolation.proveBlocked(page);

        const initialQueue = await H.queueSnapshot(page);
        if (initialQueue.queue?.isPlaying) {
            throw new Error(
                `Disposable controller already has a live queue (${initialQueue.queue.groupName || 'unnamed'}). `
                + 'Close competing AudioFlix playback before running the live proof.'
            );
        }

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
        const expectedTrackIds = urls.map(spotifyTrackId);
        H.assert(expectedTrackIds.every(Boolean), `fixture contains an invalid Spotify track: ${JSON.stringify(urls)}`);
        const expectedIds = Array.from({ length: count }, (_, index) => `${fixturePrefix}${index}`);

        await page.evaluate(({ tracks, group, nonce }) => {
            const S = window.EveAudioflixState;
            S.addMusicGroup(group);
            tracks.forEach((url, index) => {
                const added = S.addItem('music', {
                    id: `live-queue-${nonce}-${index}`,
                    title: `Live Queue ${String(index + 1).padStart(2, '0')}`,
                    url,
                    spotifyUrl: url,
                    sourceProvider: 'spotify',
                    type: 'music',
                    volume: 0.05
                });
                S.toggleMusicGroup(added.id, group, true);
            });
            S.update({
                musicViewMode: 'frontend',
                activeFrontendMusicGroup: group,
                activeFrontendMusicArtist: '',
                activeFrontendMusicClassifier: '',
                activeMusicFolderScope: ''
            }, 'audioflix-live-long-queue-fixture');
        }, { tracks: urls, group: groupName, nonce: fixtureNonce });

        await page.click('.topbar-audioflix-btn');
        await page.waitForSelector('#audioflix-overlay:not([hidden]) .audioflix-panel', { timeout: 15000 });
        await page.click('[data-af-action="tab"][data-af-tab="music"]');
        await page.waitForFunction((group) => {
            const grid = document.querySelector('.audioflix-item-grid[data-af-active-group]');
            return grid?.dataset.afActiveGroup === group;
        }, groupName, { timeout: 15000 });
        const playGroup = page.locator('.audioflix-frontend-subhead [data-af-action="play-music-group"]:visible');
        const playCount = await playGroup.count();
        H.assert(playCount === 1,
            `expected exactly one Play Group button for temporary group "${groupName}", found ${playCount}`);
        await playGroup.click();

        await H.waitForFixtureQueue(page, expectedIds);
        const ownership = await H.waitForOwnership(page, expectedIds);
        const ownerEpoch = Number(ownership.ownerEpoch || 0);
        H.assert(ownerEpoch > 0, 'Spotify ownership epoch is unavailable after fixture start');
        await H.waitForTrackReady(page, 0, expectedIds, ownerEpoch, expectedTrackIds[0]);
        await H.waitForManagedPlayback(expectedTrackIds[0]);

        const transitions = [];
        let hiddenObserved = false;
        const backgroundAt = Math.max(2, Math.floor(count / 4));

        for (let index = 0; index < count; index += 1) {
            const track = await H.waitForTrackReady(page, index, expectedIds, ownerEpoch, expectedTrackIds[index]);

            if (!foreground && index === backgroundAt) {
                foreground = await context.newPage();
                await foreground.setContent('<title>EveOS long queue foreground guard</title><p>Controller intentionally backgrounded.</p>');
                await foreground.bringToFront();
                const waitHidden = (ms) => H.pollNode(async () => {
                    const visibility = await page.evaluate(() => document.visibilityState);
                    return { ok: visibility === 'hidden', value: visibility, reason: `controller visibility remained ${visibility}` };
                }, ms, 100);
                try {
                    try { await waitHidden(2000); hiddenMethod = 'background-tab'; }
                    catch {
                        // Playwright tabs can stay "visible" behind a sibling tab (focus emulation),
                        // so fall back to a real OS-level minimize of the controller window via CDP.
                        const cdp = await context.newCDPSession(page);
                        const { windowId } = await cdp.send('Browser.getWindowForTarget');
                        await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
                        await waitHidden(5000);
                        hiddenMethod = 'minimized-window';
                    }
                    hiddenObserved = true;
                    console.log('LIVE_QUEUE_CONTROLLER_HIDDEN', JSON.stringify({ method: hiddenMethod, atIndex: index }));
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
            const landed = await H.waitForSeekLanding(
                page, index, expectedIds, ownerEpoch, track.duration, expectedTrackIds[index]
            );

            if (index < count - 1) {
                if (!landed.advanced) {
                    await H.pollNode(async () => {
                        const snapshot = await H.queueSnapshot(page);
                        // Queue identity/order must stay exact while currentIndex is allowed to
                        // remain on the old track until the completion handoff actually lands.
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
        completed = {
            ok: true,
            tracks: count,
            sourceTrackCount: sourceTracks.length,
            controllerUrl,
            engineUrl,
            ownerEpoch,
            hiddenControllerProved: hiddenObserved,
            hiddenMethod,
            maxTransitionMs: Math.max(...transitions.map((entry) => entry.elapsedMs)),
            p50TransitionMs: sorted[Math.floor(sorted.length / 2)].elapsedMs,
            diagnostics: result.diagnostics.summary
        };
    } catch (error) {
        const helper = await H.jsonRequest('/api/audioflix/spotify-browser/status').catch(() => null);
        if (helper) console.error('LIVE_QUEUE_HELPER_DIAGNOSTICS', JSON.stringify({
            state: helper.state, playingCount: helper.playingCount, mediaCount: helper.mediaCount,
            diagnostics: helper.diagnostics, transport: helper.transport
        }));
        const diagnostics = await H.controllerDiagnostics(page).catch(() => null);
        if (diagnostics) console.error('LIVE_QUEUE_CONTROLLER_DIAGNOSTICS', JSON.stringify(diagnostics, null, 2));
        if (audioflixWarnings.length) console.error('LIVE_QUEUE_AUDIOFLIX_CONSOLE', JSON.stringify(audioflixWarnings, null, 2));
        throw error;
    } finally {
        await H.disposeControllerProbe(page).catch(() => {});
        try {
            await page.evaluate(async () => {
                const stopButton = document.querySelector('[data-af-action="stop-music-group"]');
                if (stopButton) {
                    stopButton.click();
                    await new Promise((resolve) => setTimeout(resolve, 200));
                }
                try { await window.EveAudioflixAudio?.stopAll?.(); } catch {}
            });
        } catch {}
        if (managedPreflight.startedBySmoke) {
            await H.jsonRequest('/api/audioflix/spotify-browser/stop', 'POST', {}).catch(() => {});
        }
        let closeError = null;
        await browser.close().catch((error) => { closeError = error; });
        const backendAfter = await readBackend();
        assertBackendAudioflixUnchanged(backendBefore, backendAfter);
        isolationEvidence = { before: backendBefore, after: backendAfter, ...isolation.summary() };
        if (closeError) throw closeError;
    }
    console.log(JSON.stringify({ ...completed, isolation: isolationEvidence }, null, 2));
    console.log(`AUDIOFLIX_SPOTIFY_LONG_QUEUE_LIVE_OK ${count}/${count} backend=unchanged blocked=${isolationEvidence.blockedCount}`);
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
});
