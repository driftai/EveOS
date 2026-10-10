'use strict';

const { URL } = require('node:url');
const { engineSnapshot, engineCommand } = require('./audioflix_spotify_browser_transport.js');
const { reactivateStartup } = require('./audioflix_spotify_startup_reactivation.js');
const { seekManagedMedia, handleManagedSeek } = require('./audioflix_spotify_media_seek.js');

const PLAY_WAKE_INITIAL_MS = 1400;
const PLAY_CONTROL_WAIT_MS = 3200;
// A slow Spotify embed can navigate several seconds after load. Keep rescanning for controls
// instead of turning an otherwise recoverable render delay into a queue skip.
const PLAY_CONTROL_RENDER_GRACE_MS = 5000;
const PLAY_WAKE_SETTLE_MS = 3200;
const PLAY_KICK_VERIFY_MS = 700;
// Live embeds can briefly start, then reset to paused/zero after more than 700ms.
const PLAY_CONFIRM_VERIFY_MS = 2200;
const PLAY_KICK_NEAR_START_MAX_S = 2;
const MAX_CONTROL_DIAGNOSTICS = 20;

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function headlessRequestedFromPageUrl(value) {
    try { return new URL(String(value || '')).searchParams.get('playwright') === 'headless'; }
    catch { return false; }
}

function isLikelyPlayControl(value) {
    const label = String(value || '').trim().toLowerCase();
    return /^play(?:\b|$)/.test(label) && !/\bspotify\b/.test(label);
}

async function providerPauseButtonShowsPlaying(page, isSpotifyEmbedUrl) {
    if (!page || page.isClosed()) return false;
    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url())) continue;
        const button = frame.locator('[data-testid="play-pause-button"]').first();
        try {
            if (!await button.count()) continue;
            const aria = String(await button.getAttribute('aria-label') || '').trim();
            const title = String(await button.getAttribute('title') || '').trim();
            if (/\bpause\b/i.test(`${aria} ${title}`)) return true;
        } catch {}
    }
    return false;
}

async function playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl) {
    let transport = null;
    try { transport = await engineSnapshot(page); } catch {}
    const snapshots = await spotifySnapshots(null, transport?.spotifyId || '');
    const mediaObserved = snapshots.some(item => Array.isArray(item.media));
    const playingCount = mediaObserved
        ? snapshots.flatMap(item => item.media || []).filter(media => !media.paused && !media.ended && media.readyState >= 2).length
        : snapshots.reduce((sum, item) => sum + Number(item.playingCount || 0), 0);
    const providerShowsPlaying = await providerPauseButtonShowsPlaying(page, isSpotifyEmbedUrl);
    return {
        playing: transport?.status === 'playing' || playingCount > 0 || providerShowsPlaying,
        transport: transport || {},
        playingCount, mediaObserved,
        providerShowsPlaying
    };
}

function isConfirmedPlaybackObservation(observed) {
    return Number(observed?.playingCount || 0) > 0
        || (observed?.mediaObserved !== true && String(observed?.transport?.status || '') === 'playing');
}

function confirmedForGeneration(observed, generation) {
    return isConfirmedPlaybackObservation(observed)
        && (!Number(generation) || Number(observed?.transport?.generation) === Number(generation));
}

async function waitForPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
    let observed = await playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl);
    while (!observed.playing && Date.now() < deadline) {
        await delay(120);
        observed = await playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl);
    }
    return observed;
}

async function waitForConfirmedPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, timeoutMs) {
    const deadline = Date.now() + Math.max(0, Number(timeoutMs || 0));
    let observed = await playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl);
    while (!isConfirmedPlaybackObservation(observed) && Date.now() < deadline) {
        await delay(120);
        observed = await playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl);
    }
    return observed;
}

async function confirmPlaybackObservation(observed, waitForConfirmed, note = () => {}) {
    if (!observed?.playing || isConfirmedPlaybackObservation(observed)) return observed;
    note('playback-confirm-pending', 'Spotify exposes Pause without engine/media playback; waiting for strong confirmation.');
    return waitForConfirmed();
}

