// Managed Spotify queue continuation is broker-owned while this exact run is delegated.
// The frontend renders owner receipts; it never replays a claimed completion on thaw.
window.EveAudioflixSpotifyQueueHandoff = window.EveAudioflixSpotifyQueueHandoff || {};
(function () {
    'use strict';
    const ns = window.EveAudioflixSpotifyQueueHandoff;
    if (ns.ready) return;
    const remote = () => window.EveAudioflixSpotifyRemote;
    const media = () => window.EveAudioflixSpotifyMedia;
    let lease = null;
    let serial = 0;

    function current() {
        return window.EveAudioflix?.queueConnection?.snapshot?.() || null;
    }
    function isDelegated() {
        return !!lease && current()?.playbackRunId === lease.runId;
    }
    async function arm(queue, trackAt) {
        const serialAtStart = ++serial;
        lease = null;
        const player = window.EveAudioflixSpotifyAnyBrowser?.snapshot?.();
        const connection = remote()?.snapshot?.();
        if (!queue?.isPlaying || !player?.active || !connection?.connected || !connection?.lastState?.isOwner || (queue.shuffle && queue.loop)) return false;
        const items = Array.isArray(queue.items) ? queue.items : [];
        if (!items.length || items.length > 256 || typeof trackAt !== 'function') return false;
        const entries = [];
        for (let i = 0; i < items.length; i += 1) {
            const track = trackAt(i);
            const identity = media()?.fromItem?.(track);
            if (!identity || String(track?.id ?? '') !== String(items[i] ?? '')) return false;
            entries.push({ ...identity, itemId: String(track.id), title: String(track.title || '').slice(0, 240),
                duration: Math.max(0, Number(track.duration || track.resolvedDuration || 0)),
                effectiveVolume: window.EveAudioflixSpotifyVolume?.effectiveGain?.(track.volume ?? 1) ?? 1 });
        }
        const index = Number(queue.currentIndex);
        const runId = Number(current()?.playbackRunId);
        if (!Number.isSafeInteger(runId) || runId < 1 || index < 0 || index >= items.length) return false;
        // Claim frontend completion BEFORE sending: a lost arm ACK must not double-advance.
        lease = { leaseId: '', runId, entries, index, state: 'pending' };
        // Do not send an uncorrelated plan: the broker independently verifies current owner/URI.
        const result = await remote().send('queue-arm', {
            entries, index, runId, loop: queue.loop === true, repeatOne: current()?.repeatOne === true
        }, { timeout: 9000 }).catch(() => null);
        if (serialAtStart !== serial || runId !== current()?.playbackRunId) {
            if (result?.queueLease?.leaseId) remote()?.send?.('queue-disarm', { leaseId: result.queueLease.leaseId }).catch(() => {});
            return false;
        }
        if (!result?.ok || result.queueLease?.state !== 'active') {
            if (!result || result.timeout || result.pending || result.disconnected) lease.state = 'uncertain';
            else lease = null; // confirmed rejection, never an ambiguous delivery
            window.EveAudioflixDiagnostics?.record?.('spotify:queue-delegation-unavailable', 0, { error: true });
            return false;
        }
        lease = { leaseId: result.queueLease.leaseId, runId, entries, index, state: 'active' };
        adopt({ ...result, engine: connection?.lastState?.engine || {} }, () => {});
        return true;
    }
    function adopt(result, updateItem = () => {}) {
        const ticket = result?.queueLease;
        if (!isDelegated() || !ticket || ticket.runId !== lease.runId) return false;
        if (lease.state === 'pending' || (lease.state === 'uncertain' && !lease.leaseId)) {
            if (!ticket.leaseId) return false;
            lease.leaseId = ticket.leaseId;
        }
        if (ticket.leaseId !== lease.leaseId) return false;
        if (!['active', 'finished', 'uncertain'].includes(ticket.state)) return false;
        if (ticket.state === 'uncertain') {
            lease.state = 'uncertain';
            window.EveAudioflixDiagnostics?.record?.('spotify:queue-delegation-uncertain', 0, { error: true });
            return true; // fail closed: no frontend replay
        }
        const index = Number(ticket.index);
        const entry = lease.entries[index];
        if (!Number.isInteger(index) || !entry || ticket.itemId !== entry.itemId) return false;
        const engine = result?.engine || {};
        if (engine.spotifyUri && engine.spotifyUri !== entry.spotifyUri) return false;
        const owned = window.EveAudioflix?.queueConnection;
        const next = owned?.adoptManagedSpotify?.({
            runId: lease.runId, index, itemId: entry.itemId, finished: ticket.state === 'finished'
        });
        if (next) {
            lease.index = index;
            lease.state = ticket.state;
            updateItem(next);
        }
        return true;
    }
    function invalidate() {
        ++serial;
        const prior = lease;
        lease = null;
        if (prior?.leaseId && remote()?.snapshot?.().connected) {
            // Local controls also revoke the lease inside the broker. This request is best effort.
            remote().send('queue-disarm', { leaseId: prior.leaseId }).catch(() => {});
        }
    }
    window.addEventListener?.('eve:audioflix-queue-changed', invalidate);
    Object.assign(ns, { ready: true, arm, adopt, isDelegated, invalidate });
})();
