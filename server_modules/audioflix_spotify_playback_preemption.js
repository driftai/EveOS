'use strict';

// Control-plane preemption for the managed Spotify helper.
//
// Ordinary /transport stays serialized behind the broker `_transport_lock` and the manager
// `_lock`, and remains the only path for Load/Play/Pause/Stop state transitions. This module adds
// one fixed, token-protected interrupt so a newer *accepted* broker intent can invalidate start
// work that is already running behind those locks. The preemption epoch is internal concurrency
// bookkeeping only: it is not a queue identity, a track generation or an ownership token.
const { engineSnapshot, engineQuiesce } = require('./audioflix_spotify_browser_transport.js');
const { cancelLeases } = require('./audioflix_spotify_playback_lease.js');

const INTERRUPT_REASONS = new Set(['superseded', 'paused', 'stopped']);
const QUIESCE_TIMEOUT_MS = 1200;

function ensurePreemption(runtime) {
    if (!Number.isFinite(runtime.preemptEpoch)) runtime.preemptEpoch = 0;
    if (!Number.isFinite(runtime.startsInFlight)) runtime.startsInFlight = 0;
    return runtime;
}

// Captured at the start of a play/resume request, before any awaited engine work, so an
// interrupt that lands before the lifecycle lease exists still invalidates the request.
function captureEpoch(runtime) { return ensurePreemption(runtime).preemptEpoch; }

function preempted(runtime, epoch) {
    return Number(ensurePreemption(runtime).preemptEpoch) !== Number(epoch);
}

function preemptReason(runtime) { return String(runtime.preemptReason || 'superseded'); }

async function withinMs(work, ms) {
    let timer;
    try {
        return await Promise.race([Promise.resolve().then(work).catch(() => null),
            new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); })]);
    } finally { clearTimeout(timer); }
}

// The interrupt never loads, plays, seeks or evaluates caller input. For Pause/Stop while a start
// is in flight it may quiesce the engine's *current* generation (the only one a serialized start
// can be working on) so the abandoned start cannot keep sounding while Stop waits for the locks.
async function handleInterrupt(options, body = {}) {
    const { page, runtime, note } = options;
    ensurePreemption(runtime);
    const reason = String(body?.reason || '').toLowerCase();
    if (!INTERRUPT_REASONS.has(reason)) return { ok: false, reason: 'Unsupported interrupt reason.' };
    runtime.preemptEpoch += 1;
    runtime.preemptReason = reason;
    const cancelled = cancelLeases(runtime, reason);
    const inFlight = runtime.startsInFlight > 0;
    let quiesced = false;
    if (inFlight && reason !== 'superseded' && page && !page.isClosed()) {
        const latest = await withinMs(() => engineSnapshot(page), QUIESCE_TIMEOUT_MS);
        if (latest && latest.playRequested !== false) {
            const paused = await withinMs(() => engineQuiesce(page, latest.generation), QUIESCE_TIMEOUT_MS);
            quiesced = paused?.quiesced === true;
        }
    }
    note('playback-interrupt', `${reason}; epoch ${runtime.preemptEpoch}; leases ${cancelled}; inFlight ${inFlight}; quiesced ${quiesced}`);
    return { ok: true, interrupted: true, reason, epoch: runtime.preemptEpoch, cancelled, inFlight, quiesced };
}

module.exports = {
    INTERRUPT_REASONS, QUIESCE_TIMEOUT_MS, ensurePreemption, captureEpoch, preempted, preemptReason, handleInterrupt
};
