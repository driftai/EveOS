#!/usr/bin/env node

import process from 'node:process';
import { chromium } from 'playwright';

const argv = process.argv.slice(2);
const has = (flag) => argv.includes(flag);
const value = (name, fallback = '') => argv.find((arg) => arg.startsWith(`${name}=`))?.slice(name.length + 1) ?? fallback;
const base = value('--base', 'http://127.0.0.1:8765').replace(/\/$/, '');
const pageUrl = value('--page', `${base}/EveOS.html`);
const count = Math.max(8, Math.min(40, Number(value('--count', '20')) || 20));
const tailSeconds = Math.max(1.25, Math.min(8, Number(value('--tail-seconds', '2.5')) || 2.5));
const transitionTimeout = Math.max(8000, Math.min(60000, Number(value('--transition-timeout', '25000')) || 25000));
const headless = has('--headless');
const allowVisible = has('--allow-visible-controller');
const shouldStart = has('--start');
const groupName = `EveOS Live Queue ${Date.now().toString(36)}`;

function normalizeSpotify(value) {
    const raw = String(value || '').trim();
    if (/^[A-Za-z0-9]{22}$/.test(raw)) return `https://open.spotify.com/track/${raw}`;
    const id = raw.match(/(?:spotify:track:|open\.spotify\.com\/(?:embed\/)?track\/)([A-Za-z0-9]{22})/i)?.[1];
    if (id) return `https://open.spotify.com/track/${id}`;
    return '';
}

const supplied = String(value('--tracks', process.env.EVE_AUDIOFLIX_SPOTIFY_LIVE_TRACKS || '') || '')
    .split(/[;,\n]+/).map(normalizeSpotify).filter(Boolean);
