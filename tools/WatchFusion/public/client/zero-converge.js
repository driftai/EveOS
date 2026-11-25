/* Adaptive fine-rate controller. Replaces the existing zero-convergence owner.
 * Error = shared target minus player position, milliseconds. No seeks or holds.
 * A rate command/getter is not evidence of actual media movement. Observe raw
 * advancement and phase, bound attempts, then verify the settled residual.
 * Linked-host corrections require independent clock agreement. No speaker claims.
 */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.WatchFusionZeroConverge) return;
  const PERIOD = 250, ACTIVE_PERIOD = 50, WINDOW = 2400, MIN_SPAN = 1800;
  const ENTER = 16, OUTER = 100, MAX_HOST = 700, SETTLE = 2200;
  const MAX_ATTEMPTS = 3, RETRY_MS = 15000, ACK_LIMIT = 500;
  const MAX_FINE_COMMAND = 650, MAX_CATCHUP_COMMAND = 1800;
  const PHASE_SLACK_MS = 18, RESTORE_LIMIT = 500;
  const MEASUREMENT_REARM_MS = 60000, MAX_MEASUREMENT_REARMS = 1, EARLY_SAMPLE_MS = 150;
  let restoring = null, learnedPlayer = null, learnedRoom = '', verifiedRates = new Map();
  let lastTick = null, tickGapMs = null, maxTickGapMs = 0;
  let scope = '', samples = [], job = null, pending = null, lastAt = -Infinity;
  let reason = 'idle', pulses = 0, strikes = 0, medianMs = null, madMs = null, lastErrorMs = null;
  let model = new Map(), lastTrial = null, hostProbeUsed = false, hostProbeProven = false;
  const now = () => performance.now();
  const median = v => { const s = v.slice().sort((a,b)=>a-b); const m=s.length>>1; return s.length%2?s[m]:(s[m-1]+s[m])/2; };
  const host = () => typeof isHost === 'function' && isHost() && state?.linkedSourceActive === true;
  const arbiter = () => window.watchFusionViewerArbiter;
  const otherOwner = () => arbiter()?.owns?.() || window.watchFusionHostZeroCenter?.isApplying?.();
  const key = () => roomId && state?.playback && state?.source?.videoId ? [roomId,state.source.videoId,state.presentationEpoch,state.playoutSegment].join(':') : '';
  const target = () => window.watchFusionYouTubeTarget?.(estimatedServerNow(),ytPlayer.getDuration?.());
  const rateNow = () => Number(ytPlayer.getPlaybackRate?.());
  const note = (kind,data) => window.watchFusionRoomSyncLog?.note?.(kind,data);
  function blocked() {
    const p=state?.playback;
    if (document.hidden) return 'page-hidden';
    if (!key() || !p || p.paused || p.ended) return 'not-playing';
    if (!ytPlayer || !ytPlayerReady || playerInitializing || primingPlayer) return 'player-not-ready';
    if (ytPlayer.getPlayerState?.()!==1 || ytPlayer.getVideoData?.()?.video_id!==state.source.videoId) return 'player-not-playing';
    if (typeof isHost === 'function' && !isHost() && window.WatchFusionDecoderRescue?.isSettling?.(key(),now())) return 'tv-decoder-settling';
    if (otherOwner()) return 'other-correction-active';
    const c=window.watchFusionPlayout?.status?.();
    if (window.watchFusionPlayout?.sourceBuffering?.() || c?.authorityBuffering) return 'source-buffering';
    if (state.linkedSourceActive===true && (!c || c.source!=='live')) return 'reference-not-live';
    if (c?.mirrorContradicted || window.WatchFusionMirrorConvergenceGate?.contradicted?.()) return 'mirror-contradicted';
    if (!Number.isFinite(c?.uncertaintyMs) || c.uncertaintyMs<0 || c.uncertaintyMs>125) return 'reference-too-uncertain';
    return '';
  }
  function hostTrusted(t,e,at,catchup=false) {
    const c=window.watchFusionPlayout?.status?.(), a=arbiter()?.snapshot?.();
    const age=at-a?.timelineObservedAtMs;
    return c?.reference==='linked-tab' && c.source==='live' && Number.isFinite(c.uncertaintyMs) &&
      c.uncertaintyMs>=0 && c.uncertaintyMs<=(catchup?35:25) && age>=0 && age<=600 &&
      Number.isFinite(a?.timelineErrorMs) && Math.sign(a.timelineErrorMs)===Math.sign(e) &&
      Math.abs(a.timelineErrorMs-e)<=(catchup?25:20) &&
      window.WatchFusionHostSeekPolicy?.sourceBlocker?.(t)===null;
  }
  function finish(why,verify=false) {
    const j=job; if (!j) return;
    job=null; clearTimeout(j.timer); lastAt=now(); samples=[];
    // Keep measured motion as provisional evidence across a temporary trust veto.
    // Never continue actuation or credit motion until the same reference is qualified again.
    const interrupted=j.host && j.ack!==null && j.best>=6 &&
      ['reference-changed','reference-not-live','mirror-contradicted','reference-too-uncertain'].includes(why) &&
      key()===scope && j.player===ytPlayer && j.roomRate===state?.playback?.rate;
    try {
      // Restore only the handle we acquired. A replaced player still needs release.
      // Never overwrite a competing owner's command on the current player.
      if (j.player!==ytPlayer || !otherOwner()) {
        const r=Number(j.player.getPlaybackRate?.());
        if (!Number.isFinite(r) || Math.abs(r-j.rate)<.015 || Math.abs(r-j.base)<.015) j.player.setPlaybackRate(j.base);
      }
    } catch {}
    if (j.host && j.player===ytPlayer && !otherOwner()) restoring={player:j.player,base:j.base,rate:j.rate,at:lastAt,scope};
    reason=why;
    // An ambiguous time read is not proof of an incapable rate actuator.
    if (why==='implausible-phase-sample') { j.cap.contaminated++; j.cap.retryable++; }
    lastTrial={verificationReason:why,verdict:verify?'awaiting-settled-evidence':'inconclusive', requestedRate:j.rate,
      baseRate:j.base, elapsedMs:Math.round(lastAt-j.at), ackMs:j.ack===null?null:Math.round(j.ack-j.at),
      measuredPhaseMs:Math.round(j.best), sampleRebased:!!j.evidenceAnchor, beforeMs:Math.round(j.before), residualMs:null};
    pending=verify||interrupted?{...j,endedAt:lastAt,interrupted}:null;
    note('zero-actuator-finished',{reason:why,durationMs:lastTrial.elapsedMs,progressMs:lastTrial.measuredPhaseMs});
  }
  function discardPending(why) {
    if(!pending)return;
    // A brief mirror veto after a measured pulse is not actuator failure.
    // It cannot prove improvement, but may participate in one bounded retry.
    if(pending.host && ['mirror-contradicted','verification-context-changed'].includes(why) && pending.ack!==null && pending.best>=6 &&
        pending.player===ytPlayer && pending.roomRate===state?.playback?.rate &&
        pending.reference===window.watchFusionPlayout?.status?.()?.reference) pending.cap.retryable++;
    pending=null;
    lastTrial={...lastTrial,verdict:'inconclusive',verificationReason:why};
    note('zero-actuator-verification-lost',{reason:why});
  }
  function reset(next,why) {
    finish('interrupted'); scope=next; samples=[]; pending=null; model.clear(); pulses=strikes=0;
    if(!host() || learnedPlayer!==ytPlayer || learnedRoom!==roomId || !next){verifiedRates.clear();learnedPlayer=ytPlayer;learnedRoom=roomId;}
    medianMs=madMs=lastErrorMs=null; hostProbeUsed=hostProbeProven=false; lastTrial=null; reason=why;
  }
  function monitor() {
    const j=job; if(!j)return;
    try {
      const at=now(), elapsed=at-j.at, b=blocked();
      if (key()!==scope || j.player!==ytPlayer || b || state.playback.rate!==j.roomRate) return finish(b||'scope-changed');
      const t=target(), pos=Number(ytPlayer.getCurrentTime?.()), r=rateNow();
      if (![t,pos,r].every(Number.isFinite)) return finish('invalid-actuator-sample');
      if (window.watchFusionPlayout?.status?.()?.reference!==j.reference ||
          (host() && window.WatchFusionHostSeekPolicy?.sourceBlocker?.(t)!==null)) return finish('reference-changed');
      const err=(t-pos)*1000, progress=(pos-j.position)*1000;
      const origin=j.evidenceAnchor||{at:j.at,pos:j.position,t:j.target,err:j.beforeRaw};
      const span=at-origin.at, observed=(pos-origin.pos)*1000;
      const phase=Math.sign(j.beforeRaw)*(origin.err-err);
      const extra=Math.sign(j.rate-j.base)*(observed-span*j.base);
      const targetProgress=(t-origin.t)*1000;
      if (Math.abs((t-j.target)*1000-elapsed*j.base)>45 || progress<0 || progress>elapsed*j.base*1.8+50 ||
          observed<0 || observed>span*j.base*1.8+50) return finish('clock-or-media-discontinuity');
      // The getter marks acknowledgement, not success. Raw media advancement
      // plus signed phase change must independently support a correction.
      if (Math.abs(r-j.rate)<.015 && j.ack===null) j.ack=at;
      if (Math.abs(r-j.base)>=.015 && Math.abs(r-j.rate)>=.015) return finish('foreign-rate');
      // A rate command cannot account for more phase than its full elapsed
      // nominal contribution (including time before acknowledgement). Reject
      // discontinuous reads rather than treating them as successful movement.
      const possible=Math.abs(j.rate-j.base)*span;
      if (extra>possible+PHASE_SLACK_MS || phase>possible+PHASE_SLACK_MS ||
          Math.abs(targetProgress-span*j.base)>PHASE_SLACK_MS) {
        note('zero-actuator-sample-rejected',{durationMs:Math.round(elapsed),progressMs:Math.round(progress),expectedMs:Math.round(elapsed*j.base),phaseMs:Math.round(phase),extraMs:Math.round(extra),targetProgressMs:Math.round(targetProgress),rate:r});
        // A YouTube getter can refresh its cached timestamp just after a rate
        // change. Stop if it might already be near the target. Otherwise permit
        // ONE early evidence re-anchor, never counting the jump as actuation.
        const safeResidual=Math.max(ENTER+8, 2*(window.watchFusionPlayout?.status?.()?.uncertaintyMs||0)+20);
        if (!j.host || j.ack===null || j.evidenceAnchor || elapsed>EARLY_SAMPLE_MS ||
            elapsed+100>=j.limit || Math.sign(err)!==Math.sign(j.before) ||
            Math.abs(err)<=safeResidual || Math.abs(targetProgress-span*j.base)>PHASE_SLACK_MS) {
          return finish('implausible-phase-sample');
        }
        j.evidenceAnchor={at,pos,t,err}; j.best=0;
        j.timer=setTimeout(monitor,ACTIVE_PERIOD); return;
      }
      if (j.ack!==null && span>=100 && observed>=span*j.base*.5 && extra>=6 && phase>=6) {
        j.best=Math.max(j.best,Math.min(extra,phase));
      }
      if (j.evidenceAnchor && Math.abs(err)<=ENTER+8) return finish('rebased-near-target',j.best>=6);
      if (j.best>=Math.max(6,j.goal-j.brakeMs) || (Math.sign(err)!==Math.sign(j.before) && Math.abs(err)>ENTER)) return finish('pulse-complete',true);
      if (j.ack===null && elapsed>=ACK_LIMIT) return finish('rate-ack-timeout',true);
      if (elapsed>=j.limit) return finish('pulse-budget-complete',true);
      j.timer=setTimeout(monitor,ACTIVE_PERIOD);
    } catch { finish('actuator-error'); }
  }
  function start(at,t,pos,m,mad,base,rate,cap,catchup) {
    const raw=(t-pos)*1000;
    if (Math.sign(raw)!==Math.sign(m)||Math.abs(raw-m)>12) {reason='measurement-jitter';return;}
    const step=Math.abs(rate-base), magnitude=Math.min(Math.abs(m),Math.abs(raw));
    const goal=Math.min(magnitude*.70,magnitude-8);
    // A small offset is not enough excitation to qualify an unknown actuator.
    // Preserve fine lock rather than deliberately overshoot to prove capability.
    const precision=window.watchFusionPlayout?.status?.()?.uncertaintyMs;
    // Tight, quiet host clocks can safely attempt a small trim before the
    // residual grows past 40ms. Retain the old excitation floor otherwise.
    const tightHost=host()&&precision<=10&&mad<=3&&Math.abs(raw-m)<=6;
    const minProbe=host()?Math.max(24,2*precision+(tightHost?10:20)):24;
    if (goal<10 || (cap.status!=='verified' && Math.abs(m)<minProbe)) {reason='fine-probe-insufficient-excitation';return;}
    // Re-arm a budget of measurement-limited trials, once per scope,
    // after a new stable/qualified window and a long quiet interval. A genuine
    // no-ack or no-effect actuator never earns retries from this path.
    if (cap.attempts>=MAX_ATTEMPTS && cap.retryable===cap.attempts &&
        cap.rearms<MAX_MEASUREMENT_REARMS && at-cap.lastAt>=MEASUREMENT_REARM_MS) {
      cap.attempts=cap.contaminated=cap.retryable=0; cap.rearms++;
      note('zero-actuator-measurement-rearmed',{reason:'fresh-stable-evidence',attempts:cap.rearms});
    }
    if (cap.attempts>=MAX_ATTEMPTS || at-cap.lastAt<(cap.status==='verified'?SETTLE:RETRY_MS)) {reason=cap.attempts>=MAX_ATTEMPTS?'rate-probe-budget-exhausted':'rate-probe-cooldown';return;}
    cap.attempts++; cap.lastAt=at;
    const limit=catchup?MAX_CATCHUP_COMMAND:MAX_FINE_COMMAND;
    job={player:ytPlayer,at,position:pos,target:t,before:m,beforeRaw:raw,mad,base,rate,roomRate:state.playback.rate,
      reference:window.watchFusionPlayout?.status?.()?.reference,
      goal,limit,cap,host:host(),brakeMs:host()?Math.min(goal*.4,cap.tailMs||0):0,ack:null,best:0,evidenceAnchor:null,timer:null};
    if(host())hostProbeUsed=true;
    try {ytPlayer.setPlaybackRate(rate);} catch {finish('rate-change-failed');return;}
    job.timer=setTimeout(monitor,ACTIVE_PERIOD); samples=[]; pulses++; reason='converging-to-zero';
    note('zero-converge-pulse', {errorMs: Math.round(m),rate,durationMs:Math.round(goal/step)});
  }
  function tick() {
    const tickAt=now(); tickGapMs=lastTick===null?null:Math.round(tickAt-lastTick);lastTick=tickAt;
    if(tickGapMs!==null && tickGapMs>=0)maxTickGapMs=Math.max(maxTickGapMs,tickGapMs);
    if(tickGapMs>=1500)note('runtime-timer-gap',{durationMs:tickGapMs,hidden:document.hidden===true});
    const next=key(); if(next!==scope || (host()&&(learnedPlayer!==ytPlayer||learnedRoom!==roomId)))reset(next,'new-scope');
    if(job)return;
    const at=now(), b=blocked();
    if(restoring){
      const r=restoring;
      if(!host() || r.player!==ytPlayer || r.scope!==scope || otherOwner() || state?.playback?.rate!==r.base) restoring=null;
      else if(Math.abs(rateNow()-r.base)<.015){restoring=null;note('zero-actuator-finished',{reason:'base-rate-confirmed',durationMs:Math.round(at-r.at)});}
      else if(at-r.at>=RESTORE_LIMIT){restoring=null;discardPending('base-rate-unconfirmed');note('zero-actuator-finished',{reason:'base-rate-unconfirmed',durationMs:Math.round(at-r.at)});}
      else{reason='restoring-base-rate';return;}
    }
    if(b){samples=[];if(!pending?.interrupted || at-pending.endedAt>8000 || !['reference-not-live','mirror-contradicted','reference-too-uncertain'].includes(b))discardPending(b);reason=b;return;}
    const base=Math.min(2,Math.max(.25,Number(state.playback.rate)||1));
    if(at-lastAt<SETTLE){samples=[];reason='settling';return;}
    if(!Number.isFinite(rateNow())||Math.abs(rateNow()-base)>.015){samples=[];discardPending('manual-or-foreign-rate');reason='manual-or-foreign-rate';return;}
    const t=target(),pos=Number(ytPlayer.getCurrentTime?.());
    if(![t,pos].every(Number.isFinite)){samples=[];discardPending('no-target');reason='no-target';return;}
    const e=(t-pos)*1000;lastErrorMs=Math.round(e);
    samples.push({at,e,pos});samples=samples.filter(s=>at-s.at<=WINDOW);
    if(samples.length<8||at-samples[0].at<MIN_SPAN){reason='measuring';return;}
    const values=samples.map(s=>s.e),m=median(values),mad=median(values.map(v=>Math.abs(v-m)));
    medianMs=Math.round(m);madMs=Math.round(mad);
    const elapsed=at-samples[0].at, movement=(pos-samples[0].pos)*1000;
    const stable=mad<=9&&Math.max(...values)-Math.min(...values)<=40&&movement>=elapsed*base*.8&&movement<=elapsed*base*1.2;
    if(pending?.interrupted){
      const p=pending, continuous=Math.abs((t-p.target)*1000-(at-p.at)*p.base)<=35;
      if(p.player!==ytPlayer || p.roomRate!==state.playback.rate || at-p.endedAt>8000 || !continuous)discardPending('interrupted-evidence-expired');
      else if(!hostTrusted(t,m,at,Math.abs(m)>OUTER)){samples=[];reason='interrupted-rate-awaiting-reference';return;}
    }
    if(pending && (pending.player!==ytPlayer || pending.roomRate!==state.playback.rate ||
        pending.reference!==window.watchFusionPlayout?.status?.()?.reference ||
        (host() && window.WatchFusionHostSeekPolicy?.sourceBlocker?.(t)!==null))) discardPending('verification-context-changed');
    if(pending){
      const p=pending;
      if(!stable&&at-p.endedAt<8000){reason='rate-verification-measuring';return;}
      const improved=Math.abs(p.before)-Math.abs(m);
      const proven=stable&&at-p.endedAt<=8000&&p.ack!==null&&p.best>=6&&improved>=Math.max(6,2*(p.mad+mad)+2)&&
        (!p.interrupted || (improved<=p.best+35 && Math.sign(m)===Math.sign(p.before)));
      p.cap.status=proven?'verified':'inconclusive';
      if(proven){p.cap.attempts=p.cap.contaminated=p.cap.retryable=0;strikes=0;if(host()){
        hostProbeProven=true;const tail=Math.max(0,Math.min(150*Math.abs(p.rate-p.base),improved-p.best));
        p.cap.tailMs=p.cap.tailMs==null?tail:(p.cap.tailMs+tail)/2;
        if(verifiedRates.size>=16)verifiedRates.delete(verifiedRates.keys().next().value);
        verifiedRates.set(p.base+':'+p.rate,{tailMs:p.cap.tailMs});
      }}else {
        // Clean raw motion with a neutral settled result is ambiguous, not
        // proof of a dead actuator. Do not rearm a no-motion or worsening trial.
        if(p.host&&stable&&at-p.endedAt<=8000&&p.ack!==null&&p.best>=6&&improved>=-3) p.cap.retryable++;
        strikes++;if(host())verifiedRates.delete(p.base+':'+p.rate);
      }
      lastTrial={...lastTrial,verdict:p.cap.status,verificationReason:proven?'settled-improvement':'settled-insufficient-evidence',residualMs:Math.round(m),improvementMs:Math.round(improved)};
      note('zero-actuator-verified',{reason:p.cap.status,beforeMs:Math.round(p.before),residualMs:Math.round(m),progressMs:Math.round(improved)});
      pending=null;
    }
    if(!stable){reason='measurement-jitter';return;}
    if(Math.abs(m)<=ENTER){reason='zero-band';return;}
    const catchup=host()&&m>OUTER&&m<=MAX_HOST;
    if(Math.abs(m)>OUTER&&!catchup){reason='outside-fine-band';return;}
    if(host()&&!hostTrusted(t,m,at,catchup)){reason='host-locked-dual-clock-unverified';return;}
    const rates=(ytPlayer.getAvailablePlaybackRates?.()||[]).filter(r=>Number.isFinite(r)&&Math.sign(r-base)===Math.sign(m)&&Math.abs(r-base)>=.03&&Math.abs(r-base)<=.26).sort((a,b)=>Math.abs(a-base)-Math.abs(b-base));
    if(!rates.length){reason='fixed-rate-player';return;}
    const rate=rates[0], id=base+':'+rate;
    if(!model.has(id)){if(model.size>=16)model.delete(model.keys().next().value);model.set(id,{status:host()&&verifiedRates.has(id)?'verified':'unknown',tailMs:host()?verifiedRates.get(id)?.tailMs??0:0,attempts:0,contaminated:0,retryable:0,rearms:0,lastAt:-Infinity});}
    start(at,t,pos,m,mad,base,rate,model.get(id),catchup);
  }
  setInterval(()=>{try{tick();}catch{reset('','converge-error');}},PERIOD);
  document.addEventListener('visibilitychange',()=>{if(document.hidden){
    // Release the actuator immediately; do not erase same-segment budgets
    // or learned capability just because the window lost visibility.
    finish('page-hidden'); discardPending('page-hidden'); samples=[]; reason='page-hidden';
  }});
  window.WatchFusionZeroConverge={version:'adaptive-actuator-06i',isApplying:()=>!!job||!!restoring||now()-lastAt<600,
    diagnostics:()=>({reason,pulses,strikes,tickGapMs,maxTickGapMs,restoring:!!restoring,errorMs:lastErrorMs,medianMs,madMs,active:!!job,
      hostRateRecheck:{used:hostProbeUsed,measuredImprovement:hostProbeProven},
      actuator:lastTrial,capabilities:[...model].map(([rate,v])=>({rate,status:v.status,attempts:v.attempts,contaminated:v.contaminated,retryable:v.retryable,rearms:v.rearms}))})};
})();
