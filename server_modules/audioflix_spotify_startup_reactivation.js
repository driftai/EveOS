'use strict';

// Only a failed, already-confirmed startup may use this recovery. An established provider
// pause is not user activation failure and must never be stolen back by the managed helper.
const CONTROL_SELECTOR = '[data-testid="play-pause-button"]';
const RECOVERY_BUDGET_MS = 3200;
const CLICK_TIMEOUT_MS = 900;

function samePausedStartup(observed, generation) {
    const state = observed?.transport || {};
    return Number(generation) > 0 && Number(state.generation) === Number(generation)
        && state.playRequested !== false
        && ['provider-paused', 'starting'].includes(String(state.status || ''))
        && state.paused !== false && Number(observed?.playingCount || 0) === 0
        && Math.max(0, Number(state.currentTime || 0)) < 2;
}

function remaining(deadline) {
    const ms = deadline - Date.now();
    if (ms <= 0) throw new Error('Startup reactivation budget expired.');
    return ms;
}

async function boundedObserve(observe, deadline) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(observe),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Startup observation timed out.')), remaining(deadline)); })
        ]);
    } finally { clearTimeout(timer); }
}

async function labelOf(button, deadline) {
    const aria = await button.getAttribute('aria-label', { timeout: Math.min(CLICK_TIMEOUT_MS, remaining(deadline)) });
    const title = await button.getAttribute('title', { timeout: Math.min(CLICK_TIMEOUT_MS, remaining(deadline)) });
    return `${aria || ''} ${title || ''}`.trim();
}

async function reactivateStartup(options) {
    const { page, observe, expectedGeneration, isSpotifyEmbedUrl, note, runtime } = options;
    const budget = Math.min(RECOVERY_BUDGET_MS, Math.max(1, Number(options.budgetMs ?? RECOVERY_BUDGET_MS)));
    const deadline = Date.now() + budget;
    const fence = async () => {
        try {
            if (page.isClosed()) return false;
            const observed = await boundedObserve(observe, deadline);
            return Date.now() < deadline && !page.isClosed() && samePausedStartup(observed, expectedGeneration);
        } catch (error) { note('playback-startup-reactivate-miss', error.message); return false; }
    };
    if (!await fence()) return { clicked: false, reason: 'Startup recovery no longer applies.' };

    for (const frame of page.frames()) {
        if (!isSpotifyEmbedUrl(frame.url())) continue;
        const button = frame.locator(CONTROL_SELECTOR).first();
        try {
            if (!await button.count()) continue;
            let label = await labelOf(button, deadline);
            if (!/\b(play|pause)\b/i.test(label) || !await fence()) continue;
            if (/\bpause\b/i.test(label)) {
                // The live failure has a stale Pause label despite paused media at zero. Reset
                // that provider toggle once, then click only when it advertises Play.
                await button.click({ force: true, timeout: Math.min(CLICK_TIMEOUT_MS, remaining(deadline)) });
                note('playback-startup-reset', 'Trusted Pause reset for a same-generation paused startup.');
                while (Date.now() < deadline) {
                    label = await labelOf(button, deadline);
                    if (/^play\b/i.test(label) && !/\bpause\b/i.test(label)) break;
                    if (!await fence()) return { clicked: false, reason: 'Startup changed during provider reset.' };
                    await new Promise(resolve => setTimeout(resolve, 80));
                }
            }
            if (!/^play\b/i.test(label) || /\bpause\b/i.test(label) || !await fence()) {
                return { clicked: false, reason: 'Provider did not expose a safe Play control.' };
            }
            // A Playwright mouse click supplies real browser input. A dispatched DOM click is
            // not a substitute for user activation, so failure stays failure here.
            await button.click({ force: true, timeout: Math.min(CLICK_TIMEOUT_MS, remaining(deadline)) });
            runtime.playbackKickCount += 1;
            runtime.lastPlaybackKickAt = Date.now();
            note('playback-startup-reactivate', 'Trusted Play click after controller startup recovery failed.');
            return { clicked: true, method: 'trusted-click' };
        } catch (error) {
            note('playback-startup-reactivate-miss', error.message);
            return { clicked: false, reason: 'Provider startup control could not be clicked.' };
        }
    }
    return { clicked: false, reason: 'Provider startup control is unavailable.' };
}

module.exports = { reactivateStartup, samePausedStartup, RECOVERY_BUDGET_MS };
