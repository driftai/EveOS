(function(root){
  const PLAYING=1,PAUSED=2,BUFFERING=3;
  const MAX_SAMPLE_AGE_MS=2000;
  const MIRROR_DRIFT_SEC=0.75;
  const sourceDrift = createDriftSensor({ minAgeMs: 650, maxSpread: .09 });
  let lastMirrorSampleAt = 0;

  function relaySample(metadata, receivedAt, serverAt) {
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
    return { ...metadata, sampledAt: receivedAt - age };
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
    function rate(base, drift, time) {
      const result = sensor.sample(drift, time);
      correcting = result.stable && Math.abs(result.median) >= (correcting ? .045 : .10);
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
    const volume=Number(metadata.volume);
    const normalizedVolume=Number.isFinite(volume)?Math.max(0,Math.min(1,volume)):null;
    const nextAnchor={position:target,sampledAt:now,paused,ended,rate,volume:normalizedVolume};
    const age=now-Number(metadata.sampledAt);
    if(metadata.sampledAt&&(age<0||age>MAX_SAMPLE_AGE_MS))return{publish:false,reason:'stale',target,drift:0,anchor};
    if(options.force===true||!anchor){
      sourceDrift.reset();
      lastMirrorSampleAt = Number(metadata.sampledAt) || now;
      return{publish:true,reason:options.force===true?'force':'initial',target,drift:0,anchor:nextAnchor};
    }
    const stateChanged=paused!==(anchor.paused===true)||ended!==(anchor.ended===true)
      ||Math.abs(rate-(Number(anchor.rate)||1))>.01
      ||normalizedVolume!==null&&Number.isFinite(Number(anchor.volume))&&Math.abs(normalizedVolume-Number(anchor.volume))>.02;
    const elapsed=Math.max(0,now-anchor.sampledAt)/1000;
    const expected=anchor.position+(anchor.paused||anchor.ended?0:elapsed*(Number(anchor.rate)||1));
    const drift=target-expected;
    const sampleAt = Number(metadata.sampledAt) || now;
    const immediate = stateChanged || Math.abs(drift) > MIRROR_DRIFT_SEC;
    const freshPosition = sampleAt > lastMirrorSampleAt;
    lastMirrorSampleAt = Math.max(lastMirrorSampleAt, sampleAt);
    const sample = freshPosition && !immediate && !paused && !ended && sourceDrift.sample(drift, sampleAt);
    const sustained = sample && sample.stable && Math.abs(sample.median) >= .12;
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