function shouldRecoverLostConfirmation(observed, expectedGeneration = 0) {
    if (isConfirmedPlaybackObservation(observed)) return false;
    const transport = observed?.transport || {};
    const currentGeneration = Math.max(0, Number(transport.generation || 0));
    const wantedGeneration = Math.max(0, Number(expectedGeneration || 0));
    if (wantedGeneration && currentGeneration !== wantedGeneration) return false;
    const currentTime = Math.max(0, Number(transport.currentTime || 0));
    const pendingReplay = transport.status === 'starting' && transport.replayPending === true;
    return (String(transport.status || '') === 'provider-paused' || pendingReplay)
        && transport.playRequested !== false
        && transport.paused !== false
        && currentTime < PLAY_KICK_NEAR_START_MAX_S;
}

async function stabilizeConfirmedPlayback(options = {}) {
    let observed = options.observed;
    const confirmed = value => confirmedForGeneration(value, options.expectedGeneration);
    const observe = options.observe;
    const resume = options.resume;
    const waitForConfirmed = options.waitForConfirmed;
    const sleep = options.sleep || delay;
    const note = options.note || (() => {});
    const verifyMs = Math.max(0, Number(options.verifyMs ?? PLAY_CONFIRM_VERIFY_MS));
    if (!confirmed(observed)) {
        if (!shouldRecoverLostConfirmation(observed, options.expectedGeneration) || !options.reactivate) {
            return { observed, recovered: false, stable: false };
        }
        const activation = await options.reactivate();
        if (!activation?.clicked) return { observed, recovered: false, stable: false };
        observed = await waitForConfirmed();
        if (confirmed(observed)) {
            await sleep(verifyMs);
            observed = await observe();
        }
        return { observed, recovered: true, reactivated: true, stable: confirmed(observed) };
    }

    await sleep(verifyMs);
    observed = await observe();
    if (confirmed(observed)) return { observed, recovered: false, stable: true };

    const transport = observed?.transport || {};
    note('playback-confirm-lost', `${transport.status || 'unknown'} at ${Math.max(0, Number(transport.currentTime || 0)).toFixed(3)}s after strong confirmation.`);
    if (!shouldRecoverLostConfirmation(observed, options.expectedGeneration)) {
        return { observed, recovered: false, stable: false };
    }

    note('playback-confirm-recover', 'Reissuing one same-generation controller resume after startup playback relapsed.');
    const retry = await resume();
    if (!retry?.ok) return { observed, recovered: false, stable: false, retry };
    observed = await waitForConfirmed();
    if (confirmed(observed)) {
        await sleep(verifyMs);
        observed = await observe();
    }
    if (!confirmed(observed)) {
        const finalTransport = observed?.transport || {};
        note('playback-confirm-lost', `${finalTransport.status || 'unknown'} at ${Math.max(0, Number(finalTransport.currentTime || 0)).toFixed(3)}s after bounded resume recovery.`);
        if (shouldRecoverLostConfirmation(observed, options.expectedGeneration) && options.reactivate) {
            const activation = await options.reactivate();
            if (activation?.clicked) {
                observed = await waitForConfirmed();
                if (confirmed(observed)) {
                    await sleep(verifyMs);
                    observed = await observe();
                }
                return { observed, recovered: true, reactivated: true,
                    stable: confirmed(observed), retry };
            }
        }
    }
    return { observed, recovered: true, stable: confirmed(observed), retry };
}

async function hoverSpotifySurfaces(page, isSpotifyEmbedUrl, note) {
    if (!page || page.isClosed()) return;
    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url())) continue;
        try {
            const body = frame.locator('body');
            if (!await body.count()) continue;
            await body.hover({ timeout: 900 });
            note('playback-hover', frame.url());
        } catch (error) {
            note('playback-hover-miss', error.message);
        }
    }
    await delay(90);
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

async function forceClickCandidate(candidate) {
    try { await candidate.click({ timeout: 1800, force: true }); }
    catch { await candidate.dispatchEvent('click'); }
}

async function clickCandidate(candidate, meta, note, runtime, noteKind = 'playback-kick', options = {}) {
    const label = meta.label;
    const isPlayPause = meta.testId === 'play-pause-button' && !/\bpause\b/i.test(label);
    if (!isPlayPause && !(meta.visible && isLikelyPlayControl(label))) return { clicked: false };
    try {
        let forced = !meta.visible;
        if (meta.visible) {
            try { await candidate.click({ timeout: 1800 }); }
            catch (error) {
                // Only the already-authorized retoggle may force a visible-but-unstable Play control, once.
                if (options.forceOnVisibleTimeout !== true) throw error;
                note('playback-kick-candidate', `${meta.testId || meta.index}: ${error.message}`);
                await forceClickCandidate(candidate);
                forced = true;
            }
        } else await forceClickCandidate(candidate);
        runtime.playbackKickCount += 1;
        runtime.lastPlaybackKickAt = Date.now();
        const method = forced ? 'forced-click' : 'click';
        note(noteKind, `${method}: ${label || meta.testId || 'Spotify play control'}`);
        return { clicked: true, label: label || meta.testId || 'play control', method };
    } catch (error) {
        note('playback-kick-candidate', `${meta.testId || meta.index}: ${error.message}`);
        return { clicked: false };
    }
}

