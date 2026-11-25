/* WatchFusion v13.10.8h: host-only seek trust policy; TV and normal transport remain untouched.
 * The host rejoin actuator still belongs exclusively to viewer-sync-arbiter. */
(() => {
  'use strict';
  if (globalThis.WatchFusionHostSeekPolicy) return;
  const SAFE_LANDING_SEC = .85, LANDING_WAIT_MS = 1500, MIN_HOST_REJOIN_SEC = .70;
  // v8n: the older shared decoder model can persist a spurious ~1.9 s host start
  // delay. Preserve its TV behavior; a linked host gets an independent, measured
  // release model, seeded conservatively until a resumed landing is verified.
  const clamp=(x,lo,hi)=>Math.max(lo,Math.min(hi,x));
  function releaseLatency(io,model){
    if(!io.hostLinked)return model.releaseLatencySec;
    const known=model.hostReleaseLatencySec;
    return Number.isFinite(known)&&known>=0 ? clamp(known,0,.9)
      : clamp(model.releaseLatencySec,0,.35);
  }
  function sourceBlocker(target) {
    const playout = window.watchFusionPlayout, c = playout?.status?.();
    if (c?.mirrorContradicted || window.WatchFusionMirrorConvergenceGate?.contradicted?.()) return 'host-mirror-contradicted';
    if (!playout?.hasSourceReference?.(c, estimatedServerNow())) return 'host-source-unverified';
    const clock = window.watchPartyClock, rtt = clock?.rttMs?.();
    if (!clock?.precise?.() || !Number.isFinite(rtt) || rtt < 0 || rtt > 90) return 'host-clock-unverified';
    const link = window.watchFusionLinkedTab, m = link?.metadata?.();
    if (!link?.publishing?.() || !m || window.parseYoutubeInput?.(m.pageUrl) !== state.source.videoId ||
        ytPlayer.getVideoData?.()?.video_id !== state.source.videoId || m.paused || m.ended || m.buffering ||
        !Number.isFinite(m.rate) || Math.abs(m.rate - c.rate) > .01) return 'host-source-ineligible';
    const age = Date.now() - m.sampledAt;
    if (!Number.isFinite(age) || age < 0 || age > 750) return 'host-source-stale';
    const source = m.currentTime + age * m.rate / 1000;
    if (!Number.isFinite(source) || !Number.isFinite(target) || Math.abs(source-target)*1000 > 35) return 'host-source-disagrees';
    return null;
  }
  function singleRecoveryWitness({observedPeer:peer, reference, sourceVerified}) {
    return sourceVerified && reference === 'linked-tab' && peer?.observeOnly && peer.count === 1 &&
      !!peer.member && peer.clockWitness === true &&
      Math.abs(peer.offsetMs) <= 50 ? peer : null;
  }
  function learnRelease(residual,correction,model){
    if(!correction?.hostLinked||!correction.releaseVerified||
       !Number.isFinite(correction.releaseLeadSec)||!Number.isFinite(correction.baseRate)||
       correction.baseRate<=0||!Number.isFinite(residual))return false;
    // From rejoin-probe: measured start delay = release lead + resumed error.
    // Only an advancing, stable, verified post-release sample can teach us.
    const measured=(correction.releaseLeadSec+residual)/correction.baseRate;
    if(measured<-.025||measured>1.2)return false;
    const next=clamp(measured,0,.9),prior=model.hostReleaseLatencySec;
    model.hostReleaseLatencySec=Number.isFinite(prior)&&prior>=0
      ? clamp(prior*.35+next*.65,0,.9) : next;
    return true;
  }
  function create() {
    let blocked = '', fineHolds = 0, holdReason = '', candidate = null, nextHoldAt = 0;
    function verifyHold(c, error, verified) {
      if (c?.cause !== 'host-fine') return;
      const improved = verified && Math.abs(error) <= Math.abs(c.before) * .7;
      if (!improved) fineHolds = 2;
      window.watchFusionRoomSyncLog?.note?.('host-hold-result', {
        reason:!verified ? 'unverified' : improved ? 'improved' : 'no-progress',
        beforeMs:Math.round(c.before*1000), residualMs:Math.round(error*1000)});
    }
    function fineHold(error,io,model){
      const now = io.now();
      holdReason = '';
      if (!io.hostLinked || io.background?.() || error >= -.10 || error < -2.5) { candidate = null; return false; }
      const holdMs = (-error/io.baseRate - releaseLatency(io,model))*1000;
      holdReason = (io.hostHoldBlocker ? io.hostHoldBlocker() : io.hostFineHoldTrusted?.() ? null : 'host-source-unverified') ||
        (blocked ? 'host-auto-seek-guarded' : fineHolds >= 2 ? 'host-hold-budget-used'
        : now < nextHoldAt ? 'host-hold-cooldown'
        : !model.hostReleaseMeasured || !Number.isFinite(model.hostReleaseLatencySec) ? 'host-release-unmeasured'
        : holdMs < 80 ? 'host-hold-too-short' : '');
      if (holdReason) { candidate = null; return false; }
      if (!candidate || now - candidate.last > 800 || Math.abs(error - candidate.error) > .035) {
        candidate = {since:now, last:now, error};
      }
      candidate.last = now;
      if (now - candidate.since < 1600) { holdReason = 'host-hold-observing'; return false; }
      fineHolds++; nextHoldAt = now + 12000; candidate = null;
      window.watchFusionRoomSyncLog?.note?.('host-hold-started', {errorMs:Math.round(error*1000),
        holdMs:Math.round(holdMs), startLatencyMs:Math.round(model.hostReleaseLatencySec*1000), attempts:fineHolds});
      return true;
    }
    function timeout(job) {
      if (job?.hostLinked && job.why !== 'manual') blocked = 'landing-timeout';
    }
    function landing(job, nowMs, landingError) {
      const tolerance = job.hostLinked && job.why === 'host-peer' ? .35 : SAFE_LANDING_SEC;
      if (!job.hostLinked || Math.abs(landingError) <= tolerance) {
        job.landedAt = -1; return 'pass';
      }
      if (!Number.isFinite(job.landedAt) || job.landedAt < 0) job.landedAt = nowMs;
      if (nowMs - job.landedAt < LANDING_WAIT_MS) return 'wait';
      blocked = 'unverified-landing'; return 'reject';
    }
    function blockRejoin(why, io, nowMs) {
      if (why === 'manual') { blocked = ''; return false; }
      if (!io.hostLinked || !['host-source', 'host-peer'].includes(why)) return false;
      const error = Number(io.target(nowMs)) - Number(io.current());
      const min = why === 'host-peer' ? .17 : MIN_HOST_REJOIN_SEC;
      return !!blocked || !Number.isFinite(error) || Math.abs(error) < min;
    }
    return { timeout, landing, blockRejoin, releaseLatency, learnRelease, fineHold, verifyHold, get holdReason() { return holdReason; },
      reset: () => { blocked = ''; fineHolds = 0; holdReason = ''; candidate = null; nextHoldAt = 0; },
      get blocked() { return blocked; } };
  }
  globalThis.WatchFusionHostSeekPolicy = {create, sourceBlocker, singleRecoveryWitness, MIN_HOST_REJOIN_MS:Math.round(MIN_HOST_REJOIN_SEC*1000)};
})();
