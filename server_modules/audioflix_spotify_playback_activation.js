'use strict';

const { URL } = require('node:url');
const { engineSnapshot, engineCommand } = require('./audioflix_spotify_browser_transport.js');

const PLAY_WAKE_INITIAL_MS = 900;
const PLAY_WAKE_SETTLE_MS = 3200;

function headlessRequestedFromPageUrl(value) {
    try { return new URL(String(value || '')).searchParams.get('playwright') === 'headless'; }
    catch { return false; }
}

function isLikelyPlayControl(value) {
    const label = String(value || '').trim().toLowerCase();
    return /^play(?:\b|$)/.test(label) && !/\bspotify\b/.test(label);
}

async function playbackObservation(page, spotifySnapshots) {
    let transport = null;
    try { transport = await engineSnapshot(page); } catch {}
    const snapshots = await spotifySnapshots(null, '');
    const playingCount = snapshots.reduce((sum, item) => sum + Number(item.playingCount || 0), 0);
    return {
        playing: transport?.status === 'playing' || playingCount > 0,
        transport: transport || {},
        playingCount
    };
}

async function waitForPlaying(page, spotifySnapshots, timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
    let observed = await playbackObservation(page, spotifySnapshots);
    while (!observed.playing && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 120));
        observed = await playbackObservation(page, spotifySnapshots);
    }
    return observed;
}

async function activateSpotifyPlayback(page, isSpotifyEmbedUrl, note, runtime) {
    if (!page || page.isClosed()) return { clicked: false, reason: 'engine page closed' };
    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url())) continue;
        const candidates = frame.locator('button,[role="button"]');
        let count = 0;
        try { count = Math.min(await candidates.count(), 48); } catch { continue; }
        for (let index = 0; index < count; index += 1) {
            const candidate = candidates.nth(index);
            try {
                if (!await candidate.isVisible()) continue;
                const aria = String(await candidate.getAttribute('aria-label') || '').trim();
                const title = String(await candidate.getAttribute('title') || '').trim();
                const text = String(await candidate.innerText().catch(() => '') || '').trim();
                const testId = String(await candidate.getAttribute('data-testid') || '').trim();
                const label = [aria, title, text].filter(Boolean).join(' ').trim();
                const isPlayPause = testId === 'play-pause-button' && !/\bpause\b/i.test(label);
                if (!isPlayPause && !isLikelyPlayControl(label)) continue;
                await candidate.click({ timeout: 1800 });
                runtime.playbackKickCount += 1;
                runtime.lastPlaybackKickAt = Date.now();
                note('playback-kick', label || testId || 'Spotify play control');
                return { clicked: true, label: label || testId || 'play control' };
            } catch (error) {
                note('playback-kick-candidate', error.message);
            }
        }
    }
    note('playback-kick-miss', 'No visible Spotify Play control was found.');
    return { clicked: false, reason: 'No visible Spotify Play control was found.' };
}

async function handleTransportWithActivation(options, body) {
    const {
        page, spotifySnapshots, isSpotifyEmbedUrl, normalizeTrackId, note, runtime
    } = options;
    const action = String(body?.action || '').trim().toLowerCase();
    const result = await engineCommand(page, body);
    if (!result?.ok || !['play', 'resume'].includes(action)) return result;

    let observed = await waitForPlaying(page, spotifySnapshots, PLAY_WAKE_INITIAL_MS);
    let activationMethod = 'controller';
    if (!observed.playing) {
        const kicked = await activateSpotifyPlayback(page, isSpotifyEmbedUrl, note, runtime);
        activationMethod = kicked.clicked ? 'playwright-click' : 'controller-pending';
        observed = await waitForPlaying(page, spotifySnapshots, PLAY_WAKE_SETTLE_MS);
    }
    if (!observed.playing) {
        const message = 'Spotify loaded but did not begin playback. The managed engine could not establish a playable user activation.';
        runtime.lastError = message;
        runtime.state = observed.transport?.status || 'starting';
        note('playback-start-failed', `${runtime.state}; ${activationMethod}`);
        return {
            ok: false, action, reason: message, state: observed.transport || result.state || {},
            playbackActivated: false, activationMethod
        };
    }

    runtime.lastError = '';
    runtime.state = 'controlling';
    const trackId = normalizeTrackId(body?.spotifyId || body?.trackId || body?.url || body?.uri || '');
    if (Number.isFinite(Number(runtime.desiredVolume))) {
        await spotifySnapshots(runtime.desiredVolume, trackId);
    }
    let finalState = observed.transport || result.state || {};
    try { finalState = await engineSnapshot(page); } catch {}
    return { ...result, state: finalState, playbackActivated: true, activationMethod };
}

module.exports = {
    headlessRequestedFromPageUrl,
    isLikelyPlayControl,
    handleTransportWithActivation
};
