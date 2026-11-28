/* v13.10.5: bounded Play-intent continuity for linked playlist transitions.
 * Operates only on the authoritative linked tab; never changes room authority.
 * A deliberate pause wins: a room/toolbar pause outside a transition, or a
 * pause in the source tab that persists on the same video. A pause produced by
 * WatchFusion's own preview load during a transition is not a deliberate pause.
 * A browser autoplay restriction is not bypassed: at most 2 Play requests.
 */
(() => {
  'use strict';
  const GRACE_MS = 1100, RETRY_MS = 2600, TIMEOUT_MS = 12000, MAX_ATTEMPTS = 2;
  const STABLE_MS = 6000, TRANSITION_MS = 6000, PREVIEW_MS = 4500, SOURCE_PAUSE_MS = 2500;
  let lastUrl = '', lastPlayingAt = -Infinity, lastPauseAt = -Infinity, pendingPause = null;
  let plan = null, outcome = 'idle', totalAttempts = 0, lastTransitionAt = -Infinity;
  let previewId = '', previewLoadedAt = -Infinity, previewPauseGuarded = false;
  const clock = () => Date.now();
  const note = (kind, detail = {}) => globalThis.watchFusionRoomSyncLog?.note?.(kind, detail);
  const inTransition = now => now - Math.max(lastTransitionAt, previewLoadedAt) < TRANSITION_MS;
  function manualPause(now = clock(), explicit = false) {
    // Only a classified preview echo may defer a pause. Explicit room commands win.
    if (!explicit && plan && inTransition(now)) { plan.previewEchoAt = now; outcome = 'pause-deferred'; note('playlist-pause-deferred'); return false; }
    lastPauseAt = now; pendingPause = null; plan = null; outcome = 'explicit-pause-preserved';
    note('playlist-pause-preserved');
    return true;
  }
  function onTransition(previous, next, {eligible = false, now = clock()} = {}) {
    const oldUrl = String(previous?.pageUrl || ''), nextUrl = String(next?.pageUrl || '');
    if (!nextUrl || oldUrl === nextUrl) return false;
    pendingPause = null; // a pause sample right before a track change is the change, not a choice
    const wasPlaying = lastPlayingAt > lastPauseAt && (previous?.paused === false || now - lastPlayingAt < 15000);
    lastUrl = nextUrl; lastTransitionAt = now; plan = null;
    outcome = wasPlaying && eligible ? 'transition-grace' : 'transition-paused';
    note('playlist-transition', {reason:outcome});
    if (!wasPlaying || !eligible) return false;
    // Armed even when the new video already plays: a late preview echo can still pause it.
    plan = {url:nextUrl,at:now,lastAttemptAt:-Infinity,attempts:0,hadPlayed:false,previewEchoAt:-Infinity};
    return true;
  }
  function observe(sample, {eligible = false, connected = false, pending = false,
    send = null, now = clock()} = {}) {
    const url = String(sample?.pageUrl || '');
    if (!url) return false;
    if (lastUrl && lastUrl !== url) { plan = null; pendingPause = null; outcome = 'source-changed'; }
    lastUrl = url;
    if (sample?.paused === false && !sample?.ended) {
      lastPlayingAt = now; pendingPause = null;
      if (plan && plan.url === url) { plan.hadPlayed = true; plan.previewEchoAt = -Infinity; }
      if (plan && now - plan.at >= STABLE_MS) { note('playlist-resume-confirmed', {attempts:plan.attempts}); plan = null; }
      outcome = plan ? 'playing-verifying' : 'playing'; return false;
    }
    // A new source-tab Pause after the new video was observed PLAYING is a user
    // decision unless we know an actual preview echo caused it. Never auto-Play it.
    if (plan && plan.hadPlayed && sample?.paused === true && !sample?.ended &&
        plan.previewEchoAt === -Infinity) {
      lastPauseAt = now; plan = null; pendingPause = null; outcome = 'source-pause-preserved';
      note('playlist-pause-preserved'); return false;
    }
    if (sample?.paused === true && !sample?.ended && !plan && !inTransition(now)) {
      // A pause made in the source tab itself: deliberate once it persists on this video.
      if (!pendingPause || pendingPause.url !== url) pendingPause = {url, at:now};
      else if (now - pendingPause.at >= SOURCE_PAUSE_MS) { lastPauseAt = pendingPause.at; pendingPause = null; outcome = 'source-pause-preserved'; }
    }
    if (!plan || plan.url !== url) return false;
    if (sample?.ended || now - plan.at > TIMEOUT_MS) {
      outcome = 'resume-expired'; note('playlist-resume-expired',{attempts:plan.attempts}); plan = null;
      return false;
    }
    if (!eligible || !connected || sample?.buffering || pending || !send ||
        now - plan.at < GRACE_MS || now - plan.lastAttemptAt < RETRY_MS) return false;
    if (plan.attempts >= MAX_ATTEMPTS) {
      outcome = 'resume-blocked'; note('playlist-resume-blocked',{attempts:plan.attempts});plan = null;
      return false;
    }
    plan.attempts++; totalAttempts++; plan.lastAttemptAt = now;
    outcome = 'resume-attempt'; note('playlist-resume-attempt',{attempts:plan.attempts});
    try { return send() === true; } catch { return false; }
  }
  function guardPreviewEvent(playerState, metadata, playerId, sourceId, now = clock()) {
    if (playerId && playerId !== previewId) { previewId = String(playerId); previewLoadedAt = now; previewPauseGuarded = false; }
    // A preview re-cue/prime/load is not a deliberate click on the linked source.
    const guarded = !previewPauseGuarded && playerState === 2 && !!sourceId &&
      now - previewLoadedAt < PREVIEW_MS && (plan !== null || metadata?.paused === false);
    if (guarded) { previewPauseGuarded = true; note('playlist-preview-guarded'); }
    return guarded;
  }
  function reset() {
    lastUrl = ''; lastPlayingAt = lastPauseAt = lastTransitionAt = previewLoadedAt = -Infinity;
    plan = null; pendingPause = null; previewId = ''; previewPauseGuarded = false; outcome = 'idle';
  }
  const diagnostics = () => ({outcome, attempts:plan?.attempts ?? 0, totalAttempts, active:!!plan});
  globalThis.WatchFusionPlaylistContinuity = {onTransition,observe,manualPause,guardPreviewEvent,reset,diagnostics,version:'v13.10.6'};
})();