const single = normalizeSpotify(value('--track', process.env.EVE_AUDIOFLIX_SPOTIFY_LIVE_TRACK || ''));
if (!supplied.length && single) supplied.push(single);
if (!supplied.length) {
    console.error('Provide --track=<Spotify track URL/ID>, --tracks=<a;b;c>, or EVE_AUDIOFLIX_SPOTIFY_LIVE_TRACK.');
    process.exit(2);
}
const urls = Array.from({ length: count }, (_, index) => supplied[index % supplied.length]);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function jsonRequest(path, method = 'GET', body = null) {
    const response = await fetch(`${base}${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json; charset=utf-8' } : undefined,
        body: body ? JSON.stringify(body) : undefined
    });
    let payload = {};
    try { payload = await response.json(); } catch {}
    if (!response.ok) throw new Error(payload.reason || payload.message || `HTTP ${response.status}`);
    return payload;
}

function assert(condition, message) {
    if (!condition) throw new Error(`ASSERT FAILED: ${message}`);
}

async function waitForTrackReady(page, index) {
    await page.waitForFunction((wanted) => {
        const q = window.EveAudioflix?.queueConnection?.snapshot?.();
        const managed = window.EveAudioflixSpotifyAnyBrowser?.snapshot?.();
        return q?.isPlaying === true && q.currentIndex === wanted
            && managed?.active === true && managed.playback?.paused === false
            && Number(managed.playback?.duration || 0) > 5;
    }, index, { timeout: transitionTimeout });
    return page.evaluate(() => {
        const q = window.EveAudioflix.queueConnection.snapshot();
        const managed = window.EveAudioflixSpotifyAnyBrowser.snapshot();
        return {
            currentIndex: q.currentIndex,
            itemId: q.entries?.[q.currentIndex]?.id || '',
            title: q.entries?.[q.currentIndex]?.title || '',
            duration: Number(managed.playback?.duration || 0),
            currentTime: Number(managed.playback?.currentTime || 0)
        };
    });
}

async function main() {
    if (shouldStart) {
        const started = await jsonRequest('/api/audioflix/spotify-browser/start', 'POST', { pageUrl });
        assert(started.ok, started.reason || 'managed Spotify browser did not start');
    }

    const browser = await chromium.launch({ headless });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    let foreground = null;
    const pageErrors = [];
    page.on('pageerror', (error) => pageErrors.push(String(error?.message || error)));

    try {
        await page.goto(pageUrl, { waitUntil: 'load', timeout: 180000 });
        await page.waitForFunction(() => window.EveAudioflix?.ready
            && window.EveAudioflixState?.ready
            && window.EveAudioflixSpotifyAnyBrowser?.ready
            && window.EveAudioflixDiagnostics?.ready, undefined, { timeout: 120000 });

        // This is a disposable Playwright controller context. Keep the fixture in-memory so the
        // live proof cannot persist its temporary tracks into the user's normal EveOS library.
        await page.evaluate(() => {
            window.__eveLongQueueOriginalSaveConfig = window.saveConfig;
            window.saveConfig = async () => true;
        });

        await page.evaluate(({ tracks, group }) => {
            const S = window.EveAudioflixState;
            S.addMusicGroup(group);
            tracks.forEach((url, index) => {
                const added = S.addItem('music', {
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
        }, { tracks: urls, group: groupName });

        await page.click('.topbar-audioflix-btn');
        await page.waitForSelector('#audioflix-overlay:not([hidden]) .audioflix-panel', { timeout: 15000 });
        await page.click('[data-af-action="tab"][data-af-tab="music"]');
        await page.waitForSelector('[data-af-action="play-music-group"]', { timeout: 15000 });
        await page.click('[data-af-action="play-music-group"]');

        await waitForTrackReady(page, 0);
        const managedStatus = await jsonRequest('/api/audioflix/spotify-browser/status');
        assert(managedStatus.ok && managedStatus.helperReachable && managedStatus.sessionPresent,
            'managed browser/helper/session are not healthy during live queue playback');
        assert(Number(managedStatus.playingCount || 0) >= 1,
            'managed Spotify browser has no playing media element after queue start');

        const transitions = [];
        let hiddenObserved = false;
        const backgroundAt = Math.max(2, Math.floor(count / 4));

        for (let index = 0; index < count; index += 1) {
            const track = await waitForTrackReady(page, index);

            if (!foreground && index === backgroundAt) {
                foreground = await context.newPage();
                await foreground.setContent('<title>EveOS long queue foreground guard</title><p>Controller intentionally backgrounded.</p>');
                await foreground.bringToFront();
                try {
                    await page.waitForFunction(() => document.visibilityState === 'hidden', undefined, { timeout: 5000 });
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

            if (index < count - 1) {
                await page.waitForFunction((next) => {
                    const q = window.EveAudioflix?.queueConnection?.snapshot?.();
                    return q?.isPlaying === true && q.currentIndex === next;
                }, index + 1, { timeout: transitionTimeout });
                // A duplicate/stale completion must not skip the immediate successor.
                await sleep(250);
                const current = await page.evaluate(() => window.EveAudioflix.queueConnection.snapshot().currentIndex);
                assert(current === index + 1, `completion ${index + 1} skipped past queue index ${index + 1} to ${current}`);
            } else {
                await page.waitForFunction(() => window.EveAudioflix?.queueConnection?.snapshot?.().isPlaying === false,
                    undefined, { timeout: transitionTimeout });
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
        assert(result.queue.isPlaying === false, 'long queue did not finish coherently');
        assert(result.queue.currentIndex === count - 1, `final queue index is ${result.queue.currentIndex}, expected ${count - 1}`);
        assert((result.diagnostics.summary['queue:between-songs']?.count || 0) >= count - 1,
            'diagnostics did not observe every between-song handoff');
        assert((result.diagnostics.summary['spotify:status-watch']?.count || 0) >= count,
            'status-watch did not remain active across the long queue');
        if (!allowVisible && !headless) assert(hiddenObserved, 'headed proof never observed a hidden controller tab');
        assert(pageErrors.length === 0, `controller page emitted errors: ${pageErrors.join(' | ')}`);

        console.log(JSON.stringify({
            ok: true,
            tracks: count,
            hiddenControllerProved: hiddenObserved,
            maxTransitionMs: Math.max(...transitions.map((entry) => entry.elapsedMs)),
            p50TransitionMs: [...transitions].sort((a, b) => a.elapsedMs - b.elapsedMs)[Math.floor(transitions.length / 2)].elapsedMs,
            diagnostics: result.diagnostics.summary
        }, null, 2));
        console.log(`AUDIOFLIX_SPOTIFY_LONG_QUEUE_LIVE_OK ${count}/${count}`);
    } finally {
        try { await page.evaluate(() => window.EveAudioflixAudio?.stopAll?.()); } catch {}
        await browser.close().catch(() => {});
    }
}

main().catch((error) => {
    console.error(error?.stack || error);
    process.exit(1);
});
