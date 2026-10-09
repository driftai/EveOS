'use strict';

const { URL } = require('node:url');
const { engineSnapshot, engineCommand } = require('./audioflix_spotify_browser_transport.js');

const PLAY_WAKE_INITIAL_MS = 900;
const PLAY_CONTROL_WAIT_MS = 3200;
const PLAY_WAKE_SETTLE_MS = 3200;
const MAX_CONTROL_DIAGNOSTICS = 20;

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

async function hoverSpotifySurface(frame, note) {
    try {
        const body = frame.locator('body');
        if (!await body.count()) return false;
        await body.hover({ timeout: 900 });
        await new Promise((resolve) => setTimeout(resolve, 90));
        note('playback-hover', frame.url());
        return true;
    } catch (error) {
        note('playback-hover-miss', error.message);
        return false;
    }
}

async function controlMeta(candidate, index) {
    const aria = String(await candidate.getAttribute('aria-label').catch(() => '') || '').trim();
    const title = String(await candidate.getAttribute('title').catch(() => '') || '').trim();
    const text = String(await candidate.innerText().catch(() => '') || '').trim();
    const testId = String(await candidate.getAttribute('data-testid').catch(() => '') || '').trim();
    const visible = Boolean(await candidate.isVisible().catch(() => false));
    const label = [aria, title, text].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    return { index, aria, title, text, testId, visible, label };
}

async function clickCandidate(candidate, meta, note, runtime) {
    const label = meta.label;
    const isPlayPause = meta.testId === 'play-pause-button' && !/\bpause\b/i.test(label);
    if (!isPlayPause && !(meta.visible && isLikelyPlayControl(label))) return { clicked: false };
    try {
        if (meta.visible) await candidate.click({ timeout: 1800 });
        else {
            try { await candidate.click({ timeout: 1800, force: true }); }
            catch { await candidate.dispatchEvent('click'); }
        }
        runtime.playbackKickCount += 1;
        runtime.lastPlaybackKickAt = Date.now();
        const method = meta.visible ? 'click' : 'forced-click';
        note('playback-kick', `${method}: ${label || meta.testId || 'Spotify play control'}`);
        return { clicked: true, label: label || meta.testId || 'play control', method };
    } catch (error) {
        note('playback-kick-candidate', `${meta.testId || meta.index}: ${error.message}`);
        return { clicked: false };
    }
}

async function clickSpotifyPlayControl(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime) {
    if (!page || page.isClosed()) return { clicked: false, reason: 'engine page closed' };
    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url())) continue;
        await hoverSpotifySurface(frame, note);
        const candidates = frame.locator('button,[role="button"]');
        let count = 0;
        try { count = Math.min(await candidates.count(), 48); } catch { continue; }
        for (let index = 0; index < count; index += 1) {
            const candidate = candidates.nth(index);
            const meta = await controlMeta(candidate, index);
            const isPlayPause = meta.testId === 'play-pause-button' && !/\bpause\b/i.test(meta.label);
            if (!isPlayPause && !(meta.visible && isLikelyPlayControl(meta.label))) continue;
            const observed = await playbackObservation(page, spotifySnapshots);
            if (observed.playing) {
                note('playback-kick-skip', 'Playback started before the Playwright click; leaving the provider control untouched.');
                return { clicked: false, alreadyPlaying: true, reason: 'playback already started' };
            }
            const result = await clickCandidate(candidate, meta, note, runtime);
            if (result.clicked) return result;
        }
    }
    return { clicked: false, reason: 'No Spotify Play control could be activated.' };
}

async function recordControlDiagnostics(page, isSpotifyEmbedUrl, note) {
    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url())) continue;
        const candidates = frame.locator('button,[role="button"]');
        let count = 0;
        try { count = Math.min(await candidates.count(), MAX_CONTROL_DIAGNOSTICS); }
        catch { count = 0; }
        const parts = [];
        for (let index = 0; index < count; index += 1) {
            const meta = await controlMeta(candidates.nth(index), index);
            const label = (meta.label || '-').slice(0, 42);
            parts.push(`${index}:${meta.testId || '-'}:${meta.visible ? 'v' : 'h'}:${label}`);
        }
        note('playback-controls', parts.length ? parts.join(' | ') : 'Spotify embed exposed no button controls.');
    }
}

async function activateSpotifyPlayback(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime) {
    const deadline = Date.now() + PLAY_CONTROL_WAIT_MS;
    let result = await clickSpotifyPlayControl(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime);
    while (!result.clicked && !result.alreadyPlaying && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 140));
        result = await clickSpotifyPlayControl(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime);
    }
    if (!result.clicked && !result.alreadyPlaying) {
        await recordControlDiagnostics(page, isSpotifyEmbedUrl, note);
        note('playback-kick-miss', result.reason);
    }
    return result;
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
        const kicked = await activateSpotifyPlayback(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime);
        activationMethod = kicked.alreadyPlaying ? 'controller-late' : (kicked.clicked ? `playwright-${kicked.method || 'click'}` : 'controller-pending');
        observed = kicked.alreadyPlaying
            ? await playbackObservation(page, spotifySnapshots)
            : await waitForPlaying(page, spotifySnapshots, PLAY_WAKE_SETTLE_MS);
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