/* Explicit linked playlist command lifecycle. Source execution and coherent
 * media transition are distinct evidence; no automatic replay on ambiguity. */
(() => {
  'use strict';
  function changed(from,to,videoId) {
    if(!from||!to)return false;
    try {
      const a=new URL(from), b=new URL(to), av=videoId(from), bv=videoId(to);
      if(av&&bv)return av!==bv||!!(a.searchParams.get('list')&&a.searchParams.get('list')===b.searchParams.get('list')&&a.searchParams.get('index')&&b.searchParams.get('index')&&a.searchParams.get('index')!==b.searchParams.get('index'));
      return a.origin+a.pathname!==b.origin+b.pathname;
    }catch{return false;}
  }
  function create(options) {
    const {getNotice,setNotice,owner,page,deliver,log,status,ready,videoId}=options;
    const now=()=>performance.now(), wall=()=>Date.now();
    let lastId=0;
    function note(reason,n,reference,action=n.action){log(reason,{action,reference,ackLatencyMs:Math.round(now()-n.at)});}
    function begin(action) {
      if(!['next','prev'].includes(action)||!owner()||!ready()||!page()){status('Linked source unavailable for navigation.');return false;}
      const prior=getNotice();
      if(prior){prior.queued=action;note('navigation-queued',prior,undefined,action);return true;}
      const at=now();lastId=Math.max(lastId+1,wall()*1024+Math.floor(Math.random()*1024));
      const n={id:lastId,action,at,deadline:at+5000,page:page(),owner:owner(),queued:null};
      setNotice(n);
      if(!deliver(action,n.id)){setNotice(null);note('navigation-not-delivered',n);status('Linked navigation not delivered · try again.');return false;}
      note('navigation-requested',n);status('Waiting for linked playlist navigation confirmation…');return true;
    }
    function finish(n,reason,reference,allowQueued=false) {
      if(getNotice()!==n)return;
      setNotice(null);note(reason,n,reference);
      status(reason==='navigation-confirmed'?'Linked playlist navigation confirmed.':reason==='navigation-rejected'?'Linked navigation rejected · '+reference:'Linked navigation not verified · check the source.');
      if(allowQueued&&n.queued){const action=n.queued,scope=n.owner;
        setTimeout(()=>{if(owner()===scope&&!getNotice()&&ready())begin(action);},0);}
      else if(n.queued)note('navigation-queue-cancelled',n,undefined,n.queued);
    }
    function verify(n) {
      if(!n.accepted||!n.observed)return;
      let matches=!n.target||videoId(n.observed)===n.target;
      try {
        const a=new URL(n.page),b=new URL(n.observed),list=a.searchParams.get('list');
        if(n.playlist&&list&&b.searchParams.get('list')!==list)matches=false;
        if(n.index&&Number(b.searchParams.get('index'))!==n.index)matches=false;
      }catch{matches=false;}
      finish(n,matches?'navigation-confirmed':'navigation-target-mismatch',undefined,matches);
    }
    function observe(sample,coherent) {
      const n=getNotice(),age=wall()-Number(sample.sampledAt);
      if(!n||n.owner!==owner()||now()>n.deadline||!changed(n.page,sample.pageUrl,videoId)||sample.ended||!Number.isFinite(age)||age<0||age>900)return;
      if(!n.progress){n.progress=true;n.deadline=Math.min(n.at+9000,Math.max(n.deadline,now()+3000));note('navigation-transition-started',n);}
      if(!coherent)return;
      n.observed=sample.pageUrl;verify(n);
    }
    function receive(message) {
      const parts=/^wf-navigation-result\|(\d+)\|(next|prev)\|(accepted|rejected|unknown)\|([a-z-]{1,35})\|([A-Za-z0-9_-]{11})?\|(\d{1,6})$/.exec(String(message));
      if(!parts)return false;
      const n=getNotice();if(!n||n.owner!==owner()||n.id!==Number(parts[1])||n.action!==parts[2]||now()>n.deadline)return true;
      const [, , ,outcome,reason,target,index]=parts;note('navigation-execution-'+outcome,n,reason);
      if(outcome==='rejected'){finish(n,'navigation-rejected',reason,!!n.queued&&n.queued!==n.action&&!n.progress);return true;}
      if(outcome==='unknown'){n.uncertain=true;return true;}
      n.accepted=true;n.target=target||'';n.index=Number(index)||0;n.playlist=['playlist-row','native-index','verified-playlist-link','verified-indexed-link'].includes(reason);verify(n);return true;
    }
    function cancel(reason='navigation-cancelled'){const n=getNotice();if(n){setNotice(null);note(reason,n);if(n.queued)note('navigation-queue-cancelled',n,undefined,n.queued);}}
    return {begin,observe,receive,cancel};
  }
  globalThis.WatchFusionLinkedNavigation={create};
})();

