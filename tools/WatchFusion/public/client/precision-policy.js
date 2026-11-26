/* v13.10.5 precision thresholds (Drift policy: <=50 Locked, 50-100 Refining, >100 must act) and independent peer corroboration.
 * This is player-timeline precision, not a measurement of speaker audio output.
 */
(() => {
  'use strict';
  const LOCK_MS = 50, ACTION_MS = 100, HARD_REJOIN_MS = 160;
  const finite = value => typeof value === 'number' && Number.isFinite(value);
  function peerCandidate({peers, coordination: c, member, segment, sourceAgeMs, now, sourceErrorMs, observeOnly}) {
    const reference = c?.reference || 'room-clock', cohort = reference === 'peer-cohort';
    const uncertainty = c?.uncertaintyMs;
    const live = c?.source === 'live' && finite(c.sourcePhaseMs) && Math.abs(c.sourcePhaseMs) <= 70 &&
      finite(sourceAgeMs) && sourceAgeMs <= 900;
    const linked = reference === 'linked-tab' && live && !c.authorityBuffering && finite(uncertainty) && uncertainty <= 125;
    if (!linked && reference !== 'room-clock' && !(cohort && finite(uncertainty) && uncertainty <= 125)) return null;
    const members = peers.filter(p => p.member !== member && p.playoutSegment === segment && p.follows &&
      p.ready && p.playing && !p.buffering && !p.correcting && ['fine-locked','decoder-confirmed','direct-ready'].includes(p.startupPhase));
    const single = members.length === 1 ? members[0] : null;
    const observedSingle = !!single && observeOnly === true && linked;
    const liveSingle = !!single && reference === 'room-clock' && live && (uncertainty == null || (finite(uncertainty) && uncertainty <= 125));
    if (!members.length || (single && !observedSingle && !liveSingle)) return null;
    const offsets = members.map(p => linked ? sourceErrorMs?.(p,c,now) : p.positionMs - (cohort ? p.targetPositionMs : p.roomPositionMs));
    if (offsets.some(offset => !finite(offset) || Math.abs(offset) > 70) ||
        members.some(p => !finite(p.sampledAt) || Math.abs(now-p.sampledAt) >= 1500 || !finite(p.rttMs) || p.rttMs >= 90)) return null;
    const spreadMs = Math.max(...offsets) - Math.min(...offsets);
    if (spreadMs > (linked || cohort ? 110 : 45)) return null;
    return {reference, spreadMs, count:members.length, observeOnly:observedSingle,
      offsetMs:offsets.reduce((sum,offset)=>sum+offset,0)/offsets.length,
      sampledAt:Math.min(...members.map(p=>p.sampledAt)), ageMs:Math.max(...members.map(p=>Math.abs(now-p.sampledAt))),
      ...(observedSingle ? {member:single.member, clockWitness:single.clockWitness === true} : {})};
  }
  function witness(peer, localOffsetMs) {
    if (!peer || peer.count < 2 || !finite(peer.offsetMs) || !finite(peer.spreadMs) ||
        !finite(peer.ageMs) || peer.ageMs > 1500 || peer.ageMs < 0 || peer.spreadMs > 110 ||
        Math.abs(peer.offsetMs) > 70 || !finite(localOffsetMs)) return null;
    const gapMs = localOffsetMs - peer.offsetMs;
    const confidenceMs = Math.max(45, peer.spreadMs / 2 + 20); // peer agreement is not absolute clock precision
    return { gapMs, confidenceMs, independent: Math.abs(gapMs) > confidenceMs,
      peerCount:peer.count, peerSpreadMs:peer.spreadMs };
  }
  function trustedHostReference(coordination, peer, hostOffsetMs) {
    if (!coordination || coordination.authorityBuffering || coordination.source !== 'live' ||
        !finite(coordination.uncertaintyMs) || coordination.uncertaintyMs > 125) return null;
    if (!['peer-cohort','room-clock','linked-source','linked-tab'].includes(coordination.reference)) return null;
    const peers = witness(peer, hostOffsetMs);
    // A linked-tab reference is valid only with independently healthy peers and a live, in-phase source.
    if (coordination.reference === 'linked-tab' && (!peers || !finite(coordination.sourcePhaseMs) || Math.abs(coordination.sourcePhaseMs) > 70)) return null;
    if (peers && Math.abs(peers.gapMs) > Math.max(peers.confidenceMs, coordination.uncertaintyMs * 1.35)) return {
      kind:'peer-corroborated', precisionMs:coordination.uncertaintyMs, peers
    };
    if (coordination.uncertaintyMs <= 45 && ['linked-source','linked-tab'].includes(coordination.reference)) return {
      kind:'source-verified',precisionMs:coordination.uncertaintyMs,peers:null
    };
    return null;
  }
  // Read-only projection: compare every current-segment report at the same server instant.
  function comparisonPosition(peer, now, segment) {
    const age = now - peer.sampledAt;
    if (segment == null || peer.playoutSegment !== segment || !peer.ready || !peer.playing || peer.buffering || peer.correcting === true ||
        !finite(peer.sampledAt) || !finite(age) || age < 0 || age > 1500 || !finite(peer.positionMs) ||
        !finite(peer.rate) || peer.rate <= 0) return null;
    return peer.positionMs + age * peer.rate;
  }
  function zone(errorMs) {
    if (!finite(errorMs)) return 'unmeasured';
    const magnitude = Math.abs(errorMs);
    return magnitude <= LOCK_MS + .5 ? 'locked' : magnitude <= ACTION_MS + .5 ? 'refining' : 'correcting';
  }
  function label({ready,buffering,playing,correcting,errorMs,reason}={}) {
    if (!ready) return 'Loading';
    if (buffering) return 'Buffering';
    if (correcting) return 'Correcting';
    if (!playing) return 'Paused';
    const state = zone(errorMs);
    if (state === 'unmeasured') return 'Timing unavailable';
    if (state === 'locked') return 'Locked';
    if (state === 'refining') return 'Playing · offset reported';
    if (/^(?:rate-converging|rate-started|rejoin-started|host-peer-rejoin|stall-kick-started|hold-started|host-zero-centering|decoder-reload-once|decoder-recovery|zero-converging)$/.test(reason || '')) return 'Correcting';
    if (/^(?:stall-recovery-exhausted|auto-correction-suspended|viewer-stalled-while-playing)$/.test(reason || '')) return 'Recovery stalled';
    if (/^(?:host-auto-seek-guarded|host-subsecond-preserved)$/.test(reason || '')) return 'Playing · seek guarded';
    if (reason === 'output-phase-unverified') return 'Playing · audio phase unverified';
    return 'Playing · offset reported';
  }
  globalThis.WatchFusionPrecisionPolicy = Object.freeze({
    version:'v13.10.6', LOCK_MS, ACTION_MS, HARD_REJOIN_MS,
    peerCandidate, witness, trustedHostReference, comparisonPosition, zone, label
  });
})();
