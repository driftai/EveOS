'use strict';

// One end-to-end lifecycle lease for a managed Spotify transport request.
// The private RPC gives the helper TRANSPORT_TIMEOUT_S (18s) to answer. Every startup,
// recovery, retoggle and seek step shares this lease, so once the caller has given up (or
// the user paused/stopped, a newer request superseded it, or the page was reset), no delayed
// browser action may still click Play or acknowledge a stale completion.

const PLAYBACK_START_BUDGET_MS = 15500; // leaves headroom inside the 18s private RPC.
const MEDIA_SEEK_BUDGET_MS = 6000;
const LEASE_CHECK_TIMEOUT_MS = 1500;

const ABORT_MESSAGES = {
    deadline: 'Spotify playback did not confirm within the managed start deadline.',
    superseded: 'Spotify playback was superseded by a newer request.',
    paused: 'Spotify playback was paused before startup finished.',
    stopped: 'Spotify playback was stopped before startup finished.',
    'page-reset': 'The managed Spotify page was reset during startup.'
};

class PlaybackLeaseAbort extends Error {
    constructor(reason, detail = '') {
        super(detail || ABORT_MESSAGES[reason] || `Spotify playback lifecycle aborted (${reason}).`);
        this.name = 'PlaybackLeaseAbort';
        this.lifecycle = reason;
    }
}

function cancelLeases(runtime, reason) {
    const leases = runtime?.playbackLeases;
    if (!leases) return 0;
    let count = 0;
    for (const lease of [...leases]) { if (lease.cancel(reason)) count += 1; }
    return count;
}

// Mutating transport actions settle any lease still running from an earlier (timed-out) caller.
function cancelReasonForAction(action) {
    const name = String(action || '').toLowerCase();
    if (name === 'pause') return 'paused';
    if (name === 'stop') return 'stopped';
    if (['load', 'play', 'resume', 'restart'].includes(name)) return 'superseded';
    return '';
}

function createPlaybackLease(options = {}) {
    const runtime = options.runtime || {};
    const now = options.now || Date.now;
    const page = options.page || null;
    const readState = options.readState;
    const kind = String(options.kind || 'start');
    const generation = Math.max(0, Number(options.generation || 0));
    const spotifyId = String(options.spotifyId || '');
    const deadline = now() + Math.max(1, Number(options.budgetMs ?? PLAYBACK_START_BUDGET_MS));
    if (!runtime.playbackLeases) runtime.playbackLeases = new Set();
    let abortReason = '';
    const waiters = new Set();

    const lease = {
        kind, generation, spotifyId, deadline,
        get reason() { return abortReason; },
        remaining() { return Math.max(0, deadline - now()); },
        cancel(reason) {
            if (abortReason) return false;
            abortReason = String(reason || 'superseded');
            for (const wake of [...waiters]) wake();
            return true;
        },
        release() { runtime.playbackLeases.delete(lease); for (const wake of [...waiters]) wake(); },
        ensureLive() {
            if (!abortReason && page && typeof page.isClosed === 'function' && page.isClosed()) abortReason = 'page-reset';
            if (!abortReason && now() >= deadline) abortReason = 'deadline';
            if (abortReason) throw new PlaybackLeaseAbort(abortReason);
        },
        // Bound any browser/IPC promise by both the lease deadline and cancellation.
        async bound(work, capMs = Infinity) {
            lease.ensureLive();
            let timer;
            let wake;
            try {
                return await Promise.race([
                    Promise.resolve().then(work),
                    new Promise((_, reject) => {
                        const fail = () => reject(new PlaybackLeaseAbort(abortReason || 'deadline'));
                        wake = () => { if (abortReason) fail(); };
                        waiters.add(wake);
                        timer = setTimeout(() => {
                            if (!abortReason && now() >= deadline) abortReason = 'deadline';
                            fail();
                        }, Math.max(0, Math.min(capMs, lease.remaining())));
                    })
                ]);
            } finally {
                clearTimeout(timer);
                waiters.delete(wake);
            }
        },
        async sleep(ms) {
            lease.ensureLive();
            await new Promise((resolve) => {
                const timer = setTimeout(done, Math.max(0, Math.min(Number(ms) || 0, lease.remaining())));
                function done() { clearTimeout(timer); waiters.delete(done); resolve(); }
                waiters.add(done);
            });
            lease.ensureLive();
        },
        // Timeout for one browser action: never longer than the parent lease has left.
        budget(capMs = Infinity) {
            lease.ensureLive();
            return Math.max(1, Math.min(Number(capMs) || Infinity, lease.remaining()));
        },
        // A playback mutation (click, dispatch, resume): fence before, bound its own wait by the
        // remaining lease, and refence after so a late return is never treated as success.
        async mutate(action, capMs = Infinity) {
            await lease.verify();
            const result = await action(lease.budget(capMs));
            await lease.verify();
            return result;
        },
        // Recheck generation, track and play intent immediately before a delayed browser action.
        async verify() {
            lease.ensureLive();
            if (typeof readState !== 'function') return null;
            const state = await lease.bound(readState, LEASE_CHECK_TIMEOUT_MS);
            if (generation && Number(state?.generation || 0) !== generation) lease.cancel('superseded');
            else if (spotifyId && state?.spotifyId && String(state.spotifyId) !== spotifyId) lease.cancel('superseded');
            else if (kind === 'start' && state?.playRequested === false) lease.cancel('paused');
            lease.ensureLive();
            return state;
        }
    };
    runtime.playbackLeases.add(lease);
    return lease;
}

function leaseAbortResult(error, action, state = {}) {
    const lifecycle = error?.lifecycle || 'deadline';
    return {
        ok: false, action, lifecycle, reason: error.message, state,
        playbackActivated: false,
        // Distinct from the RPC socket `timeout` bit: the helper settled definitively and left
        // nothing running, so the client must not adopt this start as an in-flight slow start.
        deadlineExpired: lifecycle === 'deadline',
        superseded: lifecycle !== 'deadline'
    };
}

module.exports = {
    PLAYBACK_START_BUDGET_MS, MEDIA_SEEK_BUDGET_MS, LEASE_CHECK_TIMEOUT_MS,
    PlaybackLeaseAbort, createPlaybackLease, cancelLeases, cancelReasonForAction, leaseAbortResult
};
