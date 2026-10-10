'use strict';

const { URL } = require('node:url');
const { engineSnapshot, engineCommand, engineQuiesce } = require('./audioflix_spotify_browser_transport.js');
const { captureEpoch, preempted, preemptReason } = require('./audioflix_spotify_playback_preemption.js');
const { reactivateStartup, RECOVERY_BUDGET_MS } = require('./audioflix_spotify_startup_reactivation.js');
const { seekManagedMedia, handleManagedSeek } = require('./audioflix_spotify_media_seek.js');
const {
    PLAY_KICK_NEAR_START_MAX_S, delay, providerPauseButtonShowsPlaying, playbackObservation,
    isConfirmedPlaybackObservation, waitForPlaying, waitForConfirmedPlaying
} = require('./audioflix_spotify_playback_observation.js');
const {
    PLAY_CONFIRM_VERIFY_MS, confirmPlaybackObservation, shouldRecoverLostConfirmation, stabilizeConfirmedPlayback
} = require('./audioflix_spotify_playback_confirmation.js');
const {
    createPlaybackLease, cancelLeases, cancelReasonForAction, leaseAbortResult, PlaybackLeaseAbort
} = require('./audioflix_spotify_playback_lease.js');

const PLAY_WAKE_INITIAL_MS = 1400;
const PLAY_CONTROL_WAIT_MS = 3200;
// A slow Spotify embed can navigate several seconds after load. Keep rescanning for controls
// instead of turning an otherwise recoverable render delay into a queue skip.
const PLAY_CONTROL_RENDER_GRACE_MS = 5000;
const PLAY_WAKE_SETTLE_MS = 3200;
const PLAY_KICK_VERIFY_MS = 700;
const MAX_CONTROL_DIAGNOSTICS = 20;


function headlessRequestedFromPageUrl(value) {
    try { return new URL(String(value || '')).searchParams.get('playwright') === 'headless'; }
    catch { return false; }
}