async function clickSpotifyPlayControl(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime, noteKind = 'playback-kick', clickOptions = {}) {
    if (!page || page.isClosed()) return { clicked: false, reason: 'engine page closed' };
    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url())) continue;
        const candidates = frame.locator('button,[role="button"]');
        let count = 0;
        try { count = Math.min(await candidates.count(), 48); } catch { continue; }
        for (let index = 0; index < count; index += 1) {
            const candidate = candidates.nth(index);
            const meta = await controlMeta(candidate, index);
            const isPlayPause = meta.testId === 'play-pause-button' && !/\bpause\b/i.test(meta.label);
            if (!isPlayPause && !(meta.visible && isLikelyPlayControl(meta.label))) continue;
            const observed = await playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl);
            if (observed.playing) {
                note('playback-kick-skip', observed.providerShowsPlaying
                    ? 'Spotify already exposes Pause; treating provider playback as active.'
                    : 'Playback started before the Playwright click; leaving the provider control untouched.');
                return { clicked: false, alreadyPlaying: true, reason: 'playback already started' };
            }
            const result = await clickCandidate(candidate, meta, note, runtime, noteKind, clickOptions);
            if (result.clicked) return result;
        }
    }
    return { clicked: false, reason: 'No Spotify Play control could be activated.' };
}

function shouldRetogglePlaybackKick(observed, expectedGeneration = 0, options = {}) {
    const transport = observed?.transport || {};
    const currentGeneration = Math.max(0, Number(transport.generation || 0));
    const wantedGeneration = Math.max(0, Number(expectedGeneration || 0));
    if (wantedGeneration && currentGeneration && currentGeneration !== wantedGeneration) return false;
    const currentTime = Math.max(0, Number(transport.currentTime || 0));
    return observed?.playing !== true
        && String(transport.status || '') === 'provider-paused'
        && transport.paused !== false
        // A late-autoplay skip saw Pause flash before Spotify reverted, so 0s is still startup there.
        && (currentTime > 0 || options.allowZeroTime === true)
        && currentTime < PLAY_KICK_NEAR_START_MAX_S;
}

async function stabilizePlaybackKick(options = {}) {
    const observe = options.observe;
    const retoggle = options.retoggle;
    const wait = options.waitForPlaying;
    const sleep = options.sleep || delay;
    await sleep(Math.max(0, Number(options.verifyMs ?? PLAY_KICK_VERIFY_MS)));
    let observed = await observe();
    if (!shouldRetogglePlaybackKick(observed, options.expectedGeneration, options)) {
        return { observed, retoggled: false };
    }
    const retry = await retoggle();
    if (!retry?.clicked) return { observed, retoggled: false, retry };
    observed = await wait();
    return { observed, retoggled: true, retry };
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
    let observed = await playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl);
    if (observed.playing) {
        note('playback-kick-skip', observed.providerShowsPlaying
            ? 'Spotify already exposes Pause before activation scan.'
            : 'Playback started before activation scan.');
        return { clicked: false, alreadyPlaying: true, reason: 'playback already started' };
    }
    await hoverSpotifySurfaces(page, isSpotifyEmbedUrl, note);
    const deadline = Date.now() + Math.max(PLAY_CONTROL_WAIT_MS, PLAY_CONTROL_RENDER_GRACE_MS);
    while (Date.now() < deadline) {
        observed = await playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl);
        if (observed.playing) {
            note('playback-kick-skip', observed.providerShowsPlaying
                ? 'Spotify exposed Pause during activation scan.'
                : 'Playback started during activation scan.');
            return { clicked: false, alreadyPlaying: true, reason: 'playback already started' };
        }
        const result = await clickSpotifyPlayControl(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime);
        if (result.clicked || result.alreadyPlaying) return result;
        await delay(140);
    }
    const result = { clicked: false, reason: 'No Spotify Play control could be activated.' };
    await recordControlDiagnostics(page, isSpotifyEmbedUrl, note);
    note('playback-kick-miss', result.reason);
    return result;
}

