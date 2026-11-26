(function(root){
  const PLAYING=1,PAUSED=2,BUFFERING=3;
  const MAX_SAMPLE_AGE_MS=2000;
  const MIRROR_DRIFT_SEC=0.75;
  const sourceDrift = createDriftSensor({ minAgeMs: 650, maxSpread: .09 });
  let lastMirrorSampleAt = 0;
  function relaySample(metadata, receivedAt, serverAt, receiverToleranceMs = null) {
    const sampledAt = Number(metadata.sampledAt);
    const sentAt = Number(metadata.publisherSentAt);
    const relayedAt = Number(metadata.relayReceivedAt);
    // Only subtract timestamps within one clock domain. An unmeasured
    // publisher-to-relay leg is left out when the publisher clock differs.
    const publisherAge = sentAt > 0 ? sentAt - sampledAt : receivedAt - sampledAt;
    if (!Number.isFinite(publisherAge)) return null;
    const hasRelayClock = relayedAt > 0 && Number.isFinite(serverAt);
    if (hasRelayClock && serverAt - relayedAt < -250) return null;
    const relayAge = sentAt > 0 && hasRelayClock ? Math.max(0, serverAt - relayedAt) : 0;
    if (!(sampledAt > 0) || publisherAge < 0 || publisherAge + relayAge > MAX_SAMPLE_AGE_MS) return null;
    const sameClockAge = receivedAt - sampledAt;
    const boundedAge = publisherAge + relayAge;
    const age = sentAt > 0 && sameClockAge >= boundedAge && sameClockAge <= MAX_SAMPLE_AGE_MS
      && sameClockAge - boundedAge <= 100 ? sameClockAge : boundedAge;
    // A qualified publisher clock includes the otherwise unmeasured publisher-to-relay leg.
    // Match the server coordinator's sample instant; never promote an impossible timestamp.
    const precise = Number.isFinite(receiverToleranceMs) && receiverToleranceMs >= 0 && receiverToleranceMs <= 45 &&
      Number.isFinite(serverAt) && Number.isFinite(metadata.serverSampledAt) && metadata.serverSampledAt > 0 &&
      Number.isFinite(metadata.uncertaintyMs) && metadata.uncertaintyMs >= 0 && metadata.uncertaintyMs <= 75 && hasRelayClock;
    if (precise) {
      const canonicalAge = serverAt - metadata.serverSampledAt, tolerance = receiverToleranceMs + metadata.uncertaintyMs;
      if (canonicalAge < 0 || canonicalAge > MAX_SAMPLE_AGE_MS || canonicalAge < boundedAge - tolerance ||
          relayedAt - metadata.serverSampledAt < -50 || relayedAt - metadata.serverSampledAt > 1500) return null;
      return {...metadata, sampledAt:receivedAt-canonicalAge, sampleClock:'server-qualified', relayAgeGapMs:Math.round(canonicalAge-age)};
    }
    return { ...metadata, sampledAt: receivedAt - age, sampleClock:'relay-bounded', relayAgeGapMs:null };
  }
  function createDriftSensor({ minAgeMs, maxSpread }) {
    let samples = [];
    function reset() { samples = []; }
    function sample(drift, at) {
      if (samples.length && (at <= samples.at(-1).at || at - samples.at(-1).at > 1600)) reset();
      samples.push({ drift, at });
      if (samples.length > 7) samples.shift();
      const values = samples.map(item => item.drift).sort((a, b) => a - b);
      const middle = Math.floor(values.length / 2);
      const median = values.length % 2 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
      const spread = values.at(-1) - values[0];
      return {
        median,
        stable: values.length >= 3 && at - samples[0].at >= minAgeMs && spread <= maxSpread
      };
    }
    return { sample, reset };
  }
  function createMediaConvergence() {
    const sensor = createDriftSensor({ minAgeMs: 600, maxSpread: .08 });
    let correcting = false;
    function reset() { sensor.reset(); correcting = false; }
    function rate(base, drift, time, precision) {
      const result = sensor.sample(drift, time);
      const settle = precision ?? .045, enter = precision == null ? .10 : precision * 1.4;
      correcting = result.stable && Math.abs(result.median) >= (correcting ? settle : enter);
      if (!correcting) return base;
      const adjustment = Math.sign(result.median) * Math.min(.04, Math.abs(result.median) * .2);
      return Math.min(2, Math.max(.25, base * (1 + adjustment)));
    }
    return { rate, reset };
  }
  function projectedPosition(metadata={},now=Date.now()){
    const position=Math.max(0,Number(metadata.currentTime)||0);
    if(metadata.paused || metadata.ended)return position;
    const sampledAt=Number(metadata.sampledAt),age=now-sampledAt;
    if(!Number.isFinite(sampledAt)||age<0||age>MAX_SAMPLE_AGE_MS)return position;
    return position+(age/1000)*Math.min(2,Math.max(.25,Number(metadata.rate)||1));
  }
  function youtubePlan(metadata={},playerState,currentTime,options={}){
    const target=projectedPosition(metadata,Number(options.now)||Date.now());
    const current=Math.max(0,Number(currentTime)||0),drift=target-current,absolute=Math.abs(drift);
    const paused=metadata.paused===true;
    const threshold=options.force===true?0.05:(paused?0.4:1.25);
    return{
      target,drift,
      seek:absolute>threshold,
      pause:paused&&playerState!==PAUSED,
      play:!paused&&playerState!==PLAYING&&playerState!==BUFFERING
    };
  }
  function mediaPlan(metadata={},currentTime,options={}){
    const target=projectedPosition(metadata,Number(options.now)||Date.now());
    const current=Math.max(0,Number(currentTime)||0),drift=target-current,absolute=Math.abs(drift);
    const paused=metadata.paused===true;
    const threshold=options.force===true?0.05:(paused?0.35:1.25);
    return{
      target,drift,
      seek:absolute>threshold,
      rate:Math.min(2,Math.max(.25,Number(metadata.rate)||1)),
      paused
    };
  }
  function mirrorPlan(metadata={},anchor=null,options={}){
    const now=Number(options.now)||Date.now();
    const target=projectedPosition(metadata,now);
    const paused=metadata.paused===true,ended=metadata.ended===true;
    const rate=Math.min(2,Math.max(.25,Number(metadata.rate)||1));
    const normalizedVolume=Number.isFinite(metadata.volume)?Math.max(0,Math.min(1,metadata.volume)):null;
    const nextAnchor={position:target,sampledAt:now,paused,ended,rate,volume:normalizedVolume};
    const age=now-Number(metadata.sampledAt);
    if(metadata.sampledAt&&(age<0||age>MAX_SAMPLE_AGE_MS))return{publish:false,reason:'stale',target,drift:0,anchor};
    if(options.force===true||!anchor){
      sourceDrift.reset();
      lastMirrorSampleAt = Number(metadata.sampledAt) || now;
      return{publish:true,reason:options.force===true?'force':'initial',target,drift:0,anchor:nextAnchor};
    }
    const transportChanged=paused!==(anchor.paused===true)||ended!==(anchor.ended===true)||Math.abs(rate-(Number(anchor.rate)||1))>.01;
    const stateChanged=transportChanged||normalizedVolume!==null&&(anchor.volume==null||Math.abs(normalizedVolume-anchor.volume)>.02);
    const elapsed=Math.max(0,now-anchor.sampledAt)/1000;
    const expected=anchor.position+(anchor.paused||anchor.ended?0:elapsed*(Number(anchor.rate)||1));
    const drift=target-expected;
    const sampleAt = Number(metadata.sampledAt) || now;
    const immediate = stateChanged || Math.abs(drift) > MIRROR_DRIFT_SEC;
    const freshPosition = sampleAt > lastMirrorSampleAt;
    lastMirrorSampleAt = Math.max(lastMirrorSampleAt, sampleAt);
    const sample = freshPosition && !immediate && !paused && !ended && sourceDrift.sample(drift, sampleAt);
    const sustained = sample && sample.stable && Math.abs(sample.median) >= .12;
    if (stateChanged && !transportChanged && Math.abs(drift) <= MIRROR_DRIFT_SEC) return {publish:true, reason:'volume', volumeOnly:true, // v13.10.8e: audio, not transport
      target:expected, drift, anchor:{...anchor, position:expected, sampledAt:now, volume:normalizedVolume}};
    if (immediate || sustained) {
      sourceDrift.reset();
      if (sustained) nextAnchor.position = expected + sample.median;
      return {publish:true, reason:stateChanged?'state':immediate?'drift':'sustained-drift',
        target:nextAnchor.position, drift, anchor:nextAnchor};
    }
    return {publish:false,reason:'steady',target,drift,anchor};
  }
  function positionJumped(position,sample,now=performance.now()){
    if(!sample||!Number.isFinite(Number(sample.position))||!Number.isFinite(Number(sample.at)))return false;
    const elapsed=now-Number(sample.at);
    if(elapsed<0||elapsed>1200)return false;
    const expected=Number(sample.position)+(sample.playing?(elapsed/1000)*Math.min(2,Math.max(.25,Number(sample.rate)||1)):0);
    return Math.abs((Number(position)||0)-expected)>1.5;
  }
  function transportTiming(metadata={},now=Date.now()){
    const sampledAt=Number(metadata.sampledAt)||0,publisherReceivedAt=Number(metadata.publisherReceivedAt)||0;
    const publisherSentAt=Number(metadata.publisherSentAt)||0,relayReceivedAt=Number(metadata.relayReceivedAt)||0;
    const relaySentAt=Number(metadata.relaySentAt)||0,viewerReceivedAt=Number(metadata.viewerReceivedAt)||Number(now)||0;
    const bounded=(end,start)=>end>0&&start>0&&end>=start?Math.min(60000,end-start):null;
    return{
      sourceToPublisherMs:bounded(publisherReceivedAt,sampledAt),
      publisherQueueMs:bounded(publisherSentAt,publisherReceivedAt),
      publisherToRelayMs:bounded(relayReceivedAt,publisherSentAt),
      relayToViewerMs:bounded(viewerReceivedAt,relaySentAt),
      sourceToViewerMs:bounded(viewerReceivedAt,sampledAt),
      sampleAgeMs:bounded(Number(now)||viewerReceivedAt,sampledAt)
    };
  }
  // Bounded automatic catch-up. A stalling YouTube TV must never enter a
  // seek/reload chase. One retry is allowed only after observed real playback.
  function createAutoRoomGovernor() {
    const MIN_RETRY_AGE_MS = 9000;
    const MIN_PLAYED_SEC = 2.5;
    const REARM_DRIFT_SEC = 0.09;
    const RETRY_DRIFT_SEC = 0.42;
    let scope = '', attempts = 0, lastSeekAt = -1;
    let lastAt = -1, lastPosition = null, progressSec = 0;
    let reason = 'idle', aligned = false;
    function reset(nextScope = '') {
      scope = nextScope;
      attempts = 0;
      lastSeekAt = -1;
      lastAt = -1;
      lastPosition = null;
      progressSec = 0;
      reason = 'new-source';
      aligned = false;
    }
    function onSeek(nowMs) {
      attempts += 1;
      lastSeekAt = nowMs;
      lastAt = -1;
      lastPosition = null;
      progressSec = 0;
      reason = 'seek-settling';
      aligned = false;
    }
    function settled() {
      attempts = 0;
      lastSeekAt = -1;
      lastAt = -1;
      lastPosition = null;
      progressSec = 0;
      reason = 'aligned';
      aligned = true;
    }
    function observe({nowMs, current, drift, playing, buffering, stable}) {
      if (attempts === 0) return {retry:false, settled:aligned, reason};
      if (!Number.isFinite(nowMs) || !Number.isFinite(current)
          || !Number.isFinite(drift)) return {retry:false, reason:'invalid-sample'};

      if (buffering || !playing) {
        lastAt = -1;
        lastPosition = null;
        progressSec = 0;
        reason = 'buffering-or-not-playing';
        return {retry:false, reason};
      }
      if (lastAt >= 0 && nowMs > lastAt) {
        const dt = (nowMs - lastAt) / 1000;
        const dp = current - lastPosition;
        // Count only advancing playback, not a keyframe jump or a stale reading.
        if (dt <= 2 && dp > 0 && dp <= 1.5) {
          progressSec += Math.min(dp, dt * 1.3);
        }
      }
      lastAt = nowMs;
      lastPosition = current;
      if (stable && progressSec >= .5 && nowMs - lastSeekAt >= 900 && Math.abs(drift) < REARM_DRIFT_SEC) {
        settled();
        return {retry:false, settled:true, reason:'aligned'};
      }
      if (attempts >= 2) {
        reason = 'retry-budget-used';
        return {retry:false, reason};
      }
      const ready = lastSeekAt >= 0 && nowMs - lastSeekAt >= MIN_RETRY_AGE_MS
        && progressSec >= MIN_PLAYED_SEC && stable
        && Math.abs(drift) >= RETRY_DRIFT_SEC;
      reason = ready ? 'one-retry-permitted' : 'settling';
      return {retry:ready, reason};
    }
    function snapshot() {
      return {scopeActive:!!scope, attempts, progressSec:Math.round(progressSec*100)/100,
        lastSeekAt, reason};
    }
    return {reset, onSeek, observe, settled, snapshot};
  }

  root.WatchFusionLinkedPlaybackSync={projectedPosition,youtubePlan,mediaPlan,mirrorPlan,positionJumped,transportTiming,relaySample,createDriftSensor,createMediaConvergence,createAutoRoomGovernor};
})(globalThis);

