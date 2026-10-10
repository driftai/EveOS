'use strict';

// Post-activation confirmation: one bounded resume, then one trusted reactivation, both fenced
// to the startup generation. Callers inject observe/resume/reactivate/sleep, so the lifecycle
// lease can cancel every delayed step.
const {
    PLAY_KICK_NEAR_START_MAX_S, delay, isConfirmedPlaybackObservation, confirmedForGeneration
} = require('./audioflix_spotify_playback_observation.js');

// Live embeds can briefly start, then reset to paused/zero after more than 700ms.
const PLAY_CONFIRM_VERIFY_MS = 2200;

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

module.exports = {
    PLAY_CONFIRM_VERIFY_MS, confirmPlaybackObservation, shouldRecoverLostConfirmation, stabilizeConfirmedPlayback
};