async function handleTransportWithActivation(options, body) {
    const {
        page, spotifySnapshots, isSpotifyEmbedUrl, normalizeTrackId, note, runtime
    } = options;
    const action = String(body?.action || '').trim().toLowerCase();
    // SDK seek is for podcasts. Do not issue a competing SDK seek for managed songs.
    if (action === 'seek') return handleManagedSeek(options, body);
    const previous = action === 'load' ? await engineSnapshot(page).catch(() => null) : null;
    const result = await engineCommand(page, body);
    if (result?.ok && action === 'load' && previous?.spotifyId === result.state?.spotifyId) {
        const mediaSeek = await seekManagedMedia(options, result.state, 0);
        result.mediaSeek = mediaSeek;
    }
    if (!result?.ok || !['play', 'resume'].includes(action)) return result;

    let observed = await waitForPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, PLAY_WAKE_INITIAL_MS);
    let activationMethod = observed.providerShowsPlaying ? 'provider-control' : 'controller';
    if (!observed.playing) {
        const kicked = await activateSpotifyPlayback(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime);
        activationMethod = kicked.alreadyPlaying ? 'controller-late' : (kicked.clicked ? `playwright-${kicked.method || 'click'}` : 'controller-pending');
        if (kicked.alreadyPlaying || kicked.clicked) {
            // A Pause control seen mid-scan can be Spotify autoplay that reverts to paused; verify it too.
            const stable = await stabilizePlaybackKick({
                observe: () => playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl),
                retoggle: () => clickSpotifyPlayControl(
                    page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime, 'playback-kick-retoggle',
                    { forceOnVisibleTimeout: true }
                ),
                waitForPlaying: () => waitForPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, PLAY_WAKE_SETTLE_MS),
                expectedGeneration: Number(result.state?.generation || 0),
                allowZeroTime: kicked.alreadyPlaying === true
            });
            observed = stable.observed;
            if (stable.retoggled) activationMethod = `${activationMethod}+retoggle`;
            if (!observed.playing && !stable.retoggled) {
                observed = await waitForPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, PLAY_WAKE_SETTLE_MS);
            }
        } else {
            observed = await waitForPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, PLAY_WAKE_SETTLE_MS);
        }
    }
    observed = await confirmPlaybackObservation(
        observed,
        () => waitForConfirmedPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, PLAY_WAKE_SETTLE_MS),
        note
    );
    const confirmation = await stabilizeConfirmedPlayback({
        observed,
        observe: () => playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl),
        resume: () => engineCommand(page, { action: 'play' }),
        reactivate: () => reactivateStartup({
            page, observe: () => playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl),
            expectedGeneration: Number(result.state?.generation || 0), isSpotifyEmbedUrl, note, runtime
        }),
        waitForConfirmed: () => waitForConfirmedPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, PLAY_WAKE_SETTLE_MS),
        expectedGeneration: Number(result.state?.generation || 0),
        note
    });
    observed = confirmation.observed;
    if (confirmation.recovered) activationMethod = `${activationMethod}+resume-recover`;
    if (confirmation.reactivated) activationMethod = `${activationMethod}+trusted-reactivate`;
    if (!confirmation.stable) {
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
    if (Number(finalState.generation) !== Number(result.state?.generation)) {
        return { ok: false, action, state: finalState, playbackActivated: false,
            reason: 'Spotify playback was superseded during startup confirmation.' };
    }
    return { ...result, state: finalState, playbackActivated: true, activationMethod };
}

module.exports = {
    headlessRequestedFromPageUrl,
    isLikelyPlayControl,
    providerPauseButtonShowsPlaying,
    isConfirmedPlaybackObservation,
    confirmPlaybackObservation,
    shouldRecoverLostConfirmation,
    stabilizeConfirmedPlayback,
    shouldRetogglePlaybackKick,
    stabilizePlaybackKick,
    clickCandidate,
    PLAY_WAKE_INITIAL_MS,
    PLAY_CONTROL_WAIT_MS,
    PLAY_CONTROL_RENDER_GRACE_MS,
    PLAY_KICK_VERIFY_MS,
    PLAY_CONFIRM_VERIFY_MS,
    handleTransportWithActivation
};