function isLikelyPlayControl(value) {
    const label = String(value || '').trim().toLowerCase();
    return /^play(?:\b|$)/.test(label) && !/\bspotify\b/.test(label);
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

const unleased = (action, capMs) => action(capMs);

// Every click and its dispatched fallback go through the parent lease's mutate(), so neither
// can wait past (or start after) the lifecycle deadline or a cancellation.
async function forceClickCandidate(candidate, mutate = unleased) {
    try { await mutate(timeout => candidate.click({ timeout, force: true }), 1800); }
    catch (error) {
        if (error instanceof PlaybackLeaseAbort) throw error;
        await mutate(timeout => candidate.dispatchEvent('click', undefined, { timeout }), 1800);
    }
}

async function clickCandidate(candidate, meta, note, runtime, noteKind = 'playback-kick', options = {}) {
    const label = meta.label;
    const isPlayPause = meta.testId === 'play-pause-button' && !/\bpause\b/i.test(label);
    if (!isPlayPause && !(meta.visible && isLikelyPlayControl(label))) return { clicked: false };
    const mutate = options.lease ? (action, cap) => options.lease.mutate(action, cap) : unleased;
    try {
        let forced = !meta.visible;
        if (meta.visible) {
            try { await mutate(timeout => candidate.click({ timeout }), 1800); }
            catch (error) {
                // Only the already-authorized retoggle may force a visible-but-unstable Play control, once.
                if (error instanceof PlaybackLeaseAbort || options.forceOnVisibleTimeout !== true) throw error;
                note('playback-kick-candidate', `${meta.testId || meta.index}: ${error.message}`);
                await forceClickCandidate(candidate, mutate);
                forced = true;
            }
        } else await forceClickCandidate(candidate, mutate);
        runtime.playbackKickCount += 1;
        runtime.lastPlaybackKickAt = Date.now();
        const method = forced ? 'forced-click' : 'click';
        note(noteKind, `${method}: ${label || meta.testId || 'Spotify play control'}`);
        return { clicked: true, label: label || meta.testId || 'play control', method };
    } catch (error) {
        if (error instanceof PlaybackLeaseAbort) throw error;
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
            const observed = await observeWith(clickOptions.lease, page, spotifySnapshots, isSpotifyEmbedUrl);
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

function observeWith(lease, page, spotifySnapshots, isSpotifyEmbedUrl) {
    const observe = () => playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl);
    return lease ? lease.bound(observe) : observe();
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

async function activateSpotifyPlayback(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime, lease = null) {
    let observed = await observeWith(lease, page, spotifySnapshots, isSpotifyEmbedUrl);
    if (observed.playing) {
        note('playback-kick-skip', observed.providerShowsPlaying
            ? 'Spotify already exposes Pause before activation scan.'
            : 'Playback started before activation scan.');
        return { clicked: false, alreadyPlaying: true, reason: 'playback already started' };
    }
    if (lease) await lease.bound(() => hoverSpotifySurfaces(page, isSpotifyEmbedUrl, note));
    else await hoverSpotifySurfaces(page, isSpotifyEmbedUrl, note);
    const deadline = Date.now() + Math.max(PLAY_CONTROL_WAIT_MS, PLAY_CONTROL_RENDER_GRACE_MS);
    while (Date.now() < deadline) {
        observed = await observeWith(lease, page, spotifySnapshots, isSpotifyEmbedUrl);
        if (observed.playing) {
            note('playback-kick-skip', observed.providerShowsPlaying
                ? 'Spotify exposed Pause during activation scan.'
                : 'Playback started during activation scan.');
            return { clicked: false, alreadyPlaying: true, reason: 'playback already started' };
        }
        const result = await clickSpotifyPlayControl(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime,
            'playback-kick', { lease });
        if (result.clicked || result.alreadyPlaying) return result;
        if (lease) await lease.sleep(140);
        else await delay(140);
    }
    const result = { clicked: false, reason: 'No Spotify Play control could be activated.' };
    if (lease) await lease.bound(() => recordControlDiagnostics(page, isSpotifyEmbedUrl, note));
    else await recordControlDiagnostics(page, isSpotifyEmbedUrl, note);
    note('playback-kick-miss', result.reason);
    return result;
}

async function handleTransportWithActivation(options, body) {
    const { page, runtime, note } = options;
    const action = String(body?.action || '').trim().toLowerCase();
    // A newer mutating request settles any startup a timed-out caller left running.
    const cancelReason = cancelReasonForAction(action);
    if (cancelReason && cancelLeases(runtime, cancelReason)) note('playback-lease-cancel', `${cancelReason} by ${action}`);
    // SDK seek is for podcasts. Do not issue a competing SDK seek for managed songs.
    if (action === 'seek') return handleManagedSeek(options, body);
    if (!['play', 'resume'].includes(action)) return loadOrControl(options, body, action);
    // Capture the preemption epoch before any awaited engine work: an interrupt that lands
    // while the engine Play is still pending (no lease yet) must still invalidate this start.
    const epoch = captureEpoch(runtime);
    runtime.startsInFlight += 1;
    try {
        const result = await engineCommand(page, body);
        if (!result?.ok) return result;
        const generation = Number(result.state?.generation || 0);
        const lease = createPlaybackLease({
            runtime, page, generation, spotifyId: String(result.state?.spotifyId || ''),
            readState: () => engineSnapshot(page), budgetMs: options.startBudgetMs,
            preempted: () => (preempted(runtime, epoch) ? preemptReason(runtime) : '')
        });
        try {
            return await startWithLease(options, body, action, result, lease);
        } catch (error) {
            if (!(error instanceof PlaybackLeaseAbort)) throw error;
            note('playback-lease-abort', `${error.lifecycle}; generation ${generation}`);
            const state = await settleAbortedStart(options, error, generation, result.state || {});
            return leaseAbortResult(error, action, state);
        } finally {
            lease.release();
        }
    } finally {
        runtime.startsInFlight -= 1;
    }
}

async function loadOrControl(options, body, action) {
    const previous = action === 'load' ? await engineSnapshot(options.page).catch(() => null) : null;
    const result = await engineCommand(options.page, body);
    if (result?.ok && action === 'load' && previous?.spotifyId === result.state?.spotifyId) {
        result.mediaSeek = await seekManagedMedia(options, result.state, 0);
    }
    return result;
}

async function boundedSnapshot(page, ms = 1200) {
    let timer;
    try {
        return await Promise.race([engineSnapshot(page),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
    } catch { return null; } finally { clearTimeout(timer); }
}

// Any abandoned start (deadline, preemption, Pause/Stop, supersession) must not keep sounding or
// requesting play. engineQuiesce pauses only if this request's generation is still current, so
// an aborted old start can never pause a newer generation.
async function settleAbortedStart(options, error, generation, fallback) {
    const { page, runtime, note } = options;
    if (error.lifecycle === 'deadline') runtime.lastError = error.message;
    if (error.lifecycle !== 'page-reset') {
        let timer;
        const quiet = await Promise.race([engineQuiesce(page, generation).catch(() => null),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), 1200); })]);
        clearTimeout(timer);
        if (quiet?.quiesced) note('playback-start-withdrawn', `generation ${generation} quiesced after ${error.lifecycle}`);
    }
    return (await boundedSnapshot(page)) || fallback;
}

async function startWithLease(options, body, action, result, lease) {
    const {
        page, spotifySnapshots, isSpotifyEmbedUrl, normalizeTrackId, note, runtime
    } = options;
    const generation = lease.generation;
    const observe = () => observeWith(lease, page, spotifySnapshots, isSpotifyEmbedUrl);
    const waitPlaying = ms => waitForPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, ms, lease);
    const waitConfirmed = () => waitForConfirmedPlaying(page, spotifySnapshots, isSpotifyEmbedUrl, PLAY_WAKE_SETTLE_MS, lease);
    let observed = await waitPlaying(PLAY_WAKE_INITIAL_MS);
    let activationMethod = observed.providerShowsPlaying ? 'provider-control' : 'controller';
    if (!observed.playing) {
        const kicked = await activateSpotifyPlayback(page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime, lease);
        activationMethod = kicked.alreadyPlaying ? 'controller-late' : (kicked.clicked ? `playwright-${kicked.method || 'click'}` : 'controller-pending');
        if (kicked.alreadyPlaying || kicked.clicked) {
            // A Pause control seen mid-scan can be Spotify autoplay that reverts to paused; verify it too.
            const stable = await stabilizePlaybackKick({
                observe, sleep: ms => lease.sleep(ms),
                retoggle: () => clickSpotifyPlayControl(
                    page, spotifySnapshots, isSpotifyEmbedUrl, note, runtime, 'playback-kick-retoggle',
                    { forceOnVisibleTimeout: true, lease }
                ),
                waitForPlaying: () => waitPlaying(PLAY_WAKE_SETTLE_MS),
                expectedGeneration: generation,
                allowZeroTime: kicked.alreadyPlaying === true
            });
            observed = stable.observed;
            if (stable.retoggled) activationMethod = `${activationMethod}+retoggle`;
            if (!observed.playing && !stable.retoggled) observed = await waitPlaying(PLAY_WAKE_SETTLE_MS);
        } else {
            observed = await waitPlaying(PLAY_WAKE_SETTLE_MS);
        }
    }
    observed = await confirmPlaybackObservation(observed, waitConfirmed, note);
    const confirmation = await stabilizeConfirmedPlayback({
        observed, observe, sleep: ms => lease.sleep(ms),
        resume: () => lease.mutate(() => lease.bound(() => engineCommand(page, { action: 'play' }))),
        reactivate: async () => {
            await lease.verify();
            return reactivateStartup({
                page, observe: () => playbackObservation(page, spotifySnapshots, isSpotifyEmbedUrl),
                expectedGeneration: generation, isSpotifyEmbedUrl, note, runtime,
                budgetMs: Math.min(RECOVERY_BUDGET_MS, lease.remaining()), guard: () => lease.verify(),
                mutate: (action, cap) => lease.mutate(action, cap)
            });
        },
        waitForConfirmed: waitConfirmed,
        expectedGeneration: generation,
        note
    });
    observed = confirmation.observed;
    if (confirmation.recovered) activationMethod = `${activationMethod}+resume-recover`;
    if (confirmation.reactivated) activationMethod = `${activationMethod}+trusted-reactivate`;
    if (!confirmation.stable) {
        await lease.verify(); // a cancelled/expired start reports its lifecycle, not activation failure
        const message = 'Spotify loaded but did not begin playback. The managed engine could not establish a playable user activation.';
        runtime.lastError = message;
        runtime.state = observed.transport?.status || 'starting';
        note('playback-start-failed', `${runtime.state}; ${activationMethod}`);
        return {
            ok: false, action, reason: message, state: observed.transport || result.state || {},
            playbackActivated: false, activationMethod
        };
    }

    await lease.verify();
    runtime.lastError = '';
    runtime.state = 'controlling';
    const trackId = normalizeTrackId(body?.spotifyId || body?.trackId || body?.url || body?.uri || '');
    if (Number.isFinite(Number(runtime.desiredVolume))) {
        await lease.bound(() => spotifySnapshots(runtime.desiredVolume, trackId));
    }
    let finalState = observed.transport || result.state || {};
    try { finalState = await lease.bound(() => engineSnapshot(page)); } catch (error) {
        if (error instanceof PlaybackLeaseAbort) throw error;
    }
    if (Number(finalState.generation) !== Number(result.state?.generation)) {
        return { ok: false, action, state: finalState, playbackActivated: false, lifecycle: 'superseded', superseded: true,
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
    activateSpotifyPlayback,
    PLAY_WAKE_INITIAL_MS,
    PLAY_CONTROL_WAIT_MS,
    PLAY_CONTROL_RENDER_GRACE_MS,
    PLAY_KICK_VERIFY_MS,
    PLAY_CONFIRM_VERIFY_MS,
    handleTransportWithActivation
};