/* Source delivery attribution: intervals compare timestamps from the same clock only. */
(() => {
  let previous=null,admitted=null,hold=null;
  function admit(raw,now,scope,normalized){
    if(!Number.isSafeInteger(raw?.deliverySeq)||raw.deliverySeq<=0)return true;
    const relay=stamp(raw.relayReceivedAt),sample=stamp(raw.sampledAt),sent=stamp(raw.publisherSentAt);
    const lag=raw.relayLagMs;
    if(!Number.isFinite(now)||!relay||!sample||!sent||sent<sample||sent-sample>900||!Number.isFinite(lag)||lag<0||lag+sent-sample>900)return false;
    const prior=admitted?.scope===scope?admitted:null;
    if(prior&&sample<=prior.sample)return false;
    // Rejected or future evidence must never poison the accepted clock floor.
    const transit=now-relay,floor=Math.min(prior?.floor??transit,transit),excess=Math.max(0,transit-floor);
    if(lag+excess+sent-sample>900)return false;
    const normalizedAt=normalized?.sampleClock!=='server-qualified'&&Number.isFinite(normalized?.sampledAt)?Math.min(normalized.sampledAt,now-(sent-sample+lag+excess)):normalized?.sampledAt;
    if(normalized&&(!Number.isFinite(normalizedAt)||now-normalizedAt>900||now-normalizedAt<0))return false;
    if(normalized)normalized.sampledAt=normalizedAt;
    admitted={scope,floor,sample,seq:raw.deliverySeq};return true;
  }
  function holdSteady(previous,next,now,gap,pending){
    const steady=previous?.pageUrl&&previous.pageUrl===next.pageUrl&&previous.paused===false&&next.paused===false&&!previous.ended&&!next.ended&&!next.buffering&&Math.abs((Number(previous.rate)||1)-(Number(next.rate)||1))<.01&&(!Number.isFinite(next.volume)||Number.isFinite(previous.volume)&&Math.abs(next.volume-previous.volume)<=.02)&&!pending;
    if(!steady){hold=null;return false;}
    if(gap>900){hold={page:next.pageUrl,stamp:Number(next.sampledAt),at:now};return true;}
    if(!hold||hold.page!==next.pageUrl)return false;
    if(Number(next.sampledAt)>hold.stamp&&now-hold.at>=150){hold=null;return false;}
    return true;
  }
  const stamp=(v)=>Number.isFinite(v)&&v>0?v:null;
  const count=(v)=>Number.isSafeInteger(v)&&v>=0&&v<=1000000?v:null;
  function observe(raw,now,scope,log){
    if(!raw||!scope||!Number.isFinite(now))return;
    const next={scope,now,sample:stamp(raw.sampledAt),received:stamp(raw.publisherReceivedAt),sent:stamp(raw.publisherSentAt),relay:stamp(raw.relayReceivedAt),refresh:count(raw.probeRefreshes),skipped:count(raw.probeRefreshSkipped),mute:count(raw.muteAudits),skippedSend:count(raw.publisherSkipped),rejected:count(raw.publisherRejected),ack:count(raw.publisherAckRttMs),buffer:count(raw.publisherBufferBytes),lag:count(raw.relayLagMs),loop:count(raw.relayLoopDelayMs),networkSeq:count(raw.relayNetworkProbeSequence),networkMs:count(raw.relayNetworkProbeMs),networkAge:count(raw.relayNetworkProbeAgeMs),syncNetworkSeq:count(raw.relaySyncNetworkProbeSequence),syncNetworkMs:count(raw.relaySyncNetworkProbeMs),syncNetworkAge:count(raw.relaySyncNetworkProbeAgeMs),loopSeq:count(raw.relayLoopSequence),loopKind:['timer','immediate','promise','next-tick','http','socket','socket-write','filesystem','worker-message','dns','other','unattributed'].includes(raw.relayLoopKind)?raw.relayLoopKind:null,loopCallback:count(raw.relayLoopCallbackMs),loopCpu:count(raw.relayLoopProcessCpuMs)};
    const p=previous; if(!next.sample||p?.scope===scope&&next.sample<=p.sample)return;
    previous=next;if(!p||p.scope!==scope||now<p.now)return;
    const delta=k=>p[k]!==null&&next[k]!==null&&next[k]>=p[k]?Math.round(next[k]-p[k]):null;
    for(const [k,reason] of [['refresh','source-probe-refresh'],['skipped','source-probe-refresh-skipped'],['mute','source-mute-audit'],['skippedSend','source-send-skipped'],['rejected','source-relay-rejected']]){const d=delta(k);if(d>0)log(reason,{sequence:d});}
    for(const [k,reason,limit] of [['ack','source-receipt-rtt',900],['buffer','source-socket-buffer',4096],['lag','source-relay-lag',350],['loop','source-server-loop-delay',100]])if(next[k]!==null&&next[k]>=limit&&next[k]!==p[k])log(reason,{sampleAgeMs:next[k]});
    if(next.loopSeq!==null&&next.loopSeq!==p.loopSeq&&next.loopKind&&next.loopCallback!==null&&next.loopCpu!==null)log('source-loop-callback-witness',{action:next.loopKind,sequence:next.loopSeq,durationMs:next.loopCallback,extraMs:next.loopCpu,sampleAgeMs:next.loop});
    if(next.networkSeq!==null&&next.networkSeq!==p.networkSeq&&next.networkMs!==null&&next.networkMs>=100)log('source-server-network-probe',{sampleAgeMs:next.networkMs,extraMs:next.networkAge});
    if(next.syncNetworkSeq!==null&&next.syncNetworkSeq!==p.syncNetworkSeq&&next.syncNetworkMs!==null&&next.syncNetworkMs>=100)log('source-server-sync-network-probe',{sampleAgeMs:next.syncNetworkMs,extraMs:next.syncNetworkAge});
    if(now-p.now<=1800)return;
    // Differences reveal where the gap appeared, without subtracting clocks across devices.
    for(const [k,reason] of [['sample','source-gap-probe'],['received','source-gap-worker'],['sent','source-gap-publisher'],['relay','source-gap-relay']]){const d=delta(k);if(d!==null)log(reason,{sampleAgeMs:d});}
    if(next.received!==null&&next.sent!==null&&next.sent>=next.received)log('source-gap-worker-hold',{sampleAgeMs:Math.round(next.sent-next.received)});
  }
  globalThis.WatchFusionSourceDelivery={observe,admit,holdSteady,reset:()=>{previous=admitted=hold=null;}};
})();