/* Host zero-center servo. Read-only until the shared reference is precise.
 * Host commands and the linked source remain authoritative; these bounded local
 * rate pulses must NEVER echo into the room or the attached source tab.
 */
(() => {
  'use strict';
  if (typeof window === 'undefined' || typeof document === 'undefined' || window.watchFusionHostZeroCenter?.version === 'v13.9') return; // host-page only
  const PERIOD_MS = 250, WINDOW_MS = 2000, REARM_MS = 5000;
  const MIN_ERROR_SEC = .05, MAX_ERROR_SEC = .45;
  let scope = '', samples = [], pulse = null, suppressUntil = 0;
  let cooldownUntil = 0, disabled = false, previousPulse = null, failedPulseAt=-Infinity, failCount=0;
  let outcome = 'idle', attempts = 0, lastErrorMs = null;
  const now = () => performance.now();
  const readRate = () => Number(ytPlayer?.getPlaybackRate?.());
  const canControl = () => typeof ytPlayer?.setPlaybackRate === 'function';
  const zero = () => ({scope, errorMs:lastErrorMs, outcome, attempts,
    active:!!pulse, disabled, suppressed:now() < suppressUntil});

  function release(reason = 'pulse-finished') {
    const prior = pulse;
    if (!prior) return;
    pulse = null;
    clearTimeout(prior.timer);
    suppressUntil = now() + 650;
    try {
      // Do not overwrite a human's intervening rate selection.
      if (Math.abs(readRate() - prior.rate) < .015) ytPlayer.setPlaybackRate(prior.base);
    } catch {}
    previousPulse = {at:now(), before:prior.error};
    cooldownUntil = now() + REARM_MS;
    samples = []; outcome = reason;
  }
  function reset(next, reason) {
    release('interrupted');
    if (scope !== next) { disabled = false; failCount = 0; attempts = 0; previousPulse = null; cooldownUntil = 0; }
    scope = next; samples = []; lastErrorMs = null; outcome = reason;
  }
  function validSample() {
    if (document.hidden || !roomId || !isHost() || !ytPlayerReady ||
        playerInitializing || primingPlayer || applyingRemote || window.watchFusionViewerArbiter?.owns?.() || !state?.source?.videoId ||
        state.playback?.paused || state.playback?.ended || !canControl()) return false;
    if (ytPlayer.getPlayerState?.() !== 1 ||
        ytPlayer.getVideoData?.()?.video_id !== state.source.videoId) return false;
    const coordination = window.watchFusionPlayout?.status?.();
    if (!coordination || coordination.authorityBuffering || coordination.source!=='live' ||
        !['peer-cohort','linked-source','room-clock'].includes(coordination.reference) ||
        !Number.isFinite(coordination.uncertaintyMs)) return false;
    return true;
  }
  function tick() {
    const p = state?.playback;
    const next = roomId && p && state?.source?.videoId && isHost()
      ? [roomId, state.source.videoId, state.presentationEpoch, state.playoutSegment].join(':') : '';
    if (next !== scope) reset(next,'source-changed');
    if (!validSample()) {
      if (pulse) release('source-not-ready');
      samples = []; outcome = 'awaiting-trusted-reference'; return;
    }
    const at = now();
    const base = Math.min(2,Math.max(.25,Number(p.rate)||1));
    if (pulse) {
      if (at >= pulse.dueAt) release('pulse-finished');
      else if (at - pulse.startedAt > 400 && Math.abs(readRate()-pulse.rate) > .015) {
        disabled = true;failedPulseAt=at;failCount++;release('rate-not-accepted');
      }
      return;
    }
    if(disabled||at<cooldownUntil||at<suppressUntil)return; // rejected rates stay disabled until the next segment
    const coordination = window.watchFusionPlayout.status();
    const position = Number(ytPlayer.getCurrentTime?.());
    const target = Number(window.watchFusionYouTubeTarget?.(estimatedServerNow(),ytPlayer.getDuration?.()));
    if (!Number.isFinite(target) || !Number.isFinite(position) ||
        Math.abs(readRate()-base) > .015) { samples = []; return; }
    const error = target - position;
    lastErrorMs = Math.round(error*1000);
    if (Math.abs(error) < MIN_ERROR_SEC || Math.abs(error) > MAX_ERROR_SEC) {
      samples = []; outcome = 'within-deadband-or-needs-ordinary-sync'; return;
    }
    const confidence=window.WatchFusionPrecisionPolicy?.trustedHostReference?.(coordination,window.watchFusionPresentation?.peerCandidate?.(),-error*1000);
    if (!confidence || Math.abs(error)*1000 < Math.max(45,confidence.precisionMs*1.1)) {
      samples = []; outcome = 'below-reference-precision'; return;
    }
    samples.push({at, error, position, target});
    samples = samples.filter(x => at - x.at <= WINDOW_MS);
    if (samples.length < 5 || at - samples[0].at < 1000) return;
    const span = (at-samples[0].at)/1000;
    const progress = position-samples[0].position;
    const values = samples.map(x=>x.error);
    if (progress < .6*base*span || Math.max(...values)-Math.min(...values) > .045 ||
        values.some(x=>Math.sign(x)!==Math.sign(error))) { outcome='unstable-host-phase'; return; }
    if (previousPulse && at - previousPulse.at > 1500) {
      if (Math.abs(error) >= Math.abs(previousPulse.before)-.012) {
        disabled = true;failedPulseAt=at;failCount++;outcome='rate-not-effective'; return;
      }
      previousPulse = null;
    }
    const available = ytPlayer.getAvailablePlaybackRates?.();
    if (!Array.isArray(available)) { outcome='rate-unavailable'; return; }
    const rates = available.filter(x=>Number.isFinite(x) && Math.sign(x-base)===Math.sign(error)
      && Math.abs(x-base)>.02 && Math.abs(x-base)<=.3)
      .sort((a,b)=>Math.abs(a-base)-Math.abs(b-base));
    const selected = rates[0];
    if (!selected) { outcome='fixed-rate-monitoring'; return; }
    const duration = Math.min(650,Math.max(130,Math.abs(error)*.65/Math.abs(selected-base)*1000));
    if (duration/1000*Math.abs(selected-base) > Math.abs(error)*.95) return;
    pulse = {rate:selected,base,error,startedAt:at,dueAt:at+duration,timer:null};
    suppressUntil = at + duration + 850;
    samples = []; attempts++; outcome='host-zero-centering';
    try {
      ytPlayer.setPlaybackRate(selected);
      pulse.timer=setTimeout(()=>release('pulse-finished'),duration);
    } catch { disabled=true;failedPulseAt=at;failCount++;release('rate-change-failed'); }
  }
  document.addEventListener('visibilitychange',()=>{if(document.hidden)reset('', 'page-hidden');});
  setInterval(()=>{try{tick();}catch{reset('', 'servo-error');}},PERIOD_MS);
  window.watchFusionHostZeroCenter = {version:'v13.9', isApplying:()=>{
    const current=readRate(), base=Number(state?.playback?.rate)||1;
    return (!!pulse || now()<suppressUntil) && Number.isFinite(current) &&
      (Math.abs(current-base)<.015 || Math.abs(current-(pulse?.rate ?? base))<.015);
  }, diagnostics:zero};
})();

