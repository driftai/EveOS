/* YouTube room sync preserves the room rate and verifies recovery from bounded seeks. */
(() => {
  const SYNC_TOLERANCE_SEC = 0.15;
  const HARD_DRIFT_SEC = 1.5;
  const SEEK_COOLDOWN_MS = 2500;
  const TICK_MS = 250;
  const SENSOR_WINDOW = 7; const SENSOR_MIN_SAMPLES = 5;
  const SENSOR_MIN_AGE_MS = 900;
  const SENSOR_MAX_SPREAD_SEC = 0.22;
  const DEVICE_TIMING_KEY = 'watchfusion.youtubePlaybackDelayMs';
  const DEVICE_TIMING_STEP_MS = 5;
  const DEVICE_TIMING_LIMIT_MS = 1000;
  let deviceDelayMs = normalizeDeviceDelay(storage.get(DEVICE_TIMING_KEY));
  let draftDeviceDelayMs = deviceDelayMs;
  const arbiter = window.watchFusionViewerArbiter;
  const tvOwner = window.WatchFusionReleaseEvidence?.tvRecoveryOwner;
  let anchorKey = '';
  let anchorPosition = 0;
  let anchorServerTime = 0;
  let anchorRate = 0;
  let seekCooldownUntil = 0;
  let awaitingSeekRecovery = false;
  let viewerWasBuffering = false;
  let viewerScope = '', viewerProgress = null, hostPositionSample = null;
  let correctiveSeeks = 0;
  let replayLoads = 0;
  let viewerSawEnded = false;
  let replayKey = '', transportSeekPending = false, viewerPausedPosition = null, lastRateRequest = null, coldJoinUntil = 0;
  let trackStartRecovery = null;
  let diagnostics = {
    rawDriftSec: 0,
    filteredDriftSec: 0,
    spreadSec: 0,
    sampleCount: 0,
    stable: false,
    action: 'idle'
  };
  const coldJoinReady=({until,nowMs,roomPaused,force,playerState,drift,linked,reference,matches})=>!!(until>nowMs&&!roomPaused&&!force&&playerState===1&&Math.abs(drift)>8&&matches&&(!linked||reference?.source==='live'&&reference.authorityBuffering!==true&&Number.isFinite(reference.sourcePhaseMs)&&Math.abs(reference.sourcePhaseMs)<=100));
  function trackStartRecoveryEligible({ageMs, driftSec, stable, ready, sourceLive,
      uncertaintyMs, rateList, firstProgressMs, seekCount, contradicted}) {
    return ageMs >= 4500 && ageMs <= 18000 && driftSec >= .20 && driftSec <= .85
      && stable && ready && sourceLive && !contradicted && seekCount === 0
      && uncertaintyMs !== null && Number.isFinite(uncertaintyMs) && uncertaintyMs >= 0 && uncertaintyMs <= 100
      && Number.isFinite(firstProgressMs) && firstProgressMs >= 0 && firstProgressMs <= 1100
      && Array.isArray(rateList) && rateList.length >= 1 && rateList.every(r => Math.abs(r-1) < .01);
  }
  function normalizeDeviceDelay(value) { return globalThis.WatchFusionTimelineMath.normalizeDelay(value,DEVICE_TIMING_STEP_MS,DEVICE_TIMING_LIMIT_MS); }
  function hasDeviceTiming() {
    return !!roomId && !!state?.source?.videoId && followsRoomPlayback() && !isHost();
  }
  function formatDeviceDelay(value) {
    return value ? Math.abs(value) + ' ms ' + (value < 0 ? 'earlier' : 'later') : '0 ms';
  }
  function renderDeviceTiming() {
    const controls = $('devicePlaybackTiming');
    if (!controls) return;
    controls.hidden = !hasDeviceTiming();
    if (controls.hidden) {
      controls.open = false;
      draftDeviceDelayMs = deviceDelayMs;
      return;
    }
    $('deviceTimingSummary').textContent = deviceDelayMs ? formatDeviceDelay(deviceDelayMs) : 'No override';
    $('deviceTimingValue').textContent = formatDeviceDelay(draftDeviceDelayMs);
    window.watchFusionSyncCenter?.renderOffset(draftDeviceDelayMs, formatDeviceDelay(draftDeviceDelayMs));
    $('deviceTimingEarlier').disabled = draftDeviceDelayMs <= -DEVICE_TIMING_LIMIT_MS;
    $('deviceTimingLater').disabled = draftDeviceDelayMs >= DEVICE_TIMING_LIMIT_MS;
    const earlierFine = $('deviceTimingEarlierFine');
    const laterFine = $('deviceTimingLaterFine');
    if (earlierFine) earlierFine.disabled = draftDeviceDelayMs <= -DEVICE_TIMING_LIMIT_MS;
    if (laterFine) laterFine.disabled = draftDeviceDelayMs >= DEVICE_TIMING_LIMIT_MS;
    $('deviceTimingApply').disabled = draftDeviceDelayMs === deviceDelayMs;
    $('deviceTimingReset').disabled = !deviceDelayMs && !draftDeviceDelayMs;
  }
  function stageDeviceDelay(value) {
    draftDeviceDelayMs = normalizeDeviceDelay(value);
    renderDeviceTiming();
  }
  function applyDeviceDelay(value) {
    if (!hasDeviceTiming()) return;
    draftDeviceDelayMs = normalizeDeviceDelay(value);
    if (draftDeviceDelayMs !== deviceDelayMs) {
      deviceDelayMs = draftDeviceDelayMs;
      storage.set(DEVICE_TIMING_KEY, String(deviceDelayMs)); window.watchFusionPresentation?.useManualTiming?.();
      if (!state.playback?.paused && !state.playback?.ended) syncPlayer({ force: true });
    }
    renderDeviceTiming();
  }
  const driftSensor = globalThis.WatchFusionTimelineMath.createDriftSensor({windowSize:SENSOR_WINDOW,minSamples:SENSOR_MIN_SAMPLES,minAgeMs:SENSOR_MIN_AGE_MS,maxSpreadSec:SENSOR_MAX_SPREAD_SEC,toleranceSec:SYNC_TOLERANCE_SEC});
  function resetDriftSensor(action = 'reset') { diagnostics = driftSensor.reset(action); }
  function syncStateKey() {
    const p = state?.playback;
    if (!p) return '';
    const sourceId = state?.source?.videoId || state?.source?.url || state?.source?.streamId || '';
    return [roomId, sourceId, p.updatedAt, p.rate, p.paused, p.ended].join('|');
  }
  function refreshAnchor(force = false) {
    if (!state?.playback) return;
    const key = syncStateKey();
    if (!force && key && key === anchorKey) return;
    const p = state.playback;
    const position = Number(p.position) || 0;
    const at = Number(p.projectedAt) || Number(state.serverTime) || Date.now();
    const rate = p.paused || p.ended ? 0 : Number(p.rate) || 1;
    if (key !== anchorKey) {
      const changedRate = anchorRate !== rate;
      const jumpThreshold = rate === 0 ? SYNC_TOLERANCE_SEC : HARD_DRIFT_SEC;
      const jumped = Math.abs(position - projectAnchor(at)) >= jumpThreshold;
      if (anchorKey && (changedRate || jumped)) {
        resetDriftSensor('new-anchor');
        resetSeekRecovery();
      }
    }
    anchorKey = key;
    anchorPosition = position;
    anchorServerTime = at;
    anchorRate = rate;
  }
  function projectAnchor(at) {
    return Math.max(0, anchorPosition + Math.max(0, at - anchorServerTime) / 1000 * anchorRate);
  }
  function youtubeTarget(at, duration) {
    const position = projectAnchor(at), delay = anchorRate && hasDeviceTiming() ? (window.watchFusionPresentation?.adjustmentMs?.() ?? deviceDelayMs) * anchorRate / 1000 : 0, calculated = Math.max(0, Math.min(duration > 0 ? duration : Infinity, (window.watchFusionPlayout?.position(position, 'youtube') ?? position) - delay));
    return window.WatchFusionTargetProjectionGuard?.target?.({calculated, at, delay, player:ytPlayer, playback:state?.playback, source:state?.source, serverTime:state?.serverTime, coordination:window.watchFusionPlayout?.status?.()}) ?? calculated;
  }
  function resetSeekRecovery() {
    awaitingSeekRecovery = false;
    seekCooldownUntil = 0;
  }
  function sampleDrift(rawDrift, nowMs) { return diagnostics = driftSensor.sample(rawDrift,nowMs,diagnostics.action); }
  function connectedStatus() {
    return isTryCloudflare ? 'Connected (remote sync)' : 'Connected';
  }
  function markStable() {
    if (($('syncStatus')?.textContent || '') !== connectedStatus()) setStatus(connectedStatus());
    diagnostics.action = 'steady';
  }
  function setViewerRate(rate) {
    const available = ytPlayer.getAvailablePlaybackRates?.();
    if (available?.length && !available.includes(rate)) return;
    if (Math.abs((Number(ytPlayer.getPlaybackRate?.()) || rate) - rate) > .001) {
      const now = performance.now();
      if (lastRateRequest?.player === ytPlayer && lastRateRequest.rate === rate && now - lastRateRequest.at < 1500) return;
      lastRateRequest = {player:ytPlayer,rate,at:now};
      window.watchFusionLinkedTab?.suppressPlaybackEcho?.(); ytPlayer.setPlaybackRate?.(rate);
    }
  }
  function restartViewerFromEnded(target, baseRate) {
    const key = syncStateKey();
    if (!key || key === replayKey) return false;
    replayKey = key;
    viewerSawEnded = false;
    try {
      const startSeconds = Math.max(0, Number(target) || 0);
      window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
      if (typeof ytPlayer.loadVideoById === 'function') {
        ytPlayer.loadVideoById({ videoId: state.source.videoId, startSeconds });
        replayLoads++;
      } else {
        ytPlayer.seekTo?.(startSeconds, true);
      }
      setViewerRate(baseRate);
      awaitSeekRecovery(performance.now());
      arbiter?.intent('replay');
      requestViewerPlayback();
      resetDriftSensor('replay');
      return true;
    } catch {
      return false;
    }
  }
  function awaitSeekRecovery(nowMs, reclaim = false) {
    window.watchFusionYouTubeStartup?.seekIssued?.(reclaim);
    awaitingSeekRecovery = true;
    seekCooldownUntil = nowMs + SEEK_COOLDOWN_MS;
  }
  function seekViewer(target, baseRate, nowMs, action = 'seek', allowNetwork = true) {
    try {
      setViewerRate(baseRate);
      window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
      ytPlayer.seekTo(Math.max(0, Math.min(Number(ytPlayer.getDuration?.()) || Infinity, target)), allowNetwork);
      correctiveSeeks++;
    } catch { return false; }
    awaitSeekRecovery(nowMs, action === 'viewer-reclaim');
    resetDriftSensor(action);
    setStatus('Catching up…');
    return true;
  }
  function arbiterIo(baseRate, duration) {
    const player=ytPlayer, identity=[roomId,state?.source?.videoId,state?.presentationEpoch,state?.playoutSegment].join(':'); return {
      baseRate, hostLinked: isHost() && state?.linkedSourceActive === true, follower:!isHost()&&followsRoomPlayback(),
      background:()=>document.hidden===true, valid:()=>player===ytPlayer&&identity===[roomId,state?.source?.videoId,state?.presentationEpoch,state?.playoutSegment].join(':')&&!state?.playback?.paused&&!state?.playback?.ended, tvIdentity:[roomId,state?.source?.videoId,state?.presentationEpoch].join(':'),linkedSourceActive:()=>state?.linkedSourceActive===true,now: () => performance.now(),
      target: () => youtubeTarget(estimatedServerNow(), duration),
      current: () => Number(ytPlayer.getCurrentTime?.()), state: () => ytPlayer.getPlayerState?.(),
      availableRates: () => ytPlayer.getAvailablePlaybackRates?.(),
      buffered: position => duration * (Number(ytPlayer.getVideoLoadedFraction?.()) || 0) >= position + 1,
      seek: (position, allowNetwork) => {
        window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
        ytPlayer.seekTo(Math.max(0, Math.min(duration || Infinity, position)), allowNetwork);
        window.watchFusionYouTubeStartup?.seekIssued?.(false); correctiveSeeks++; setStatus('Catching up…');
      },
      pause: () => { window.watchFusionLinkedTab?.suppressPlaybackEcho?.(); ytPlayer.pauseVideo?.(); },
      play: () => { window.watchFusionLinkedTab?.suppressPlaybackEcho?.(); ytPlayer.playVideo?.(); },
      rate: rate => setViewerRate(rate),
      sourceBuffering: () => !!window.watchFusionPlayout?.sourceBuffering?.(), mirrorContradicted: () => !!(window.WatchFusionMirrorConvergenceGate?.contradicted?.() || window.watchFusionPlayout?.status?.()?.mirrorContradicted),
      recentSourceRecovery: () => { const c=window.watchFusionPlayout?.status?.();
        if(!c || c.source!=='live' || c.reference!=='linked-tab' || c.authorityBuffering || window.WatchFusionMirrorConvergenceGate?.contradicted?.())return null;
        return c.sourceRecovery ? {...c.sourceRecovery,reference:c.reference,source:c.source,
          uncertaintyMs:c.uncertaintyMs,authorityBuffering:c.authorityBuffering} : null; },
      referenceUncertaintyMs: () => { const c=window.watchFusionPlayout?.status?.();const p=isHost()?window.watchFusionPresentation?.peerCandidate?.():null;const offset=(Number(ytPlayer?.getCurrentTime?.())-Number(window.watchFusionYouTubeTarget?.(estimatedServerNow(),ytPlayer?.getDuration?.())))*1000;return window.WatchFusionPrecisionPolicy?.trustedHostReference?.(c,p,offset)?.precisionMs??c?.uncertaintyMs??null; },
      referenceTrusted: () => state?.linkedSourceActive !== true || window.watchFusionPlayout?.status?.()?.source === 'live',
      sourceReferenceQualified: (maxPhaseMs = 25) => {
        const playout=window.watchFusionPlayout, c=playout?.status?.();
        return !document.hidden && c?.reference==='linked-tab' && playout.hasSourceReference?.(c,estimatedServerNow())===true &&
          Number.isFinite(c.sourcePhaseMs) && Math.abs(c.sourcePhaseMs)<=maxPhaseMs;
      },
      hostHoldBlocker: () => window.WatchFusionHostSeekPolicy?.sourceBlocker(youtubeTarget(estimatedServerNow(), duration)),
      hostFineHoldTrusted() { return this.hostLinked && this.hostHoldBlocker() === null; }
    };
  }
  function applyViewerCorrection(force = false, bufferedOnly = false, explicitSync = false) {
    if (!roomId || !state?.source?.videoId || !ytPlayer || !ytPlayerReady || !followsRoomPlayback()) return;
    if (playerInitializing || primingPlayer) return;
    const scope = [roomId, state.source.videoId, state.presentationEpoch, state.playoutSegment].join(':');
    const roomPaused = !!(state.playback.paused || state.playback.ended);
    window.WatchFusionDecoderRescue?.observeTransport?.({scope, nowMs:performance.now(), paused:roomPaused});
    const sameSource = viewerScope && scope.slice(0, scope.lastIndexOf(':')) === viewerScope.slice(0, viewerScope.lastIndexOf(':'));
    const ordinaryResume = viewerPausedPosition !== null && !roomPaused && Math.abs(Number(state.playback.position) - viewerPausedPosition) < .75;
    if (scope !== viewerScope) trackStartRecovery = !sameSource && !roomPaused && !isHost() && (viewerScope || state.linkedSourceActive) ? {scope, at:performance.now(), spent:false} : null;
    viewerPausedPosition = roomPaused ? Number(state.playback.position) : null;
    const baseRate = Math.min(2, Math.max(0.25, Number(state.playback.rate) || 1));
    const duration = Number(ytPlayer.getDuration?.()) || 0;
    const io = (raw => window.WatchFusionRejoinProbe?.wrap?.(raw) ?? raw)(arbiterIo(baseRate, duration)); // v13.10.8g: measure, never actuate
    if (scope !== viewerScope) {
      transportSeekPending = !!sameSource && !roomPaused && !ordinaryResume;
      coldJoinUntil = !sameSource && !roomPaused && !isHost() ? performance.now() + 15000 : 0;
      viewerScope = scope;
      arbiter?.intent(roomPaused ? 'pause' : 'transport', io); arbiter?.tick(scope, performance.now(), io);
      viewerWasBuffering = false;
      viewerSawEnded = !!sameSource && viewerSawEnded;
      resetSeekRecovery();
      replayKey = '';
      correctiveSeeks = 0;
      replayLoads = 0;
      resetDriftSensor('source-changed');
    }
    applyRoomAudioState();
    refreshAnchor(false);
    const current = Number(ytPlayer.getCurrentTime?.()); if (!Number.isFinite(current)) return false;
    const target = youtubeTarget(estimatedServerNow(), duration);
    const rawDrift = target - current;
    const absRaw = Math.abs(rawDrift), nowMs = performance.now();
    arbiter?.observeRelease?.(nowMs, io);
    const playerState = ytPlayer.getPlayerState?.();
    const buffering = playerState === (window.YT?.PlayerState?.BUFFERING ?? 3);
    if (coldJoinUntil && (roomPaused || nowMs >= coldJoinUntil || absRaw <= 2.5)) coldJoinUntil = 0;
    const playerEnded = playerState === (window.YT?.PlayerState?.ENDED ?? 0);
    const transport = {roomId, videoId:state.source.videoId, epoch:state.presentationEpoch, segment:state.playoutSegment};
    if (roomPaused) {
      if (arbiter?.owns()) arbiter.intent('pause', io);
      setViewerRate(baseRate);
      viewerSawEnded = !!state.playback.ended;
      const bufferedEnd = duration * (Number(ytPlayer.getVideoLoadedFraction?.()) || 0);
      const warmPause = !state.playback.ended && target > current && bufferedEnd >= target + .25;
      const pause = window.watchFusionYouTubeStartup?.paused({...transport, position:target, current, buffering:buffering || playerState === 1, force:force && !bufferedOnly, alignBuffered:warmPause, explicitSync, nowMs});
      try {
        if (pause?.seek) { window.watchFusionLinkedTab?.suppressPlaybackEcho?.(); awaitSeekRecovery(nowMs); ytPlayer.seekTo?.(target, pause.allowNetwork); }
        if (!playerEnded && playerState !== (window.YT?.PlayerState?.PAUSED ?? 2)
            && (!buffering || !awaitingSeekRecovery)) {
          window.watchFusionLinkedTab?.suppressPlaybackEcho?.(); ytPlayer.pauseVideo?.();
        }
      } catch {}
      resetDriftSensor('paused');
      if (pause && !pause.seek) resetSeekRecovery();
      markStable(); return true;
    }
    if (arbiter?.owns() && !force) {
      const decision = arbiter.tick(scope, nowMs, io);
      diagnostics.action = decision.reason;
      if (decision.owned) { setStatus('Catching up…'); return true; }
    }
    if (!arbiter?.owns() && !window.watchFusionHostZeroCenter?.isApplying?.() && !window.WatchFusionZeroConverge?.isApplying?.()) setViewerRate(baseRate);
    let startup = window.watchFusionYouTubeStartup?.running({...transport, nowMs, current, playing:playerState===1, buffering, drift:rawDrift, rate:baseRate,coldFast:window.WatchFusionYouTubeStartup?.coldFastEligible?.({force,bufferedOnly,isHost,state,correctiveSeeks,trackStartRecovery,scope,nowMs,arbiter,transportSeekPending,hidden:document.hidden,io,player:ytPlayer})===true});
    if (!transportSeekPending && startup?.ready && !io.mirrorContradicted() && coldJoinReady({until:coldJoinUntil,nowMs,roomPaused,force,playerState,drift:rawDrift,linked:state.linkedSourceActive===true,reference:window.watchFusionPlayout?.status?.(),matches:ytPlayer.getVideoData?.()?.video_id===state.source.videoId})) { transportSeekPending = true; coldJoinUntil = 0; }
    const manualDecoder = force && explicitSync && !bufferedOnly; const decoderMotion=!force&&window.WatchFusionDecoderRescue?.observeContinuity?.({scope,nowMs,io,position:current,rate:baseRate,playing:playerState===1,buffering,owned:!!arbiter?.owns()||!!window.WatchFusionZeroConverge?.isApplying?.(),sameVideo:ytPlayer.getVideoData?.()?.video_id===state.source.videoId})===true; if(decoderMotion&&startup)startup={...startup,ready:true,stalledMs:0,reclaim:false};
    const decoderRescue=(bufferingNow,exhausted=!bufferingNow,fastOnly=false)=>(!force||manualDecoder)&&!roomPaused&&window.WatchFusionDecoderRescue?.consider?.({scope,nowMs,exhausted,follower:io.follower===true&&!io.hostLinked,manual:manualDecoder,playing:playerState===1,buffering:bufferingNow,drift:rawDrift,position:current,stalledMs:startup?.stalledMs??0,fastOnly,qualifiedStall:window.WatchFusionDecoderRescue?.qualifiesStall?.({io,media:ytPlayer,videoId:state.source.videoId,nowMs,stalledMs:startup?.stalledMs,exhausted,buffering:bufferingNow}),
      trusted:io.referenceTrusted()&&(!manualDecoder||!io.mirrorContradicted()),sourceQualified:io.sourceReferenceQualified?.(100)===true,mirrorContradicted:io.mirrorContradicted?.()===true,sourceBuffering:io.sourceBuffering()||(io.hostLinked&&!io.hostFineHoldTrusted()),onSpent:()=>setStatus('Local playback stalled · use Sync me to restart this player'),
      reload:()=>{if(typeof ytPlayer.loadVideoById!=='function')throw Error('reload unavailable');window.watchFusionLinkedTab?.suppressPlaybackEcho?.();ytPlayer.loadVideoById({videoId:state.source.videoId,startSeconds:target+.5});replayLoads++;arbiter?.intent('pause',io);awaitSeekRecovery(nowMs);},
      rebuild:()=>{window.watchFusionLinkedTab?.suppressPlaybackEcho?.();arbiter?.intent('pause',io);window.WatchFusionDecoderRescue.rebuildPlayer(state.source.videoId,isHost()?null:target);replayLoads++;}});
    if (manualDecoder && decoderRescue(buffering, startup?.stalledMs >= 6500)) { diagnostics.action='decoder-manual-restart';setStatus('Local decoder recovery · restarting this player…');return true; }
    if (!force && startup?.stalledMs>=6000 && decoderRescue(false,true,true)) {diagnostics.action='decoder-recovery';setStatus('Local decoder recovery · restarting failed player…');return true;} if (!explicitSync && window.WatchFusionDecoderRescue?.settling?.({scope,nowMs,ready:startup?.ready===true,playing:playerState===1,buffering,position:current,rate:baseRate})) { diagnostics.action='tv-decoder-settling'; setStatus('Local decoder recovering · verifying playback…'); if (!buffering && playerState!==1 && !playerEnded) requestViewerPlayback(); return true; }
    if (!force && buffering) {
      if (decoderRescue(true)) { diagnostics.action='decoder-recovery'; setStatus('Local decoder recovery · restarting this player once…'); return true; }
      if (!viewerWasBuffering) resetDriftSensor('buffering');
      arbiter?.tick(scope, nowMs, io);
      viewerWasBuffering = true;
      return true;
    }
    if (viewerWasBuffering) { viewerWasBuffering = false; resetDriftSensor('settling'); }
    if (!force && playerEnded && duration > 0 && target >= duration - SYNC_TOLERANCE_SEC) return true;
    if (viewerSawEnded && target <= 1.5 && restartViewerFromEnded(target, baseRate)) return true;
    viewerSawEnded = false;
    if (playerState !== (window.YT?.PlayerState?.PLAYING ?? 1)) { diagnostics.action = startup?.reason || 'viewer-awaiting-play'; requestViewerPlayback(); return true; }
    if (force || transportSeekPending || startup?.reclaim) {
      if (bufferedOnly) { arbiter?.intent('calibration', io); return true; }
      if (explicitSync && absRaw < .18) arbiter?.intent('manual', io);
      else if (arbiter) arbiter.rejoinNow(nowMs, io, explicitSync ? 'manual' : force ? 'hydrate' : transportSeekPending ? 'transport' : 'reclaim');
      else if (seekViewer(target, baseRate, nowMs, explicitSync ? 'manual-sync' : 'transport-seek')) coldJoinUntil = 0;
      transportSeekPending = false;
      window.watchFusionYouTubeStartup?.seekIssued?.(!!startup?.reclaim);
      diagnostics.action = arbiter?.snapshot().reason || 'transport-seek';
      if (arbiter?.owns()) { coldJoinUntil = 0; setStatus('Catching up…'); }
      return true;
    }
    sampleDrift(rawDrift, nowMs);
    if (trackStartRecovery && !trackStartRecovery.spent && trackStartRecovery.scope === scope
        && !force && !roomPaused && playerState === 1 && !buffering
        && !arbiter?.owns() && ytPlayer.getVideoData?.()?.video_id === state.source.videoId) {
      const c = window.watchFusionPlayout?.status?.(), first = window.watchFusionYouTubeStartup?.snapshot?.()?.firstProgressDelayMs;
      const eligible = trackStartRecoveryEligible({ageMs:nowMs - trackStartRecovery.at,
        driftSec:diagnostics.filteredDriftSec, stable:diagnostics.stable,
        ready:startup?.ready === true, sourceLive:window.watchFusionPlayout?.hasSourceReference?.(c, estimatedServerNow()) === true,
        uncertaintyMs:c?.uncertaintyMs ?? null, rateList:ytPlayer.getAvailablePlaybackRates?.(),
        firstProgressMs:first, seekCount:correctiveSeeks,
        contradicted:io.mirrorContradicted()});
      if (eligible) {
        trackStartRecovery.spent = true; // one attempt only, even on rejection
        if (arbiter?.rejoinNow?.(nowMs,io,'track-start') === true) {
          diagnostics.action = 'track-start-qualified-rejoin';
          setStatus('Catching up…');
          return true;
        }
      }
    }
    if (startup?.ready === false && !arbiter?.owns()) {
      if(!force&&!isHost()&&state?.linkedSourceActive===true&&tvOwner){
        if(document.hidden||window.watchFusionPlayout?.status?.()?.source!=='live'||io.sourceBuffering?.()) {diagnostics.action='tv-reference-or-visibility-unverified';return true;}
        const m=window.WatchFusionSensorProvenance?.describe?.({media:ytPlayer,now:nowMs,clock:window.watchPartyClock?.offsetBound?.()});
        const verdict=tvOwner.motion({value:scope,at:nowMs,playing:playerState===1,buffering,
          ready:startup.ready,hidden:document.hidden,state:m?.timelineState,rate:m?.timelineRatePct,
          stalledMs:startup.stalledMs,sourceLive:window.watchFusionPlayout?.status?.()?.source==='live'&&!io.sourceBuffering?.()});
        if(verdict==='advancing') {diagnostics.action='tv-motion-proves-progress';return true;}
      }
      if (arbiter?.recoverStall?.(nowMs, io, startup.stalledMs)) { diagnostics.action = arbiter.snapshot().reason; return true; }
      const exhausted=arbiter?.snapshot().reason === 'stall-recovery-exhausted';
      if(exhausted && decoderRescue(false)){diagnostics.action='decoder-recovery';setStatus('Local decoder recovery · restarting this player once…');return true;}
      diagnostics.action=exhausted?'stall-recovery-exhausted':startup.reason;if(playerState!==1)requestViewerPlayback();return true;
    }
    if (!force && startup?.ready === true && !arbiter?.owns()) decoderRescue(false, false);
    if (isHost() && state?.linkedSourceActive && arbiter && window.WatchFusionHostPeerRecovery?.consider?.({
      scope,nowMs,hostOffsetMs:(current-target)*1000,peer:window.watchFusionPresentation?.peerCandidate?.(),observedPeer:window.watchFusionPresentation?.peerCandidate?.(true),
      sourceVerified:io.hostHoldBlocker()===null,reference:window.watchFusionPlayout?.status?.()?.reference,trusted:(()=>{const p=window.watchFusionPlayout?.status?.();return p?.source==='live'&&!p.authorityBuffering&&!io.mirrorContradicted()&&
        (p.reference==='room-clock'||(p.reference==='peer-cohort'||p.reference==='linked-tab') &&Number.isFinite(p.uncertaintyMs)&&p.uncertaintyMs<=125 &&(p.reference!=='linked-tab'||Number.isFinite(p.sourcePhaseMs)&&Math.abs(p.sourcePhaseMs)<=70))&&
        Math.abs(Date.now()-(window.watchFusionLinkedTab?.metadata?.()?.sampledAt||0))<900;})(),active:!force&&!buffering&&playerState===1&&!arbiter.owns()&&!startup?.stalledMs&&!window.watchFusionHostZeroCenter?.isApplying?.()&&!window.WatchFusionZeroConverge?.isApplying?.()
    })) {const accepted=arbiter.rejoinNow(nowMs,io,'host-peer');window.WatchFusionHostPeerRecovery?.accept?.(accepted);if(accepted){diagnostics.action='host-peer-rejoin';return true;}}
    if(isHost()&&state?.linkedSourceActive&&arbiter&&window.WatchFusionHostSourceConverge?.consider?.({scope:[roomId,state.source.videoId,state.presentationEpoch].join(':'),segment:state.playoutSegment,nowMs,errorMs:rawDrift*1000,coordination:window.watchFusionPlayout?.status?.(),sourceAgeMs:Date.now()-Number(window.watchFusionLinkedTab?.metadata?.()?.sampledAt),publisher:!!window.watchFusionLinkedTab?.publishing?.(),policyMinErrorMs:window.WatchFusionHostSeekPolicy?.MIN_HOST_REJOIN_MS,policyBlocked:!!arbiter.snapshot()?.hostSeekGuard,sameVideo:ytPlayer?.getVideoData?.()?.video_id===state?.source?.videoId,peerPresent:!!window.watchFusionPresentation?.peerCandidate?.(),contradiction:window.WatchFusionMirrorConvergenceGate?.contradicted?.(),active:!force&&!buffering&&!roomPaused&&playerState===1&&!arbiter.owns()&&!window.watchFusionHostZeroCenter?.isApplying?.()&&!window.WatchFusionZeroConverge?.isApplying?.()&&!startup?.stalledMs})){const accepted=arbiter.rejoinNow(nowMs,io,'host-source');window.WatchFusionHostSourceConverge.accept(accepted,nowMs);if(accepted){diagnostics.action='host-source-rejoin';return true;}}
    const decision = window.watchFusionHostZeroCenter?.isApplying?.() ? {owned:true,reason:'host-zero-centering'} : window.WatchFusionZeroConverge?.isApplying?.() ? {owned:true,reason:'zero-converging'} : arbiter ? arbiter.tick(scope, nowMs, io) : {owned:false, reason:'no-arbiter'};
    diagnostics.action = decision.reason;
    if (decision.owned) { setStatus('Catching up…'); return true; }
    if ((Math.abs(rawDrift) > .15 || (!isHost() && Math.abs(rawDrift) > .1005)) && diagnostics.stable) setStatus(({'tv-rate-trial-dwell':'Player offset · qualifying rate correction','tv-rate-trial-awaiting-quiet':'Player offset · waiting for stable playback','tv-rate-trial-awaiting-reference':'Player offset · waiting for fresh timing','tv-rate-trial-awaiting-motion':'Player offset · verifying playback motion','tv-rate-trial-awaiting-precision':'Player offset · timing uncertainty too high','tv-rate-trial-spent':'Player offset · correction budget used','tv-no-advertised-fine-rate':'Player offset · fine rate unavailable','output-phase-unverified':'Player offset reported · speaker phase unverified'})[decision.reason]||'Out of sync · awaiting safe correction');
    else markStable();
    diagnostics.action = decision.reason;
    requestViewerPlayback();
    return true;
  }
  window.applyAdaptiveViewerSync = applyViewerCorrection;
  window.watchFusionYouTubeTarget = (at, duration) => { refreshAnchor(false); return youtubeTarget(at, duration); };
  window.watchFusionSyncDiagnostics = () => ({
    ...diagnostics,
    correctiveSeeks,
    replayLoads,
    arbiter: arbiter?.snapshot() || null, seekGuard: null,
    deviceDelayMs: hasDeviceTiming() ? deviceDelayMs : 0,
    revision: state?.revision ?? null,
    playerState: ytPlayer?.getPlayerState?.() ?? null,
    host: isHost(),
    sourceLinked: state?.linkedSourceActive === true,
    startup: window.watchFusionYouTubeStartup?.snapshot?.() || null,
    clockOffsetMs: window.watchPartyClock?.offsetMs?.() ?? null,
    clockRttMs: window.watchPartyClock?.rttMs?.() ?? null,
    playerRate: Number(ytPlayer?.getPlaybackRate?.()) || null,
    authoritativeRate: Number(state?.playback?.rate) || null
  });
  const originalRender = render;
  render = function watchPartyAdaptiveRender() {
    refreshAnchor(true);
    const result = originalRender();
    renderDeviceTiming();
    return result;
  };
  $('deviceTimingEarlier')?.addEventListener('click', () => stageDeviceDelay(draftDeviceDelayMs - 25));
  $('deviceTimingEarlierFine')?.addEventListener('click', () => stageDeviceDelay(draftDeviceDelayMs - 5));
  $('deviceTimingSlider')?.addEventListener('input', event => stageDeviceDelay(Number(event.target?.value || 0)));
  $('deviceTimingLaterFine')?.addEventListener('click', () => stageDeviceDelay(draftDeviceDelayMs + 5));
  $('deviceTimingLater')?.addEventListener('click', () => stageDeviceDelay(draftDeviceDelayMs + 25));
  window.watchFusionSyncCenter?.bindOffset(stageDeviceDelay, () => draftDeviceDelayMs);
  $('deviceTimingApply')?.addEventListener('click', () => applyDeviceDelay(draftDeviceDelayMs));
  $('deviceTimingReset')?.addEventListener('click', () => applyDeviceDelay(0));
  function publishHostSeek() {
    if (!roomId || !ytPlayerReady || !state?.source?.videoId || followsRoomPlayback()
        || window.watchFusionLinkedTab?.active?.() || primingPlayer || playerInitializing || applyingRemote) {
      hostPositionSample = null;
      return;
    }
    const playerState = ytPlayer?.getPlayerState?.();
    if (playerState !== 1 && playerState !== 2) return;
    if (state.playback.paused !== (playerState === 2) || state.playback.ended) {
      hostPositionSample = null;
      return;
    }
    const position = Number(ytPlayer.getCurrentTime?.()), at = performance.now();
    if (!Number.isFinite(position)) return;
    const rate = Number(ytPlayer.getPlaybackRate?.()) || 1;
    const scope = roomId + ':' + state.source.videoId;
    const previous = hostPositionSample;
    hostPositionSample = {scope, position, at, rate, playing:playerState === 1};
    if (previous?.scope === scope && previous.playing === hostPositionSample.playing && previous.rate === rate
        && window.WatchFusionLinkedPlaybackSync.positionJumped(position, previous, at)) {
      window.watchFusionRoomSyncLog?.note?.('ui-intent',{action:'seek-observed',positionMs:Math.round(position*1000)});void command('seek', { position, paused: playerState === 2 }).catch(() => setStatus('Room playback is reconnecting…'));
    }
  }
  setInterval(() => {
    try {
      if (roomId && !followsRoomPlayback()) publishHostSeek();
      else { hostPositionSample = null; applyViewerCorrection(false); }
    } catch {}
  }, TICK_MS);
  setInterval(() => {
    try {
      if (roomId && followsRoomPlayback() && ytPlayerReady && ytPlayer?.getPlayerState?.() === 1)
        arbiter?.observePosition(performance.now(), Number(ytPlayer.getCurrentTime?.()));
    } catch {}
  }, 50);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshAnchor(true);
      if (roomId) applyViewerCorrection(false);
    }
  });
})();
