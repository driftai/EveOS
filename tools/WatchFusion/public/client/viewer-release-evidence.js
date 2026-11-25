/* WatchFusion 8x-r5: bounded release/decoder proof and source-stall hold eligibility.
 * Observation only. The existing viewer arbiter remains the sole actuator.
 * No speaker phase is inferred from YouTube's currentTime().
 */
(() => {
  'use strict';
  const LATE_RELEASE_RETRY_WINDOW_MS = 22000;

  function createReleaseEvidence() {
    let postRelease = null;
    function reset() { postRelease = null; }
    function start(at) {
      postRelease = {at, previous:null, sampleAt:0, firstAt:null,
        lastAdvanceAt:null, invalid:false, sourceFault:false, interrupted:false};
    }
    function observe(nowMs, io) {
      const p = postRelease;
      if (!p || nowMs-p.at > LATE_RELEASE_RETRY_WINDOW_MS || p.invalid || p.sourceFault) return;
      const state = io.state();
      // Decoder startup can buffer before the first advance. A later interruption changes the measured lag.
      if (state === 3 && p.firstAt !== null) p.interrupted = true;
      if (nowMs-p.at > 12000) return;
      if (io.sourceBuffering?.() || io.referenceTrusted?.() !== true || (io.hostLinked && io.hostFineHoldTrusted?.() !== true)) {
        p.sourceFault = true;
        return;
      }
      if (state !== 1) return;
      const current = io.current();
      if (!Number.isFinite(current)) { p.invalid = true; return; }
      if (p.previous === null) { p.previous = current; p.sampleAt = nowMs; return; }
      const dt = nowMs-p.sampleAt, delta = current-p.previous;
      if (dt <= 0) return;
      if (delta < -.05 || delta > dt/1000*io.baseRate*1.8+.3) {
        p.invalid = true;
        return;
      }
      // Accumulate sub-frame polls. Rebaselining on every short tick can
      // prevent a genuinely advancing decoder from ever proving 120 ms.
      if (delta < .12 && dt < 1000) return;
      if (delta >= .12 && dt <= 1000) {
        if (p.firstAt === null) p.firstAt = nowMs;
        if (p.lastAdvanceAt !== null && nowMs-p.lastAdvanceAt > 1000) p.invalid = true;
        p.lastAdvanceAt = nowMs;
      } else if (p.firstAt !== null && nowMs-p.lastAdvanceAt > 1000) p.invalid = true;
      p.previous = current;
      p.sampleAt = nowMs;
    }
    function qualified(c, nowMs) {
      const p = postRelease;
      return !!(p && c.releaseVerified && c.releasedAt === p.at && nowMs-p.at <= 12000 && !p.invalid && !p.sourceFault && !p.interrupted
        && p.firstAt !== null && p.lastAdvanceAt !== null && p.firstAt-p.at >= 0
        && p.firstAt-p.at <= 1200 && nowMs-p.firstAt >= 1600
        && nowMs-p.lastAdvanceAt <= 550);
    }
    function snapshot(c, nowMs) {
      const p = postRelease;
      return p ? {firstProgressDelayMs:p.firstAt === null ? null : Math.round(p.firstAt-p.at),
        invalid:p.invalid, sourceFault:p.sourceFault, qualified:qualified(c,nowMs)} : null;
    }
    function canRetry(c) {
      const p = postRelease;
      return !!(p && c?.releasedAt === p.at && p.firstAt !== null && !p.interrupted && !p.invalid && !p.sourceFault);
    }
    return {reset, start, observe, qualified, snapshot, canRetry};
  }

  function sourceRecoveryHoldEligible({error,recovery,trust,uncertainty,rates,buffering}) {
    return error <= -.20 && error >= -.44 && trust === true && buffering !== true
      && Number.isFinite(uncertainty) && uncertainty >= 0 && uncertainty <= 70
      && Array.isArray(rates) && rates.length === 1 && Math.abs(rates[0]-1) < .01
      && recovery && Number.isInteger(recovery.sequence) && recovery.sequence > 0
      && Number.isFinite(recovery.ageMs) && recovery.ageMs >= 900 && recovery.ageMs <= 15000
      && recovery.source === 'live' && recovery.reference === 'linked-tab'
      && !recovery.authorityBuffering && Number.isFinite(recovery.uncertaintyMs)
      && recovery.uncertaintyMs <= 70;
  }

  function createSourceRecoveryGate() {
    const consumed = new Set();
    let candidate = null;
    function cancelCandidate() { candidate = null; }
    function consider({error,io,scope,nowMs}) {
      const recovery = io.recentSourceRecovery?.();
      const key = recovery ? scope.split(':').slice(0,-1).join(':')+':'+recovery.sequence : '';
      const qualified = sourceRecoveryHoldEligible({error,recovery,
        trust:io.referenceTrusted?.(), uncertainty:io.referenceUncertaintyMs?.(),
        rates:io.availableRates(), buffering:io.sourceBuffering?.()});
      if (!qualified || consumed.has(key)) { candidate = null; return false; }
      if (!candidate || candidate.key !== key || Math.abs(candidate.error-error) > .08) {
        candidate = {key,error,at:nowMs};
        return false;
      }
      if (nowMs-candidate.at < 1500) return false;
      consumed.add(key);
      candidate = null;
      return true;
    }
    return {consider, cancelCandidate, count:() => consumed.size};
  }

  // One safe per-video decision after a long, genuine, progressing, stable lead.
  // A 1x TV cannot be fine-rate nudged; never turn 150ms into a blind keyframe seek.
  // Only hold if predicted pause duration is >=80ms *after* known release latency.
  // Otherwise adjust the NEXT release model <=40ms with no current playback action.
  function createFixedRateFineGate() {
    const spent=new Set();let candidate=null,reason='idle',decisions=0;
    function cancelCandidate(){candidate=null;}
    function snapshot(){return {reason,decisions,watching:!!candidate};}
    function consider({scope,nowMs,error,io,verifiedFixed=false,releaseLatencyMs,quietStallMs}) {
      const key=scope.split(':').slice(0,3).join(':');
      const precision=io.referenceUncertaintyMs?.(); const rates=io.availableRates?.();
      // A separate mirror clock can disagree despite a stable, low-uncertainty
      // linked-tab timeline. Never use that exception for a live hold or seek.
      const c=globalThis.watchFusionPlayout?.status?.(), mirrored=io.mirrorContradicted?.()===true;
      const modelOnly=Number.isFinite(error)&&error>=.11&&error<=.24;
      const isolated=mirrored&&modelOnly&&c?.source==='live'&&c.reference==='linked-tab'
        &&c.authorityBuffering!==true&&Number.isFinite(c.sourcePhaseMs)&&Math.abs(c.sourcePhaseMs)<=15
        &&Number.isFinite(c.uncertaintyMs)&&c.uncertaintyMs>=0&&c.uncertaintyMs<=20
        &&Number.isFinite(quietStallMs)&&quietStallMs>=30000;
      const fixed=Array.isArray(rates) && ((rates.length===1&&Math.abs(rates[0]-io.baseRate)<.01)
        ||(modelOnly&&verifiedFixed===true&&rates.some(x=>Number.isFinite(x)&&Math.abs(x-io.baseRate)<.01)));
      const good=io.hostLinked!==true && io.state?.()===1 && io.referenceTrusted?.()===true
        && io.sourceBuffering?.()!==true && (!mirrored||isolated)
        && Number.isFinite(precision) && precision>=0 && precision<=45
        && fixed
        && Number.isFinite(error) && ((error<=-.125 && error>=-.28)||(error>=.11 && error<=.24))
        && Number.isFinite(releaseLatencyMs) && releaseLatencyMs>=0 && releaseLatencyMs<=2000
        && Number.isFinite(quietStallMs) && quietStallMs>=15000;
      if(spent.has(key)){reason='already-consumed-for-video';candidate=null;return null;}
      if(!good){reason='capability-or-evidence-unverified';candidate=null;return null;}
      if(!candidate || candidate.key!==key || Math.abs(candidate.error-error)>.035 || nowMs-candidate.lastAt>1000) {
        candidate={key,error,at:nowMs,lastAt:nowMs,samples:1};reason='dwell';return null;
      }
      candidate.samples++;candidate.lastAt=nowMs;
      if(nowMs-candidate.at<12000 || candidate.samples<8){reason='dwell';return null;}
      spent.add(key);candidate=null;decisions++;
      if(error>0){reason=isolated?'next-release-mirror-isolated-model-only':'next-release-lag-bias-only';return {action:'learn',reason};}
      // Never attempt a zero-duration hold: TV pause/play may introduce a new decoder stall.
      if(-error*1000-releaseLatencyMs>=80 && -error*1000-releaseLatencyMs<=280) {
        reason='one-qualified-hold';return {action:'hold'};
      }
      reason='model-only-learning';return {action:'learn'};
    }
    function refine(input, model, lastStallAt, save, noteChange) {
      const {error, nowMs} = input;
      const decision = consider({...input, releaseLatencyMs:model.releaseLatencySec*1000,quietStallMs:Math.min(1e9,nowMs-lastStallAt)});
      if (decision?.action === 'learn') {
        const priorMs = Math.round(model.releaseLatencySec*1000);
        const bias = Math.min(.04, Math.max(-.04, error*.25));
        model.releaseLatencySec = Math.min(2, Math.max(0, model.releaseLatencySec+bias));
        save();
        noteChange({beforeMs:priorMs,
          afterMs:Math.round(model.releaseLatencySec*1000),errorMs:Math.round(error*1000),reason:decision.reason});
      }
      return decision?.action;
    }
    return {consider,refine,cancelCandidate,snapshot};
  }

  // A hard-budgeted rejoin for a *verified fixed-rate* TV after a stable
  // post-resume phase plateau. Reuses the existing paused/keyframe-aware arbiter
  // actuator; it does not seek itself, synthesize clock confidence or infer sound.
  function createFixedRatePlateauRecoveryGate() {
    const videos = new Map();
    let candidate=null,reason='idle',total=0;
    function cancelCandidate(){candidate=null;}
    function snapshot(){return {reason,attempts:total,watching:!!candidate};}
    function consider({scope,nowMs,error,io,quietStallMs,quietRejoinMs,leadSec,verifiedFixed=false}) {
      if(typeof scope!=='string' || scope.split(':').length<4 || !Number.isFinite(nowMs)){
        reason='invalid-scope-or-clock';candidate=null;return null;
      }
      const videoKey=scope.split(':').slice(0,3).join(':');
      const history=videos.get(videoKey);
      if(history && (history.count>=2 || history.segments.has(scope) || nowMs-history.lastAt<45000)){
        reason='per-video-segment-or-cooldown-budget';candidate=null;return null;
      }
      const precision=io.referenceUncertaintyMs?.(), rates=io.availableRates?.();
      const validPhase=Number.isFinite(error) && ((error>=.24 && error<=.43) || (error<=-.27 && error>=-.43));
      // Explicit 1x-only capability: an optimistic rate claim is not evidence.
      const fixed=Number.isFinite(io.baseRate) && Math.abs(io.baseRate-1)<.01 &&
        ((Array.isArray(rates) && rates.length===1 && Number.isFinite(rates[0]) &&
          Math.abs(rates[0]-io.baseRate)<.01) || verifiedFixed===true);
      const safe=validPhase && fixed && io.hostLinked!==true && io.state?.()===1 &&
        io.referenceTrusted?.()===true && io.sourceBuffering?.()!==true &&
        io.mirrorContradicted?.()!==true && Number.isFinite(precision) &&
        precision>=0 && precision<=40 && Math.abs(error)*1000-precision>=180 &&
        Number.isFinite(quietStallMs) && quietStallMs>=20000 &&
        Number.isFinite(quietRejoinMs) && quietRejoinMs>=30000 &&
        Number.isFinite(leadSec) && leadSec>=.35 && leadSec<=10;
      if(!safe){reason='precision-capability-or-healthy-playback-unverified';candidate=null;return null;}
      // Landing-aware rejoin is safe only if the paused seek can land without
      // a new network fetch. No blind keyframe hop, reload or pause/play pulse.
      const target=Number(io.target?.(nowMs));
      const needed=target+leadSec+1.5;
      if(!Number.isFinite(target)||!Number.isFinite(needed)||needed<0 ||
         io.buffered?.(needed)!==true){reason='unbuffered-landing-risk';candidate=null;return null;}
      if(!candidate||candidate.scope!==scope||Math.sign(candidate.error)!==Math.sign(error)||
         Math.abs(candidate.error-error)>.045||nowMs-candidate.lastAt>1000||nowMs<candidate.lastAt){
        candidate={scope,error,since:nowMs,lastAt:nowMs,samples:1};reason='stable-plateau-dwell';return null;
      }
      candidate.samples++;candidate.lastAt=nowMs;
      if(nowMs-candidate.since<12000||candidate.samples<8){reason='stable-plateau-dwell';return null;}
      const rec=history||{count:0,lastAt:-Infinity,segments:new Set()};
      rec.count++;rec.lastAt=nowMs;rec.segments.add(scope);videos.set(videoKey,rec);
      // Bound in-memory history without affecting recent per-video budgets.
      if(videos.size>32)videos.delete(videos.keys().next().value);
      candidate=null;total++;reason='bounded-rejoin-qualified';
      return {action:'rejoin'};
    }
    return {consider,cancelCandidate,snapshot};
  }


  // R14x: a follower's post-release callback and its decoder cannot both own recovery.
  // This policy observes the iframe media timeline only; it never controls the player.
  function createTvRecoveryOwner() {
    let identity='', releasedAt=-Infinity, last='idle', blocks=0, held={since:-1,lastAt:-1,reads:0};
    let retryCandidate=null, retriedThisVideo=false;
    const mediaKey = value => String(value||'').split(':').slice(0,3).join(':');
    function scope(value) {
      const key=mediaKey(value);
      if (key!==identity) {identity=key;releasedAt=-Infinity;held={since:-1,lastAt:-1,reads:0};retryCandidate=null;retriedThisVideo=false;last='new-video';}
    }
    function release(value,at) {scope(value);if(Number.isFinite(at)){releasedAt=at;retryCandidate=null;last='release-observed';}}
    function block(value,at,error,why,io) {
      scope(value);
      if (!io?.follower || io?.linkedSourceActive?.()!==true || io.hostLinked || why==='manual') return false;
      const age=at-releasedAt;
      if (!(Number.isFinite(age)&&age>=0&&age<25000&&Number.isFinite(error))) return false;
      if (why==='stall' || (Math.abs(error)>4 && io.referenceTrusted?.()===true)) return false;
      // A healthy advancing TV may nevertheless remain seconds behind after its
      // first release. The old blanket 25s duplicate guard then prevented any
      // recovery for a short next video. Permit exactly ONE buffered retry per
      // video, after observing real decoder progress and a stable large lag.
      // Stalled/buffering/untrusted players retain the decoder-first policy.
      const target=io.target?.(at), current=io.current?.();
      const uncertainty=io.referenceUncertaintyMs?.();
      const candidateOk=!retriedThisVideo && age>=4500 && age<20000 &&
        error>=2.5 && error<=4 && io.state?.()===1 &&
        io.referenceTrusted?.()===true && io.sourceReferenceQualified?.(100)===true &&
        io.sourceBuffering?.()!==true && io.mirrorContradicted?.()!==true &&
        Number.isFinite(uncertainty) && uncertainty>=0 && uncertainty<=35 &&
        Number.isFinite(target) && Number.isFinite(current) &&
        io.buffered?.(target+4)===true;
      if(candidateOk) {
        const c=retryCandidate;
        const stable=!!c && at>=c.lastAt && at-c.lastAt<=1500 &&
          Math.abs(c.error-error)<=.14 && current>=c.current;
        if(!stable)retryCandidate={since:at,lastAt:at,error,current,reads:1,progress:0};
        else {
          const dt=(at-c.lastAt)/1000,dp=current-c.current;
          if(dt>0 && dp>=dt*.5 && dp<=dt*1.5) {
            c.lastAt=at;c.current=current;c.error=error;c.reads++;c.progress+=dp;
            if(at-c.since>=2200 && c.reads>=4 && c.progress>=1.2) {
              retriedThisVideo=true;retryCandidate=null;
              last='one-buffered-post-release-retry';return false;
            }
          } else retryCandidate=null;
        }
      } else retryCandidate=null;
      last='post-release-duplicate-blocked';blocks++;return true;
    }
    function motion({value,at,playing,buffering,ready,hidden,state,rate,stalledMs,sourceLive}) {
      scope(value);
      const clear=()=>{held={since:-1,lastAt:-1,reads:0};};
      if(!identity || !Number.isFinite(at)||hidden||!playing||buffering||ready!==false||sourceLive!==true){clear();return 'not-eligible';}
      if(state==='advancing'&&Number.isFinite(rate)&&rate>=70&&rate<=135){clear();last='decoder-advancing';return 'advancing';}
      if(state!=='held'||!Number.isFinite(rate)||rate<0||rate>15){clear();last='motion-unverified';return 'observe';}
      if(held.since<0||at<held.lastAt||at-held.lastAt>1500)held={since:at,lastAt:at,reads:1};
      else {held.lastAt=at;held.reads++;}
      const duration=at-held.since;
      if(held.reads>=4&&duration>=1200&&Math.max(Number(stalledMs)||0,duration)>=6500){last='decoder-first-qualified';return 'decoder';}
      last='held-witness-building';return 'observe';
    }
    function heldMs(at){return held.since>=0&&Number.isFinite(at)?Math.max(0,at-held.since):0;}
    function snapshot(){return {owner:last,blocks,heldReads:held.reads};}
    return {scope,release,block,motion,heldMs,snapshot};
  }

  // The stable lag plus the lead at play() estimates the decoder's start delay.
  // Reuse it for one buffered retry without changing the stored latency model.
  function createLateReleaseRetryGate() {
    const attempts = new Set();
    let candidate = null;
    function consider({scope, nowMs, error, io, correction}) {
      const c = correction;
      const ageMs = nowMs - c?.releasedAt;
      const precisionMs = io.referenceUncertaintyMs?.();
      const target = io.target(nowMs);
      const latency = (c?.releaseLeadSec + error) / io.baseRate;
      const eligible = c?.automaticRelease && io.follower === true && !io.hostLinked &&
        io.state() === 1 && io.referenceTrusted?.() === true &&
        io.sourceReferenceQualified?.() === true && Number.isFinite(c.releaseLeadSec) &&
        !io.sourceBuffering?.() && !io.mirrorContradicted?.() &&
        Number.isFinite(precisionMs) && precisionMs >= 0 && precisionMs <= 35 &&
        error >= .65 && error <= 2.5 && ageMs >= 4000 && ageMs <= LATE_RELEASE_RETRY_WINDOW_MS &&
        Math.abs(target - c.releaseTarget - ageMs / 1000 * io.baseRate) <= .08 &&
        latency >= .35 && latency <= 2;
      if (!eligible || attempts.has(scope)) { candidate = null; return null; }
      if (candidate?.scope !== scope || candidate.correction !== c || nowMs - candidate.lastAt > 1000 ||
          Math.abs(candidate.error - error) > .06) {
        candidate = {scope, correction: c, since: nowMs, lastAt: nowMs, error};
        return null;
      }
      candidate.lastAt = nowMs;
      return nowMs - candidate.since >= 2500 ? latency : null;
    }
    function spend(scope) {
      if (attempts.size >= 32) attempts.delete(attempts.values().next().value);
      attempts.add(scope);
      candidate = null;
    }
    return {consider, spend};
  }

  // A source-qualified trial for a TV that previously rejected speed control.
  // A coarse trial with inconclusive rate evidence may leave a stable final lag.
  function createTvRateRecheckGate() {
    const spent=new Map();let candidate=null,reason='idle',attempts=0,lock=null;
    const videoKey=scope=>String(scope||'').split(':').slice(0,3).join(':');
    function settle(scope, verdict, job, io) {
      const trial=spent.get(videoKey(scope));
      if(trial?.scope!==scope)return;
      trial.verdict=verdict;
      const elapsed=(io?.now?.()-job?.probe?.nowMs)/1000;
      const extra=(io?.current?.()-job?.probe?.current)-elapsed*io?.baseRate;
      const expected=(job?.rate-io?.baseRate)*elapsed;
      trial.motion=Number.isFinite(elapsed)&&elapsed>=.5&&elapsed<=12&&Math.sign(extra)===Math.sign(expected)&&
        Math.abs(extra)>=.12&&Math.abs(extra-expected)<=.07;
      if(!trial.finish && !verdict && (trial.error>=.45 || (trial.error>=.25 && trial.motion)))trial.mayFinish=true;
    }
    // A new disturbance after a genuinely healthy lock is not the same failed
    // episode. Never rearm an ineffective or rejected actuator from a lock flag.
    function observeLock(scope,nowMs,error,io){
      const key=videoKey(scope),prior=spent.get(key);
      if(!prior||prior.scope!==scope||prior.verdict==='rejected'||!(prior.motion||prior.verdict==='honored')||
        !Number.isFinite(error)||Math.abs(error)>.05||io.state?.()!==1||io.sourceReferenceQualified?.(100)!==true||
        io.referenceTrusted?.()!==true||io.sourceBuffering?.()||io.mirrorContradicted?.()||
        !Number.isFinite(io.referenceUncertaintyMs?.())||io.referenceUncertaintyMs()<0||io.referenceUncertaintyMs()>35){lock=null;return;}
      const pos=io.current?.(),target=io.target?.(nowMs);
      if(!Number.isFinite(pos)||!Number.isFinite(target)||Math.abs(target-pos)>.05){lock=null;return;}
      if(!lock||lock.scope!==scope||nowMs-lock.last>1000||nowMs<lock.last||
        Math.abs(pos-lock.pos-(nowMs-lock.last)*io.baseRate/1000)>.06)lock={scope,at:nowMs,last:nowMs,pos};
      lock.last=nowMs;lock.pos=pos;
      if(nowMs-lock.at>=15000){spent.delete(key);candidate=null;lock=null;reason='healthy-lock-rearmed';}
    }
    function consider({scope,nowMs,error,io,rateHonored,quietStallMs,quietRejoinMs}) {
      const key=videoKey(scope),rates=io.availableRates?.();
      const alternate=Array.isArray(rates) ? rates.filter(r=>Number.isFinite(r)&&r>0&&
        (error<0 ? r>=io.baseRate*.74&&r<=io.baseRate*.96 : r>=io.baseRate*1.04&&r<=io.baseRate*1.26) &&
        (error<=.85 || (r-io.baseRate)*10>=error))
        .sort((a,b)=>Math.abs(a-io.baseRate)-Math.abs(b-io.baseRate))[0] : null;
      const prior=spent.get(key);
      // The first burst may have helped without proving its actuator. A meaningful
      // same-direction reduction can earn one finish, but not an ineffective trial.
      const improvement=prior ? prior.error-Math.abs(error) : 0;
      const finishing=prior?.mayFinish===true && !prior.finish && prior.scope===scope &&
        ((error>=.115 && error<=.43 && improvement>=.20 && improvement>=prior.error*.35) ||
        (error<=-.115 && error>=-.43 && (improvement>=.25 ||
          (prior.error>=.25 && prior.error<.45 && prior.motion && improvement>=.12 && improvement>=prior.error*.35))));
      if (prior && !finishing){reason='per-video-trial-spent';candidate=null;return null;}
      const precision=io.referenceUncertaintyMs?.();
      const largeLag = error >= .35;
      const eligible=key.split(':').length===3 && rateHonored===false && !!alternate &&
        io.follower===true && io.hostLinked!==true && io.linkedSourceActive?.()===true &&
        io.sourceReferenceQualified?.(100)===true && io.state?.()===1 &&
        io.referenceTrusted?.()===true && io.sourceBuffering?.()!==true && io.mirrorContradicted?.()!==true &&
        Number.isFinite(precision)&&precision>=0&&precision<=35 &&
        Number.isFinite(error)&&error>=-.43&&error<=2.5&&Math.abs(error)>=.115 &&
        Number.isFinite(nowMs)&&quietStallMs>=(largeLag?5000:20000)&&quietRejoinMs>=(largeLag?6000:25000);
      if(!eligible){
        // An advancing, rate-advertising TV must not fall through to a seek just
        // because fresh source evidence or post-release quiet time is missing.
        const waiting=error>=.45 && error<=2.5 && rateHonored===false && !!alternate &&
          io.follower===true && !io.hostLinked && io.linkedSourceActive?.()===true && io.state?.()===1;
        reason=waiting?'rate-trial-awaiting-qualified-reference':!alternate?'no-advertised-rate-actuator':'source-motion-or-quiet-time-not-qualified';candidate=null;return null;
      }
      if(!candidate || candidate.scope!==scope || candidate.rate!==alternate || Math.sign(candidate.error)!==Math.sign(error) ||
          Math.abs(candidate.error-error)>.035 || nowMs-candidate.lastAt>1000 || nowMs<candidate.lastAt){
        candidate={scope,rate:alternate,error,at:nowMs,lastAt:nowMs,samples:1};reason='stable-rate-trial-dwell';return null;
      }
      candidate.samples++;candidate.lastAt=nowMs;
      const dwellMs=finishing ? 4000 : largeLag ? 2500 : 10000;
      if(nowMs-candidate.at<dwellMs || candidate.samples<8){reason='stable-rate-trial-dwell';return null;}
      spent.set(key,{scope,error,finish:finishing});
      candidate=null;attempts++;reason=finishing?'single-advertised-rate-finish':'single-advertised-rate-trial';
      return {rate:alternate};
    }
    return {consider,settle,observeLock,snapshot:()=>({reason,attempts,watching:!!candidate||reason==='rate-trial-awaiting-qualified-reference'})};
  }

  // The duration estimate is a ceiling, not a reason to keep moving past the target.
  // A raw reading can stop a burst early; only settled evidence may prove success.
  function viewerRateBrake(job,io,nowMs) {
    if(job.recheck!==true || io.follower!==true || io.hostLinked===true || io.linkedSourceActive?.()!==true ||
       Math.abs(job.before)<.10 || io.sourceReferenceQualified?.(100)!==true ||
       io.referenceTrusted?.()!==true || io.sourceBuffering?.()===true || io.mirrorContradicted?.()===true) return false;
    const error=io.target(nowMs)-io.current(), precision=io.referenceUncertaintyMs?.();
    return Number.isFinite(error)&&Number.isFinite(precision)&&precision>=0&&precision<=35&&
      Math.sign(job.before)*error<=.025;
  }

  // Classify actual raw IFrame timeline movement, not an API rate-setting ack.
  // Short subsecond bursts otherwise end before the old 1600ms probe begins.
  function classifyRateProbe(job,io,nowMs) {
    const elapsed=(nowMs-job?.probe?.nowMs)/1000;
    if(!Number.isFinite(elapsed)||elapsed<.55||elapsed>15||io.state?.()!==1||
       io.sourceBuffering?.()===true||io.referenceTrusted?.()!==true||io.mirrorContradicted?.()===true) return 'unverified';
    const current=io.current?.(),start=job.probe.current,base=io.baseRate,trial=job.rate;
    if(![current,start,base,trial].every(Number.isFinite))return 'unverified';
    const actual=current-start-base*elapsed,expected=(trial-base)*elapsed;
    if(Math.abs(expected)<.11 || current-start<elapsed*.4 || current-start>elapsed*1.6)return 'unverified';
    if(Math.abs(actual-expected)<=Math.min(.07,Math.abs(expected)*.38))return 'honored';
    if(Math.abs(actual)<=Math.min(.055,Math.abs(expected)*.32))return 'rejected';
    return 'unverified';
  }

  // A delayed callback may restore ordinary playback, but cannot certify an on-time
  // release or teach a device's latency. Identity is checked even without a tick.
  function timedCompletion(expected, active, io) {
    if (!expected || expected !== active || expected.valid?.() === false || io.valid?.() === false) return 'stale';
    const lateness = io.now()-expected.dueAt;
    return !Number.isFinite(lateness) || lateness > 150 ? 'late' : 'on-time';
  }
  globalThis.WatchFusionReleaseEvidence = Object.freeze({timedCompletion,
    createReleaseEvidence, sourceRecoveryHoldEligible, createSourceRecoveryGate,
    createFixedRateFineGate, createFixedRatePlateauRecoveryGate, createLateReleaseRetryGate,
    createTvRateRecheckGate, classifyRateProbe, viewerRateBrake, tvRecoveryOwner:createTvRecoveryOwner()
  });
})();