/* v13.10: one last decoder reload after the bounded stall ladder, never a seek loop. */
(() => {
  let scope='', since=0, attempted=false, outcome='idle';
  function consider(input){
    if(input.scope!==scope){scope=input.scope;since=0;attempted=false;outcome='scope-change';}
    if(attempted)return false;
    if(!input.exhausted || !input.playing || input.buffering || !input.trusted ||
       input.sourceBuffering || document.hidden || Math.abs(input.drift)<3){since=0;return false;}
    if(!since){since=input.nowMs;outcome='waiting-for-stable-exhaustion';return false;}
    if(input.nowMs-since<6000)return false;
    attempted=true;
    try{input.reload();outcome='one-decoder-reload';return true;}
    catch{outcome='reload-failed';return false;}
  }
  window.WatchFusionDecoderRescue={consider,diagnostics:()=>({scope,attempted,outcome})};
})();
/* v13.10.3: verify host landings after release; at most one evidence-gated retry. */
(() => {
  const MAX_ATTEMPTS=1,VERIFY_MS=7500,SETTLE_MS=3500,RETRY_WAIT_MS=12000;
  let scope='',samples=[],lastStamp=-Infinity,stage='observe',outcome='idle',attempts=0,echoUntil=0;
  let peerCount=0,observedPeerCount=0,observedPeerErrorMs=null,peerSpreadMs=null,hostErrorMs=null,peerErrorMs=null,gapMs=null,reference=null;
  let lastReason='',lastReasonAt=-Infinity,triggeredAt=null,verifyAt=-1,nearSince=-1,failedAt=-1;
  const note=(kind,detail)=>window.watchFusionRoomSyncLog?.note?.(kind,detail); const fields=()=>({reference,hostErrorMs,peerErrorMs,gapMs,peerCount,observedPeerCount,observedPeerErrorMs,peerSpreadMs,attempts});
  function gate(why,nowMs){samples=['source-not-trusted','no-healthy-peer-witness','reference-mismatch'].includes(why)?samples.filter(x=>nowMs-x.at<=24000&&(!x.member||why==='no-healthy-peer-witness')):[];outcome=why;
    if(nowMs-lastReasonAt>=(why!==lastReason?2500:10000)){lastReason=why;lastReasonAt=nowMs;note('host-rejoin-gated',{reason:why,...fields()});}
    return false;}
  function consider(input={}) {
    const p=input.peer??window.WatchFusionHostSeekPolicy?.singleRecoveryWitness(input), at=Number(input.nowMs),host=Number(input.hostOffsetMs),gap=host-Number(p?.offsetMs);
    if(input.scope!==scope){scope=input.scope;samples=[];lastStamp=-Infinity;stage='observe';outcome='new-segment';attempts=0;
      echoUntil=0;triggeredAt=null;verifyAt=nearSince=failedAt=-1;lastReason='';peerCount=0;}
    reference=input.reference??p?.reference??'room-clock';peerCount=p?.count??0;observedPeerCount=input.observedPeer?.count??peerCount;observedPeerErrorMs=Number.isFinite(input.observedPeer?.offsetMs)?Math.round(input.observedPeer.offsetMs):null;
    peerSpreadMs=Number.isFinite(p?.spreadMs)?Math.round(p.spreadMs):null;
    hostErrorMs=Number.isFinite(host)?Math.round(host):null;peerErrorMs=Number.isFinite(p?.offsetMs)?Math.round(p.offsetMs):null;
    gapMs=Number.isFinite(gap)?Math.round(gap):null;
    if(stage==='exhausted')return false;
    const healthy=!!(input.active&&input.trusted&&p&&p.ageMs>=0&&p.ageMs<=1500&&(!input.reference||!p.reference||input.reference===p.reference)&&Math.abs(p.offsetMs)<=70&&Number.isFinite(host)&&Number.isFinite(gap));if(stage==='settled'){if(!healthy||Math.abs(host)<=100||Math.abs(gap)<=100)return false;stage=attempts>=MAX_ATTEMPTS?'exhausted':'observe';outcome=stage==='exhausted'?'host-rejoin-budget-used':'host-drift-returned';samples=[];lastStamp=-Infinity;note('host-rejoin-drift-returned',fields());if(stage==='exhausted')return false;}
    if(stage==='actuating'){
      // Verify only after the exclusive arbiter releases the landing; never diagnose during the seek.
      if(!healthy)return false;
      stage='verifying';verifyAt=at;nearSince=-1;outcome='host-rejoin-verifying';
      note('host-rejoin-verifying',fields());return false;
    }
    if(stage==='verifying'){
      if(!healthy){nearSince=-1;return false;}
      const close=Math.abs(host)<=100&&Math.abs(gap)<=110; // policy edge; the zero-center servo refines below 50
      if(close){if(nearSince<0)nearSince=at;}else nearSince=-1;
      if(close&&at-nearSince>=SETTLE_MS){stage='settled';outcome='host-rejoin-settled';note('host-rejoin-settled',{...fields(),dwellMs:Math.round(at-nearSince)});return false;}
      if(at-verifyAt<VERIFY_MS)return false;
      if(!close&&Math.abs(host)>=Math.max(110,((u=>Number.isFinite(u)?u:125)(window.watchFusionPlayout?.status?.()?.uncertaintyMs))*1.5)&&Math.abs(gap)>=Math.max(110,((u=>Number.isFinite(u)?u:125)(window.watchFusionPlayout?.status?.()?.uncertaintyMs))*1.5)){failedAt=at;stage=attempts<MAX_ATTEMPTS?'retry-wait':'exhausted';outcome=stage==='retry-wait'?'host-rejoin-incomplete':'host-rejoin-budget-used';
        note('host-rejoin-incomplete',fields());if(stage==='exhausted')note('host-rejoin-budget-exhausted',fields());else note('host-rejoin-retry-armed',{...fields(),reason:'landing-not-held'});
        samples=[];lastStamp=-Infinity;return false;}
      verifyAt=at;return false; // uncertain landing: require another sustained window
    }
    if(stage==='retry-wait'&&at-failedAt<RETRY_WAIT_MS)return false;
    if(!input.scope||!input.active)return gate('host-not-ready',at);
    if(!input.trusted)return gate('source-not-trusted',at);
    if(!p)return gate('no-healthy-peer-witness',at);
    if(input.reference&&p.reference&&input.reference!==p.reference)return gate('reference-mismatch',at);
    if(!Number.isFinite(host)||!Number.isFinite(gap))return gate('invalid-player-phase',at);
    if(p.ageMs>1500||p.ageMs<0)return gate('peer-report-stale',at);
    if(Math.abs(p.offsetMs)>70)return gate('peer-outside-lock-band',at);
    const peerNoise=Number.isFinite(p.spreadMs)?Math.max(45,p.spreadMs/2+20):125;if(Math.abs(host)<155||Math.abs(gap)<Math.max(125,peerNoise*1.35)||p.observeOnly&&(host > -250 || host < -650))return gate('host-within-guard-band',at);
    if(Math.abs(host)>650 && (host>=0 || Math.abs(host)>820 || reference!=='linked-tab' || p.count<2 || !Number.isFinite(p.spreadMs) || p.spreadMs>55 || Math.abs(p.offsetMs)>50))return gate('host-offset-too-large',at);
    if(!(p.sampledAt>lastStamp))return false;lastStamp=p.sampledAt;
    if(samples.length&&(at-samples.at(-1).at>(p.observeOnly?5500:12500)||Math.sign(gap)!==Math.sign(samples.at(-1).gap)||reference!==samples.at(-1).reference||p.member!==samples.at(-1).member))samples=[];
    samples.push({at,host,peer:p.offsetMs,gap,reference,member:p.member});samples=samples.filter(x=>at-x.at<=24000);
    if(samples.length<(p.observeOnly?5:7)||at-samples[0].at<6500||samples.filter(x=>at-x.at<=(p.observeOnly?5500:2500)).length<2){outcome='corroborating-host-drift';return false;}
    const spread=key=>Math.max(...samples.map(x=>x[key]))-Math.min(...samples.map(x=>x[key]));
    if(spread('host')>60||spread('peer')>35||spread('gap')>65)return gate('unstable-peer-or-host',at);
    attempts++;triggeredAt=Date.now();echoUntil=performance.now()+3500;stage='actuating';outcome='host-peer-rejoin';
    note('host-rejoin-triggered',{...fields(),dwellMs:Math.round(at-samples[0].at)});return true;
  }
  function accept(ok){if(stage!=='actuating')return;
    if(!ok){stage='exhausted';outcome='host-rejoin-not-started';}note(ok?'host-rejoin-accepted':'host-rejoin-rejected',fields());}
  function suppressEcho(){if(!attempts||!echoUntil)return false;const at=performance.now();
    if(window.watchFusionViewerArbiter?.correcting?.()){echoUntil=at+900;return true;}return at<echoUntil;}
  function diagnostics(){return {outcome,stage,attempts,witnesses:samples.length,reference,peerCount,observedPeerCount,observedPeerErrorMs,peerSpreadMs,
    hostErrorMs,peerErrorMs,gapMs,dwellMs:samples.length?Math.round(samples.at(-1).at-samples[0].at):0,verifyMs:verifyAt>=0?Math.max(0,Math.round(performance.now()-verifyAt)):null,triggeredAt};}
  window.WatchFusionHostPeerRecovery={consider,accept,suppressEcho,diagnostics};
})();
