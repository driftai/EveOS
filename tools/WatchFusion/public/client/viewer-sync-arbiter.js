/* Owns automatic seeks, rates and holds for one YouTube viewer.
 * Error is target minus advancing player position, in seconds of media time.
 * A rejoin seeks ahead, waits for the keyframe landing and schedules release
 * against the room clock. Device release and rate models persist across tracks.
 */
(() => {
  'use strict';
  const MODEL_KEY = 'watchfusion.viewerSyncModel.v1';
  const MONITOR_SEC = .05, ACTION_SEC = .10, MAX_AUTO_SEC = 30, EPS_SEC = .0005; // EPS: 100.0 ms is still 100
  const ZERO_SERVO_SEC = .05, ZERO_SERVO_COOLDOWN_MS = 2400; // v13.10.7: act on >100 ms sooner
  const MIN_FINE_ACTUATION_SEC = .45;
  const PLATEAU_MIN_SEC = .10, PLATEAU_DWELL_MS = 5000, PLATEAU_QUIET_STALL_MS = 15000;
  const WINDOW_MS = 2200, MIN_SAMPLES = 6, MIN_SPAN_MS = 1400, MAX_SPREAD_SEC = .35;
  const SETTLE_MS = 1000, LANDING_TIMEOUT_MS = 12000, RATE_PROBE_MS = 1600;
  const BACKOFF_MS = [3000, 6000, 12000, 24000];
  const MAX_FAILURES = 3, GROSS_SEC = 2, GROSS_MIN_SAMPLES = 3, GROSS_SPAN_MS = 500;
  // PLAYING-but-frozen recovery ladder (per segment), only after a freeze longer
  // than a slow TV cold start (SYNC-04): un-pause kick, buffered rejoin, network
  // rejoin, then stop. Beyond MAX_AUTO_SEC only a displacement observed steadily
  // for DISPLACED_MS earns one rejoin per segment.
  const STALL_MS = 6500, STALL_SPACING_MS = 4000, STALL_STEPS = 3, KICK_MS = 300, DISPLACED_MS = 4000;
  // Cold-start grace stays; only corroborated follow-up steps may advance faster.
  const RETRY_STALL_MS = 2750, RETRY_SPACING_MS = 2750, REJOIN_RECENCY_MS = 30000;
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const preservesRecovery = (kind, io) => (io?.follower === true || io?.hostLinked === true) && io.linkedSourceActive?.() === true && ['hydrate', 'reclaim', 'track-start'].includes(kind);
  const median = values => { const v = values.slice().sort((a, b) => a - b); return v.length ? v[Math.floor(v.length / 2)] : 0; };
  function defaultModel() { return {releaseLatencySec: .25, hostReleaseLatencySec: null, leadSec: 1.5, landingErrorSec: 0, landingSec: .5, rateHonored: null, rateGain: 1, rejoins: 0, verifiedReleases: 0}; }
  function createViewerSyncArbiter({store = null, timers = globalThis} = {}) {
    let model = load();
    let scope = '', phase = 'observe', samples = [], last = null, reason = 'idle', job = null;
    let lockedAt = -1, locked = false, failures = 0, cooldownUntil = 0, lastCorrection = null;
    let acquiredAt = -1, firstFineLockAt = -1, lastTickAt = -1, healthySince = -1, healthyRearms = 0;
    let held = {value: null, since: 0};
    let stall = {steps: 0, at: -Infinity}, displaced = null, displacedRejoins = 0;
    let lastAutomaticRejoinReleaseAt = -Infinity, lastStallSeenAt = -Infinity, backgroundSeekKey = ''; const videoScope = value => String(value).split(':').slice(0,3).join(':');
    const releaseEvidence = globalThis.WatchFusionReleaseEvidence?.createReleaseEvidence?.();
    const sourceRecoveryGate = globalThis.WatchFusionReleaseEvidence?.createSourceRecoveryGate?.(); const fineGate = globalThis.WatchFusionReleaseEvidence?.createFixedRateFineGate?.(); const plateauGate = globalThis.WatchFusionReleaseEvidence?.createFixedRatePlateauRecoveryGate?.();
    const tvOwner=globalThis.WatchFusionReleaseEvidence?.tvRecoveryOwner, rateRecheck=globalThis.WatchFusionReleaseEvidence?.createTvRateRecheckGate?.();
    const lateReleaseRetry = globalThis.WatchFusionReleaseEvidence?.createLateReleaseRetryGate?.();
    let plateau = null, plateauSpent = false, lastZeroServoAt = -Infinity;
    const stats = {corrections: 0, rejoins: 0, holds: 0, rateBursts: 0, seeks: 0, failures: 0, rateRejected: 0}; const hostGuard = globalThis.WatchFusionHostSeekPolicy?.create?.() ?? null;
    function load() {
      try {
        const m = {...defaultModel(), ...(JSON.parse(store?.get?.(MODEL_KEY) || 'null') || {})};
        // v13.7: a pre-v13.7 rejection may come from one probe taken during a decoder freeze. Re-probe once.
        if (m.rateHonored === false && !(m.rateRejections >= 2)) m.rateHonored = null;
        return m;
      } catch { return defaultModel(); }
    }
    function save() { try { store?.set?.(MODEL_KEY, JSON.stringify(model)); } catch {} }
    function cancelJob(io, restoreRate = true) {
      if (job?.timer) timers.clearTimeout(job.timer);
      const wasRate = job?.kind === 'rate';
      job = null;
      if (restoreRate && wasRate && io) io.rate(io.baseRate);
    }
    function reset(next = '', why = 'scope-change', io = null) {
      cancelJob(io);releaseEvidence?.reset();sourceRecoveryGate?.cancelCandidate();fineGate?.cancelCandidate();plateauGate?.cancelCandidate();
      if(videoScope(next)!==videoScope(scope))backgroundSeekKey=''; scope = next; phase = 'observe'; samples = []; last = null; reason = why;
      locked = false; lockedAt = -1; failures = 0; cooldownUntil = 0; lastCorrection = null;
      acquiredAt = firstFineLockAt = lastTickAt = healthySince = -1; lastZeroServoAt = -Infinity; healthyRearms = 0;
      rearm(); hostGuard?.reset();
    }
    function rearm() {
      stall = {steps: 0, at: -Infinity}; displaced = null; displacedRejoins = 0; plateau = null; plateauSpent = false;
      lastAutomaticRejoinReleaseAt = lastStallSeenAt = -Infinity;
    }
    function intent(kind, io = null) {
      cancelJob(io);releaseEvidence?.reset();sourceRecoveryGate?.cancelCandidate();fineGate?.cancelCandidate();plateauGate?.cancelCandidate();
      phase = 'observe'; samples = []; last = null; locked = false; healthySince = -1; reason = 'intent-' + kind;
      if (kind !== 'pause' && !preservesRecovery(kind, io)) { failures = 0; cooldownUntil = 0; rearm(); }
    }
    function owns() { return !!job; }
    function observePosition(nowMs, value) { held = globalThis.WatchFusionTimelineMath.observePosition(nowMs,value,held); }
    function projected(nowMs, value, baseRate) { observePosition(nowMs,value); return globalThis.WatchFusionTimelineMath.projectedPosition(nowMs,value,baseRate,held); }
    function sample(nowMs, current, target, baseRate) {
      const drift = target - current;
      let note = 'observing';
      // A long gap (warming, a held tab) makes the previous sample stale, not a reference move.
      if (last && nowMs - last.nowMs > 1000) { samples = []; last = null; }
      if (last) {
        const dt = (nowMs - last.nowMs) / 1000;
        const expectedTarget = last.target + dt * baseRate;
        // The room reference moved (rebase, reference promotion): re-observe, never chase.
        if (Math.abs(target - expectedTarget) > .08) { samples = []; note = 'reference-moved-reobserve'; }
        const advanced = current - last.current;
        // Coarse TV clocks may repeat a value for one tick; never trust >1.8x progress.
        if (dt > 0 && (advanced < -.05 || advanced > dt * baseRate * 1.8 + .3)) { samples = []; note = 'discontinuous-player-position'; }
      }
      last = {nowMs, current, target};
      samples.push({nowMs, drift, current});
      samples = samples.filter(item => nowMs - item.nowMs <= WINDOW_MS);
      const spanMs = samples.at(-1).nowMs - samples[0].nowMs;
      // A gross, consistent displacement (seconds off) needs less evidence than a fine one.
      const gross = samples.length >= GROSS_MIN_SAMPLES && spanMs >= GROSS_SPAN_MS
        && samples.every(item => Math.abs(item.drift) > GROSS_SEC && Math.sign(item.drift) === Math.sign(drift));
      if (!gross && (samples.length < MIN_SAMPLES || spanMs < MIN_SPAN_MS)) { reason = note; return null; }
      // Require real progress across the window: PLAYING without moving frames is not evidence.
      const progress = samples.at(-1).current - samples[0].current;
      const span = (samples.at(-1).nowMs - samples[0].nowMs) / 1000;
      if (progress < span * baseRate * .5) { reason = 'playing-without-progress'; return null; }
      const values = samples.map(item => item.drift);
      const spread = Math.max(...values) - Math.min(...values);
      // Subsecond fine corrections require a tighter phase distribution than gross recovery.
      const spreadLimit = Math.abs(median(values)) <= .45 ? .12 : MAX_SPREAD_SEC;
      if (spread > spreadLimit) { reason = 'unstable-phase'; return null; }
      return median(values);
    }
    function rateFor(io, error) { return io.hostLinked&&io.background?.()&&!io.hostFineHoldTrusted?.()?null:globalThis.WatchFusionTimelineMath.chooseRate(io,error,model.rateHonored); }
    function begin(kind, nowMs, error, io, extra = {}) {
      stats.corrections++; lastCorrection = {kind, before: error, at: nowMs};
      phase = kind; samples = []; last = null; locked = false; healthySince = -1;
      job = {kind, startedAt: nowMs, before: error, valid:io.valid, ...extra}; releaseEvidence?.reset();
      reason = kind + '-started';
    }
    function finish(nowMs, why) {
      if (job?.timer) timers.clearTimeout(job.timer); job = null; phase = 'verify'; samples = []; last = null; reason = why;
      cooldownUntil = Math.max(cooldownUntil, nowMs + SETTLE_MS);
    }
    function startRate(nowMs, error, io, rate, recheck = false) {
      const effective = Math.abs(rate - io.baseRate) * clamp(model.rateGain, .5, 1.5);
      const durationMs = clamp(Math.abs(error) / effective * 1000, Math.abs(error) <= ACTION_SEC ? 120 : 300, Math.abs(error) <= ACTION_SEC ? 600 : 12000);
      begin('rate', nowMs, error, io, {rate, durationMs, recheck, probe: {nowMs, current: io.current()}});
      stats.rateBursts++; io.rate(rate);
      job.dueAt = nowMs + durationMs; const jobToken = job;
      job.timer = timers.setTimeout(() => completeTimed(jobToken, io, 'rate-burst-complete'), durationMs);
    }
    function probeRate(io) {
      if(job?.kind!=='rate'||job.rateVerdict)return job?.rateVerdict;
      const verdict=globalThis.WatchFusionReleaseEvidence?.classifyRateProbe?.(job,io,io.now())||'unverified';
      if(verdict==='unverified'){reason='rate-evidence-inconclusive';return;}
      job.rateVerdict=verdict;
      if(verdict==='honored'){model.rateHonored=true;model.rateRejections=0;reason='rate-capability-confirmed';}
      else {model.rateRejections=(model.rateRejections||0)+1;if(model.rateRejections>=2)model.rateHonored=false;stats.rateRejected++;reason='rate-capability-not-honored';}
      save();
      return verdict;
    }
    function endRate(io, braked = false) {
      if (job?.kind !== 'rate') return;
      const verdict = probeRate(io), rejectedTrial = verdict==='rejected' && job.recheck;
      if (job.recheck) rateRecheck?.settle(scope, verdict, job, io);
      io.rate(io.baseRate); if (braked && lastCorrection) lastCorrection.rateBraked=true;
      finish(io.now(), rejectedTrial ? 'rate-capability-not-honored' : braked ? 'rate-phase-braked' : 'rate-burst-complete');
      if (rejectedTrial) phase = 'observe';
    }
    function startHold(nowMs, error, io) {
      // Device ahead: freeze for the lead, release early by the learned start latency.
      const releaseLatency = hostGuard?.releaseLatency(io,model) ?? model.releaseLatencySec;
      const holdMs = Math.max(0, (-error / io.baseRate - releaseLatency) * 1000);
      begin('hold', nowMs, error, io, {hostLinked:!!io.hostLinked});
      stats.holds++; io.pause();
      job.dueAt = nowMs + holdMs;
      const jobToken = job; job.timer = timers.setTimeout(() => completeTimed(jobToken, io, 'hold-released'), holdMs);
    }
    function startRejoin(nowMs, error, io, why = 'rejoin', network = false, retryLatency = null) {
      if(retryLatency === null && tvOwner?.block(io.tvIdentity,nowMs,error,why,io)){reason='tv-post-release-duplicate-blocked';return false;}
      if (io.hostLinked && io.background?.() && why !== 'manual') {
        if (backgroundSeekKey === videoScope(scope) || error < .70 || !io.hostFineHoldTrusted?.() || io.sourceBuffering?.() || io.state() !== 1) { reason='host-background-rejoin-unqualified'; return false; }
        backgroundSeekKey=videoScope(scope); begin('rejoin',nowMs,error,io,{why}); stats.rejoins++; stats.seeks++; io.seek(io.target(nowMs)+Math.min(.35,hostGuard?.releaseLatency(io,model)??.25),!io.buffered(io.target(nowMs))); window.WatchFusionRejoinProbe?.reset?.(); window.watchFusionRoomSyncLog?.note?.('host-background-direct-rejoin',{errorMs:Math.round(error*1000)}); finish(nowMs,'host-background-direct-rejoin'); lastCorrection=null; lastAutomaticRejoinReleaseAt=nowMs; return true;
      }
      const lead = clamp(model.leadSec + (retryLatency === null ? 0 : Math.max(0, retryLatency - model.releaseLatencySec) * io.baseRate), .35, io.hostLinked ? 2.5 : 10);
      if (why === 'rejoin' && globalThis.WatchFusionDecoderRescue?.allowAutomaticRejoin?.({nowMs,error,io,lead}) === false) { reason='tv-decoder-rejoin-guarded'; return false; }
      const requested = io.target(nowMs) + lead;
      if (retryLatency !== null && !io.buffered(requested)) { reason = 'late-release-unbuffered'; return false; }
      begin('rejoin', nowMs, error, io, {requested, lead, why, retryLatency, hostLinked: !!io.hostLinked, landedAt: -1, stableReads: 0, landed: null});
      stats.rejoins++; stats.seeks++; model.rejoins++; io.pause();
      io.seek(requested, retryLatency === null && (network || !io.buffered(requested)));
      return true;
    }
    function completeTimed(expected, io, why) {
      const verdict = globalThis.WatchFusionReleaseEvidence?.timedCompletion(expected, job, io) ?? 'on-time';
      if (verdict === 'stale') { if (job === expected) { cancelJob(null); phase='observe'; samples=[]; last=null; reason='correction-context-expired'; } return; }
      if (verdict === 'late') { if (job.kind === 'rate') { if(job.recheck)rateRecheck?.settle(scope,job.rateVerdict,job,io); io.rate(io.baseRate); finish(io.now(),'rate-deadline-missed'); lastCorrection=null; } else release(io,'release-deadline-missed'); failures++;stats.failures++;cooldownUntil=Math.max(cooldownUntil,io.now()+BACKOFF_MS[Math.min(BACKOFF_MS.length-1,failures-1)]); window.watchFusionRoomSyncLog?.note?.('correction-deadline-missed',{reason:why,durationMs:Math.round(io.now()-expected.dueAt)}); return; }
      if (job.kind === 'rate') endRate(io); else release(io,why);
    }
    function release(io, why) {
      if (!job) return;
      const jobWhy = job.why;
      const automaticRejoin = job.kind === 'rejoin' && jobWhy !== 'manual';
      const hostLanding = job.hostLinked && (why === 'rejoin-released' || why === 'hold-released')
        ? {hostLinked:true, releaseVerified:true, sourceVerified:io.hostFineHoldTrusted?.() === true, releaseLeadSec:io.current()-io.target(io.now()), baseRate:io.baseRate} : {};
      const scheduled = why === 'rejoin-released' || why === 'hold-released';
      const kind = scheduled ? job.kind : 'unscheduled';
      const automaticRelease = why === 'rejoin-released' && automaticRejoin &&
        job.retryLatency === null && io.follower === true && io.state() !== 3 && io.sourceReferenceQualified?.() === true;
      const releasedAt = io.now(), releaseTarget = automaticRelease ? io.target(releasedAt) : null;
      const releaseLeadSec = automaticRelease ? io.current() - releaseTarget : null;
      io.play(); finish(io.now(), why);
      lastCorrection = {...lastCorrection, kind, releasedAt, releaseTarget, releaseLeadSec, why:jobWhy,
        automaticRelease, releaseVerified:scheduled && kind === 'rejoin', ...hostLanding};
      if ((automaticRejoin || hostLanding.sourceVerified) && scheduled) releaseEvidence?.start(lastCorrection.releasedAt);
      else releaseEvidence?.reset();
      if (automaticRejoin) {lastAutomaticRejoinReleaseAt = io.now();if(scheduled)tvOwner?.release(io.tvIdentity,lastAutomaticRejoinReleaseAt);}
    }
    function superviseRejoin(nowMs, io) {
      const state = io.state();
      if (nowMs - job.startedAt > LANDING_TIMEOUT_MS) {
        hostGuard?.timeout(job); failures++; stats.failures++;
        release(io, 'landing-timeout-released');
        cooldownUntil = nowMs + BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, failures - 1)];
        return;
      }
      if (state === 3) { job.stableReads = 0; reason = 'rejoin-awaiting-landing'; return; }
      if (state === 1) io.pause();
      const position = io.current();
      if (job.landed !== null && Math.abs(position - job.landed) < .02) job.stableReads++;
      else { job.landed = position; job.stableReads = 0; job.landedAt = -1; }
      if (job.stableReads < 1 || job.dueAt !== undefined) return;
      const landed = job.landed, landingError = job.requested - landed;
      const trust = hostGuard?.landing(job, nowMs, landingError) ?? (job.hostLinked ? 'reject' : 'pass');
      if (trust !== 'pass') { if (trust === 'wait') reason = 'rejoin-awaiting-credible-landing'; else { failures++; stats.failures++; release(io, 'rejoin-landing-unverified'); } return; }
      // Keep the worst recent keyframe snap and landing time: the lead must cover
      // the snap, the room time that passes while landing, and the release latency.
      model.landingErrorSec = clamp(Math.max(model.landingErrorSec * .97, landingError), 0, 6);
      model.landingSec = clamp(Math.max(model.landingSec * .9, (nowMs - job.startedAt) / 1000), .1, 8);
      const modelLatency = hostGuard?.releaseLatency(io,model) ?? model.releaseLatencySec;
      const releaseLatency = job.retryLatency ?? modelLatency;
      const needed = () => model.landingErrorSec + model.landingSec * io.baseRate + modelLatency * io.baseRate + .3;
      const waitMs = ((landed - io.target(nowMs)) / io.baseRate - releaseLatency) * 1000;
      if (waitMs < 60) {
        // Landed behind the room: the lead was too short for this player's keyframes.
        model.leadSec = clamp(Math.max(model.leadSec + .5, needed()), .35, 10);
        save();
        release(io, 'rejoin-landed-short');
        return;
      }
      model.leadSec = clamp(needed(), .35, 10); save();
      reason = 'rejoin-scheduled-release';
      job.dueAt = nowMs + waitMs;
      const jobToken = job; job.timer = timers.setTimeout(() => completeTimed(jobToken, io, 'rejoin-released'), waitMs);
    }
    function superviseRate(nowMs, io) {
      if (io.state() !== 1 || (job.recheck && (io.sourceReferenceQualified?.(100) !== true || io.sourceBuffering?.() || io.mirrorContradicted?.()))) {
        if (job.recheck) rateRecheck?.settle(scope, job.rateVerdict, job, io);
        cancelJob(io); phase = 'observe'; samples = []; reason = 'rate-burst-interrupted'; return;
      }
      if (!job.rateVerdict && nowMs-job.probe.nowMs>=Math.min(RATE_PROBE_MS,Math.max(600,job.durationMs*.75)) &&
          probeRate(io)==='rejected' && job.recheck) {
        endRate(io); return;
      }
      if (globalThis.WatchFusionReleaseEvidence?.viewerRateBrake?.(job,io,nowMs)) {endRate(io,true);return;} if(!job.rateVerdict)reason='rate-evidence-inconclusive';
    }
    function learn(residual,io,nowMs) {
      const c = lastCorrection;
      if (!c) return;
      if ((c.kind === 'rejoin' || c.kind === 'hold') && c.hostLinked) {
        if (c.sourceVerified && io.hostFineHoldTrusted?.() && releaseEvidence?.qualified(c,nowMs) && hostGuard?.learnRelease(residual,c,model)) { model.hostReleaseMeasured = true; save(); }
        return; // never teach the legacy/TV decoder model from a linked-host correction
      }
      if (c.kind === 'rejoin' && c.releaseVerified && Number.isFinite(c.releasedAt) && nowMs-c.releasedAt >= 1200 && ((!c.automaticRelease && lastStallSeenAt < c.releasedAt) || releaseEvidence?.qualified(c,nowMs)===true) && io.referenceTrusted?.() === true && io.referenceUncertaintyMs?.() != null && Number.isFinite(io.referenceUncertaintyMs()) && io.referenceUncertaintyMs() <= 100 && Math.abs(residual) < .6) {
        model.releaseLatencySec = clamp(model.releaseLatencySec + clamp(residual * .35, -.06, .06), 0, 2); model.verifiedReleases = Math.min(100000,(model.verifiedReleases||0)+1); } else if (c.kind === 'hold' && c.cause !== 'source-recovery' && c.cause !== 'fine-lead' && Math.abs(residual) < 1.2) { model.releaseLatencySec = clamp(model.releaseLatencySec + residual * .8, 0, 2);
      } else if (c.kind === 'rate' && !c.rateBraked && Math.abs(c.before) > .05) {
        const achieved = (c.before - residual) / c.before;
        if (achieved > .2) model.rateGain = clamp(model.rateGain * achieved, .5, 1.5);
      }
      save();
    }
    function fixedRateFine(nowMs,error,io) {
      const input = {scope,nowMs,error,io,verifiedFixed:model.rateHonored===false && model.rateRejections>=2};
      const action = fineGate?.refine(input,model,lastStallSeenAt,save,d => window.watchFusionRoomSyncLog?.note?.('tv-next-release-model-adjusted',d));
      if (action === 'learn') reason='fine-lead-model-refined-no-actuation';
      return action;
    }
    function decide(nowMs, error, io) {
      const absolute = Math.abs(error);
      if (phase === 'verify') {
        const before = lastCorrection?.before ?? error;
        hostGuard?.verifyHold(lastCorrection,error,releaseEvidence?.qualified(lastCorrection||{},nowMs) && io.hostFineHoldTrusted?.());
        phase = 'observe';
        // v13.7: a freeze after landing says nothing about the correction: no learning, no backoff.
        const voided = lastStallSeenAt >= (lastCorrection?.releasedAt ?? Infinity) && !(releaseEvidence?.qualified(lastCorrection||{},nowMs)===true);
        if (voided) reason = 'correction-voided-by-decoder-stall'; else if(io.referenceTrusted?.()!==true||io.sourceBuffering?.()===true||io.mirrorContradicted?.()===true) reason='release-learning-reference-unverified'; else learn(error,io,nowMs);
        if (Math.abs(error) <= ACTION_SEC + EPS_SEC) { failures = 0; }
        else if (!voided && lastCorrection?.kind !== 'unscheduled' && Math.abs(error) > Math.abs(before) * .7) {
          failures++; stats.failures++;
          cooldownUntil = nowMs + BACKOFF_MS[Math.min(BACKOFF_MS.length - 1, failures - 1)];
          reason = 'correction-did-not-improve-backoff';
          return;
        }
      }
      if (io.mirrorContradicted?.()) {
        rateRecheck?.observeLock(scope,nowMs,NaN,io); locked = false; healthySince = -1; reason = io.hostLinked ? 'host-mirror-contradicted' : 'mirror-contradicted';
        if (!io.hostLinked && failures < MAX_FAILURES && nowMs >= cooldownUntil) fixedRateFine(nowMs,error,io);
        return;
      }
      rateRecheck?.observeLock(scope,nowMs,error,io); if (absolute <= MONITOR_SEC + EPS_SEC) { if (healthySince < 0) healthySince = nowMs;
        if (!locked) lockedAt = nowMs;
        if (firstFineLockAt < 0) firstFineLockAt = nowMs;
        locked = true; if (failures && nowMs - healthySince >= 15000 && io.referenceTrusted?.() === true && !io.sourceBuffering?.() && nowMs - lastStallSeenAt >= 15000) { failures = 0; cooldownUntil = Math.min(cooldownUntil, nowMs); healthyRearms++; reason = 'locked-failure-rearmed'; } else reason = 'locked'; return;
      }
      healthySince = -1; locked = false; if (absolute <= ACTION_SEC + EPS_SEC) {
        const precision = Number(io.referenceUncertaintyMs?.());
        if (absolute >= ZERO_SERVO_SEC && model.rateHonored !== false && io.referenceTrusted?.() === true
            && precision >= 0 && precision < absolute * 1000 && nowMs - lastZeroServoAt >= ZERO_SERVO_COOLDOWN_MS) {
          const gentleRate = rateFor(io, error);
          if (gentleRate !== null) { lastZeroServoAt = nowMs; startRate(nowMs, error, io, gentleRate); return; }
        }
        reason = 'fine-drift-refining'; return;
      }
      locked = false;
      const uncertaintyMs = Number(io.referenceUncertaintyMs?.());
      if (uncertaintyMs > 0 && Number.isFinite(uncertaintyMs)
          && absolute * 1000 <= Math.max(100, uncertaintyMs * 1.2)) {
        const soft = nowMs - lastZeroServoAt >= ZERO_SERVO_COOLDOWN_MS ? rateFor(io, error) : null;
        if (soft !== null) { lastZeroServoAt = nowMs; return startRate(nowMs, error, io, soft); }
        reason = 'fine-drift-below-reference-precision'; return;
      }
      if (failures >= MAX_FAILURES) { phase = 'suspended'; reason = 'auto-correction-suspended'; return; }
      if (nowMs < cooldownUntil) { reason = 'correction-cooldown'; return; }
      if (absolute > MAX_AUTO_SEC) {
        // One large displacement rejoin per segment requires a trusted reference.
        if (!io.referenceTrusted?.()) { displaced = null; reason = 'displacement-unverified-reference'; return; }
        if (!displaced || Math.sign(displaced.error) !== Math.sign(error) || Math.abs(displaced.error - error) > 1) displaced = {since: nowMs, error};
        if (displacedRejoins >= 1 || nowMs - displaced.since < DISPLACED_MS) { reason = 'displacement-needs-transport-seek'; return; }
        displacedRejoins++; displaced = null;
        return startRejoin(nowMs, error, io, 'displacement', true);
      }
      displaced = null;
      if (absolute < MIN_FINE_ACTUATION_SEC && !io.referenceTrusted?.()) {
        reason = 'fine-drift-unverified-source'; return;
      }
      const rate = absolute <= 2.5 ? rateFor(io, error) : null;
      if (rate !== null) return startRate(nowMs, error, io, rate);
      if(io.hostLinked&&io.background?.()&&error<0){reason='host-background-hold-deferred';return;} if (hostGuard?.fineHold(error,io,model)) { startHold(nowMs,error,io); lastCorrection.cause = 'host-fine'; return; }
      if (io.hostLinked && (!hostGuard || hostGuard.blocked || absolute < .70)) { reason = hostGuard?.holdReason || (hostGuard?.blocked || !hostGuard ? 'host-auto-seek-guarded' : 'host-subsecond-preserved'); return; }
      const sourceHold=sourceRecoveryGate?.consider({scope,nowMs,error,io}) === true;
      const fine = !sourceHold && fixedRateFine(nowMs,error,io);
      if (fine === 'learn') return;
      if (sourceHold || fine === 'hold') {
        startHold(nowMs,error,io);if(lastCorrection)lastCorrection.cause=sourceHold?'source-recovery':'fine-lead';reason=sourceHold?'source-recovery-qualified-hold':'fine-lead-qualified-hold';return;
      }
      const quietStallMs=nowMs-lastStallSeenAt,quietRejoinMs=nowMs-lastAutomaticRejoinReleaseAt;
      if (!io.speakerPhaseVerified?.()) {
        const trial=rateRecheck?.consider({scope,nowMs,error,io,rateHonored:model.rateHonored,quietStallMs,quietRejoinMs});
        if (trial?.rate) return startRate(nowMs,error,io,trial.rate,true);
        if (absolute >= MIN_FINE_ACTUATION_SEC && rateRecheck?.snapshot()?.watching) { reason = rateRecheck.snapshot().reason==='rate-trial-awaiting-qualified-reference'?'tv-rate-trial-awaiting-reference':'tv-rate-trial-dwell'; return; }
      }
      if (absolute < MIN_FINE_ACTUATION_SEC) {
        if (!io.speakerPhaseVerified?.()) {
          plateau=null;const p=plateauGate?.consider({scope,nowMs,error,io,quietStallMs,quietRejoinMs,leadSec:model.leadSec,verifiedFixed:model.rateHonored===false && model.rateRejections>=2});
          if(p?.action==='rejoin'){reason='tv-healthy-plateau-no-speaker-proof';return;}
          const trialReason=rateRecheck?.snapshot()?.reason;reason=({'no-advertised-rate-actuator':'tv-no-advertised-fine-rate','per-video-trial-spent':'tv-rate-trial-spent','stable-rate-trial-dwell':'tv-rate-trial-dwell','rate-trial-awaiting-qualified-reference':'tv-rate-trial-awaiting-reference','rate-trial-quiet-time':'tv-rate-trial-awaiting-quiet','rate-trial-precision':'tv-rate-trial-awaiting-precision','rate-trial-motion':'tv-rate-trial-awaiting-motion'})[trialReason]||'output-phase-unverified';return;
        }
        if (absolute <= PLATEAU_MIN_SEC + EPS_SEC || plateauSpent || !io.referenceTrusted?.() || (uncertaintyMs > 0 && absolute * 1000 - uncertaintyMs <= 50)) { plateau = null; reason = 'fine-drift-awaiting-capability'; return; }
        if (!plateau || Math.sign(plateau.error) !== Math.sign(error) || Math.abs(plateau.error - error) > .08) plateau = {since: nowMs, error};
        if (nowMs - plateau.since < PLATEAU_DWELL_MS || nowMs - lastStallSeenAt < PLATEAU_QUIET_STALL_MS) { reason = 'fine-drift-awaiting-capability'; return; }
        plateau = null; plateauSpent = true;
        return startRejoin(nowMs, error, io, 'plateau');
      }
      if (lastCorrection?.why === 'late-release-retry' && absolute <= 2.5) { reason = 'late-release-retry-spent'; return; }
      if (error < 0 && absolute <= 4) return startHold(nowMs, error, io);
      const retry = releaseEvidence?.canRetry(lastCorrection) && lateReleaseRetry?.consider({scope,nowMs,error,io,correction:lastCorrection});
      if (Number.isFinite(retry)) {
        if (startRejoin(nowMs,error,io,'late-release-retry',false,retry)) { lateReleaseRetry.spend(scope); reason = 'late-release-retry-started'; }
        return;
      }
      return startRejoin(nowMs, error, io);
    }
    function tick(next, nowMs, io) {
      if (next !== scope) reset(next, 'scope-change', io);
      if (acquiredAt < 0) acquiredAt = nowMs;
      lastTickAt = nowMs;
      if (job?.dueAt !== undefined && nowMs >= job.dueAt) {
        completeTimed(job, io, job.kind === 'kick' ? 'stall-kick-released' : job.kind + '-released');
      }
      if (job?.valid?.() === false) { cancelJob(null); phase='observe'; samples=[]; last=null; reason='correction-context-expired'; }
      if (job?.kind === 'rejoin' && job.dueAt === undefined) superviseRejoin(nowMs, io);
      else if (job?.kind === 'rate') superviseRate(nowMs, io);
      if (job) { rateRecheck?.observeLock(scope,nowMs,NaN,io); return {owned: true, reason, phase}; }
      const state = io.state();
      releaseEvidence?.observe(nowMs,io);
      if (state === 1 && io.sourceBuffering?.()) { rateRecheck?.observeLock(scope,nowMs,NaN,io); locked=false; healthySince = -1; samples = []; last = null; reason = 'source-buffering'; return {owned: false, reason, phase}; }
      if (state !== 1) { rateRecheck?.observeLock(scope,nowMs,NaN,io); locked=false; healthySince = -1; samples = []; last = null; reason = state === 3 ? 'buffering' : 'awaiting-playing'; return {owned: false, reason, phase}; }
      const current = projected(nowMs, io.current(), io.baseRate), target = io.target(nowMs);
      if (!Number.isFinite(current) || !Number.isFinite(target)) { rateRecheck?.observeLock(scope,nowMs,NaN,io); locked=false; healthySince = -1; reason = 'invalid-sample'; return {owned: false, reason, phase}; }
      if (phase === 'verify' && nowMs < cooldownUntil) { last = {nowMs, current, target}; return {owned: false, reason: 'settling', phase}; }
      const error = sample(nowMs, current, target, io.baseRate);
      if (error !== null) decide(nowMs, error, io); else { rateRecheck?.observeLock(scope,nowMs,NaN,io); healthySince = -1; }
      return {owned: !!job, reason, phase};
    }
    function rejoinNow(nowMs, io, why = 'manual') {
      if (stall.steps >= STALL_STEPS && preservesRecovery(why, io)) { reason = 'stall-recovery-exhausted'; return false; }
      const requestedError=io.target(nowMs)-projected(nowMs,io.current(),io.baseRate);
      if(io.hostLinked&&io.background?.()&&why!=='manual'&&requestedError<0){reason='host-background-hold-deferred';return false;} if(tvOwner?.block(io.tvIdentity,nowMs,requestedError,why,io)){reason='tv-post-release-duplicate-blocked';return false;}
      if (io.hostLinked && (hostGuard?.blockRejoin(why, io, nowMs) ?? why !== 'manual')) { reason = 'host-auto-seek-guarded'; return false; }
      intent(why, io);
      const error = io.target(nowMs) - projected(nowMs, io.current(), io.baseRate);
      if (Math.abs(error) <= ACTION_SEC + EPS_SEC && io.state() === 1) { reason = 'already-aligned'; return false; }
      // Observe small transport hops as ordinary drift.
      if ((why === 'transport' || why === 'reclaim') && Math.abs(error) <= 2.5) { reason = 'transport-hop-observe'; return false; }
      // A scrub reclaim is automatic: beyond MAX_AUTO_SEC it waits for a corroborated room (host transport and Sync me do not).
      if (why === 'reclaim' && Math.abs(error) > MAX_AUTO_SEC && !io.referenceTrusted?.()) { reason = 'reclaim-unverified-reference'; return false; }
      const rate = ['manual', 'host-source', 'host-peer'].includes(why) && Math.abs(error) <= 2.5 ? rateFor(io, error) : null;
      if (rate !== null) startRate(nowMs, error, io, rate);
      else if (error < 0 && Math.abs(error) <= 4) startHold(nowMs, error, io);
      else return startRejoin(nowMs, error, io, why);
      return true;
    }
    // Called while the startup gate reports PLAYING without movement. Bounded:
    // at most STALL_STEPS actions per segment, spaced, never while a job runs.
    function recoverStall(nowMs, io, stalledMs) {
      if (stalledMs > 0) lastStallSeenAt = nowMs;
      const corroborated = io.referenceTrusted?.() === true;
      const recentRejoin = nowMs >= lastAutomaticRejoinReleaseAt
        && nowMs - lastAutomaticRejoinReleaseAt <= REJOIN_RECENCY_MS;
      const retry = corroborated && (stall.steps > 0 || recentRejoin);
      const requiredStallMs = io.hostLinked && corroborated && !io.sourceBuffering?.() && stall.steps===0 ? 4500 : retry ? RETRY_STALL_MS : STALL_MS;
      const requiredSpacingMs = retry ? RETRY_SPACING_MS : STALL_SPACING_MS;
      if (job || io.state() !== 1 || !(stalledMs >= requiredStallMs)
          || nowMs - stall.at < requiredSpacingMs) return false;
      if (stall.steps >= STALL_STEPS || (io.hostLinked && io.background?.() && backgroundSeekKey===videoScope(scope))) { reason = 'stall-recovery-exhausted'; return false; }
      const error = io.target(nowMs) - io.current();
      // The kick never seeks; a rejoin beyond MAX_AUTO_SEC needs a corroborated target. Waiting costs no step.
      if (stall.steps >= 1 && Math.abs(error) > MAX_AUTO_SEC && !io.referenceTrusted?.()) { reason = 'stall-unverified-reference'; return false; }
      stall.steps++; stall.at = nowMs;
      if (stall.steps > 1 || (io.hostLinked && io.background?.())) { if (!startRejoin(nowMs,error,io,'stall',stall.steps>2)) { stall.steps--; return false; } return true; }
      begin('kick', nowMs, error, io); io.pause();
      job.dueAt = nowMs + KICK_MS;
      const jobToken = job; job.timer = timers.setTimeout(() => completeTimed(jobToken, io, 'stall-kick-released'), KICK_MS);
      reason = 'stall-kick';
      return true;
    }
    function snapshot() {
      return {postRelease:releaseEvidence?.snapshot(lastCorrection||{},lastTickAt) ?? null,sourceRecoveryHolds:sourceRecoveryGate?.count() ?? 0,fineLead:fineGate?.snapshot()??null,phasePlateau:plateauGate?.snapshot()??null,phase, reason,timelineErrorMs:last&&lastTickAt-last.nowMs<=600?Math.round((last.target-last.current)*1000):null,timelineObservedAtMs:last?.nowMs??null, healthyRearms, locked, lockedForMs: locked && lockedAt >= 0 ? Math.max(0, lastTickAt - lockedAt) : 0, failures,
        model: {releaseLatencyMs: Math.round(model.releaseLatencySec * 1000), effectiveHostReleaseLatencyMs: Math.round((hostGuard?.releaseLatency({hostLinked:true},model) ?? model.releaseLatencySec)*1000), verifiedReleases: model.verifiedReleases || 0, leadMs: Math.round(model.leadSec * 1000),
          landingErrorMs: Math.round(model.landingErrorSec * 1000), landingMs: Math.round(model.landingSec * 1000), rateHonored: model.rateHonored, rateGain: Math.round(model.rateGain * 100) / 100},
        ...stats, tolerancesMs: {monitor: 50, action: 100, outOfSync: 100},
        firstFineLockMs: firstFineLockAt >= 0 && acquiredAt >= 0 ? firstFineLockAt - acquiredAt : null,
        stallSteps: stall.steps, displacedRejoins, tvRecovery:tvOwner?.snapshot()??null, tvRateRecheck:rateRecheck?.snapshot()??null, hostSeekGuard: hostGuard?.blocked || null, owned: !!job};
    }

    return {tick, intent, reset, owns, rejoinNow, recoverStall, snapshot, observePosition, observeRelease:releaseEvidence?.observe, correcting: () => !!job};
  }

  globalThis.WatchFusionViewerSyncArbiter = {createViewerSyncArbiter, MODEL_KEY};
  globalThis.watchFusionViewerArbiter = createViewerSyncArbiter({
    store: typeof storage === 'object' ? storage : null,
    timers: {setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: id => clearTimeout(id)}
  });
})();
