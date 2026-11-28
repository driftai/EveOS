/* v13.10.7 (+v13.10.8 segment-stable dwell): Terminal recovery for a wedged TV decoder (replaces the v13.10 one-shot rescue).
 * Drift's trace: the TV exhausted its 3-step stall ladder, then sat in BUFFERING for ~60 s and fell
 * 86 s behind while laptop and phone stayed Locked. Only a manual page reload fixed it. The old rescue
 * never fired: it required PLAYING (not BUFFERING) and its dwell restarted every time the linked source
 * status blinked to "frozen" for one report.
 * Ladder, per video segment, only on this device, never moving the room or the other members:
 *   1. one decoder reload at the live room position (loadVideoById)
 *   2. if still wedged, one rebuild of the YouTube player (what the manual reload did)
 * Then it stops and says so. Never runs while the room reference itself is frozen or buffering.
 */
(() => {
  'use strict';
  if (typeof window === 'undefined') return;
  const STALL_DWELL_MS = 6000, BUFFER_DWELL_MS = 9000, MIN_DRIFT_SEC = 2.5, RETRY_AFTER_MS = 15000;
  const TRUST_GRACE_MS = 6000, MAX_REBUILDS_PER_10_MIN = 2, FAILED_RELOAD_MS = 8000;
  const CHECKPOINT_KEY = "wf.decoder-recovery.v1", CHECKPOINT_MS = 600000;
  // R14v: decoder health is not proof of 0 ms room/speaker phase.  The TV in
  // the November 21 physical run advanced for >3 minutes with a stable ~170 ms
  // player-timeline offset. Give ONE additional decoder budget after a full
  // minute of actual, steady progress; never interpret this as audible lock.
  const HEALED_MS = 60000, HEALTH_PHASE_SEC = .25, HEALTH_PROGRESS_MS = 45000, HEALTH_GAP_MS = 4000;
  const HEALTH_JITTER_SEC = .04, HEAL_REARM_WINDOW_MS = 600000;
  // R14s: a genuinely long room pause may grant ONE new bounded terminal attempt
  // in 10 minutes. Segment churn and brief pause/play cycles never refill this budget.
  const PAUSE_REARM_MS = 20000, REARM_QUIET_MS = 60000, REARM_WINDOW_MS = 600000;
  let scope = '', since = 0, steps = 0, lastStepAt = -Infinity, outcome = 'idle', liveSeenAt = -Infinity, healthySince = 0;
  let healthyAt = -1, healthyPosition = null, healthyProgressMs = 0;
  let pausedAt = -1, wasRoomPaused = false, resumeRearms = [], rearmCount = 0, lastRearmDwellMs = null;
  let healthOffsets = [], healRearms = [], healCount = 0;
  let manualRestartAt = -Infinity;
  const rebuilds = [];
  // Recovery owns a short, local decoder warmup; never refill action budgets here.
  let warm = null, rejoinCandidate = null, rejoinSpent = false, recovered = null, transportScope = '', protectedStep = 0;
  // 06jidk: raw decoder motion and room alignment are independent. A spent
  // ladder is not evidence of a frozen decoder. No command is issued here.
  let motion=null, provenStep=-Infinity, retryAt=-Infinity, retrySince=null, handoff=null, handoffProof=null;
  const JOURNAL_KEY='wf.decoder-journal.v1', JOURNAL_AGE=1800000, JOURNAL_MAX=32;
  let journalRoom='', journal=[], journalLoaded=false;
  const eventKinds=new Set(['reload-requested','reload-issued','reload-failed','rebuild-requested','rebuild-issued','rebuild-failed','motion-restored','handoff-issued','handoff-verified','handoff-unverified','retry-reload-requested','retry-reload-issued','retry-reload-failed','budget-spent','manual-rebuild-requested','manual-rebuild-issued','manual-rebuild-failed']);
  function journalScope(key) {
    if(journalLoaded&&key===journalRoom)return;
    journalLoaded=true;journalRoom=key;journal=[];
    try {const saved=JSON.parse(sessionStorage.getItem(JOURNAL_KEY));if(saved?.room===key&&Array.isArray(saved.events))journal=saved.events.filter(e=>eventKinds.has(e?.kind)&&typeof e.id==='string'&&Number.isFinite(e.at)&&Date.now()-e.at>=0&&Date.now()-e.at<JOURNAL_AGE).slice(-JOURNAL_MAX);}catch{}
  }
  function saveJournal(){try{sessionStorage.setItem(JOURNAL_KEY,JSON.stringify({room:journalRoom,events:journal}));}catch{}}
  function recordRecovery(kind,input={}) {
    if(!eventKinds.has(kind)||!scope)return;
    journalScope(scope.split(':')[0]);const at=Date.now(),error=Number(input.drift),raw=String(input.scope||transportScope||'').split(':').at(-1);
    const id=globalThis.crypto?.randomUUID?.()||`${at.toString(16)}-${Math.random().toString(16).slice(2)}`;
    journal=journal.filter(e=>at-e.at>=0&&at-e.at<JOURNAL_AGE);journal.push({id,kind,at,segment:/^\d+$/.test(raw)?Number(raw):null,step:steps,errorMs:Number.isFinite(error)?Math.round(error*1000):null});journal=journal.slice(-JOURNAL_MAX);saveJournal();
  }
  function recoveryEvents(key){journalScope(String(key||''));const at=Date.now();return journal.filter(e=>at-e.at>=0&&at-e.at<JOURNAL_AGE).slice(0,8).map(({at:when,...e})=>({...e,ageMs:Math.round(at-when)}));}
  function acknowledgeRecovery(key,ids){if(!Array.isArray(ids))return;journalScope(String(key||''));const ack=new Set(ids.slice(0,8));journal=journal.filter(e=>!ack.has(e.id));saveJournal();}
  function motionVerified(raw,at){return !!(motion&&motion.scope===raw&&motion.proven&&Number.isFinite(at)&&at>=motion.at&&at-motion.at<=1000);}
  function observeContinuity({scope:raw,nowMs:at,io,position,rate,playing,buffering,owned,sameVideo}={}) {
    const precision=io?.referenceUncertaintyMs?.(), eligible=io?.follower===true&&!io.hostLinked&&io.linkedSourceActive?.()===true&&io.valid?.()===true&&sameVideo===true&&!document.hidden&&playing===true&&!buffering&&!owned&&io.referenceTrusted?.()===true&&io.sourceReferenceQualified?.(100)===true&&!io.sourceBuffering?.()&&!io.mirrorContradicted?.()&&Number.isFinite(precision)&&precision>=0&&precision<=70&&[at,position,rate].every(Number.isFinite)&&rate>0;
    if(handoff&&(raw!==handoff.scope||at-handoff.at>30000)){recordRecovery('handoff-unverified',{scope:handoff.scope,drift:handoff.error});handoff=null;}
    if(!eligible||!steps||lastStepAt===manualRestartAt){motion=null;return false;}
    const target=io.target?.(at);if(!Number.isFinite(target)){motion=null;return false;}
    const prev=motion,dt=prev?at-prev.at:0,dp=prev?position-prev.pos:0;
    if(prev&&prev.scope===raw&&dt===0)return motionVerified(raw,at);
    if(!prev||prev.scope!==raw||dt<=0||dt>1000||dp<dt/1000*rate*.65||dp>dt/1000*rate*1.35+.025||Math.abs(target-prev.target-dt/1000*rate)>.10){motion={scope:raw,at,pos:position,target,since:at,proven:false};return false;}
    motion={...prev,at,pos:position,target,proven:at-prev.since>=3000};
    if(!motion.proven)return false;
    if(steps>0&&!warm&&provenStep!==lastStepAt){provenStep=lastStepAt;protectedStep=steps;recovered={scope:raw,at,step:steps};outcome='decoder-motion-restored';recordRecovery('motion-restored',{scope:raw,drift:target-position});}
    if(steps>0&&!warm&&['terminal-recovery-spent','freeze-unverified','rebuild-budget-spent'].includes(outcome))outcome='decoder-motion-restored';
    if(handoff&&at-handoff.at>=3000){const verified=Math.abs(target-position)<=.1||Math.abs(target-position)<Math.abs(handoff.error)*.7;if(verified)handoffProof={scope:raw,at,step:lastStepAt,valid:io.valid};recordRecovery(verified?'handoff-verified':'handoff-unverified',{scope:raw,drift:target-position});handoff=null;}
    return true;
  }
  function postRecoveryRateReady(io,at,raw){return !!(handoffProof&&handoffProof.scope===raw&&handoffProof.step===lastStepAt&&handoffProof.valid?.()===true&&at>=handoffProof.at&&at-handoffProof.at<=60000&&steps>0&&!warm&&rejoinSpent&&motionVerified(raw,at)&&io?.tvIdentity===scope&&io.valid?.()===true&&!document.hidden);}
  function handoffReady(io,at,error){return steps>0&&!warm&&!rejoinSpent&&provenStep===lastStepAt&&error>=.45&&error<=8&&motionVerified(transportScope,at)&&io?.follower===true&&!io.hostLinked&&io.tvIdentity===scope&&io.valid?.()===true;}
  // Only a decoder that really recovered and subsequently stalled gets one
  // further reload, after a fresh reference dwell. Persistent failure stops.
  function retryTerminal(input,at,wedged){
    const confirmed=input.buffering&&Math.abs(input.drift)>=MIN_DRIFT_SEC||input.qualifiedStall===true&&input.stalledMs>=STALL_DWELL_MS;
    if(!wedged||!confirmed||input.follower!==true||!input.trusted||input.sourceQualified!==true||input.sourceBuffering||input.mirrorContradicted||document.hidden||steps!==2||warm||provenStep!==lastStepAt||at-lastStepAt<(handoff&&handoff.scope===input.scope&&rejoinSpent?15000:45000)||at-retryAt<CHECKPOINT_MS||typeof input.reload!=='function'){retrySince=null;return false;}
    if(!retrySince||retrySince.scope!==input.scope||at-retrySince.last>1000||at<retrySince.last){retrySince={scope:input.scope,at,last:at};return false;}
    retrySince.last=at;if(at-retrySince.at<5000)return false;
    retrySince=null;retryAt=lastStepAt=at;provenStep=-Infinity;motion=null;recovered=null;rejoinCandidate=null;rejoinSpent=false;since=0;warm={scope:input.scope,at,sample:null,progress:0};checkpoint(at);
    recordRecovery('retry-reload-requested',input);try{input.reload();outcome='terminal-retry-reload';recordRecovery('retry-reload-issued',input);return true;}catch{warm=null;outcome='recovery-failed';recordRecovery('retry-reload-failed',input);return false;}
  }
  function isSettling(raw, at) { return !!warm && raw === warm.scope && !document.hidden && Number.isFinite(at) && at >= warm.at && at-warm.at < 12000; }
  function settling({scope: raw, nowMs: at, ready, playing, buffering, position, rate = 1} = {}) {
    if (!warm) return false;
    if (raw !== warm.scope || document.hidden || !Number.isFinite(at) || at < warm.at || at-warm.at >= 12000) { warm = null; return false; }
    if (!ready || !playing || buffering || !Number.isFinite(position) || !Number.isFinite(rate) || rate <= 0) { warm.sample = null; warm.progress = 0; return true; }
    const prev = warm.sample; warm.sample = {at,position};
    if (prev) {
      const dt = at-prev.at, dp = position-prev.position;
      if (dt > 0 && dt <= 1000 && dp >= dt/1000*rate*.65 && dp <= dt/1000*rate*1.35+.025) warm.progress += dt;
      else if (dt !== 0) warm.progress = 0;
    }
    if (warm.progress >= 3000 && at-warm.at >= 4000) { recovered = {scope:raw,at,step:steps}; protectedStep=steps; warm = null; return false; }
    return true;
  }
  // v13.10.8: the caller's scope is room:video:epoch:playoutSegment. The playout segment bumps on every
  // room transport rewrite (a frozen linked source re-mirrored once a second in Drift's trace), so it must
  // not restart the dwell or refill the budget. Dwell and budget belong to room:video:epoch; the budget
  // refills only after the player has been healthy for 30 s.
  const dwellScope = raw => String(raw ?? '').split(':').slice(0, 3).join(':');
  // Persist consumed local recovery budgets, not timing samples, jobs or audio permission.
  // Same-tab reloads may continue a failed ladder only after new playback evidence.
  function checkpoint(nowMs) {
    if (!scope || !Number.isFinite(nowMs)) return;
    try {
      const at=Date.now(), wall=t=>Number.isFinite(t)?at-(nowMs-t):null;
      sessionStorage.setItem(CHECKPOINT_KEY,JSON.stringify({scope,at,steps,last:wall(lastStepAt),manual:wall(manualRestartAt),retry:wall(retryAt),spent:rejoinSpent,
        rebuilds:rebuilds.map(wall).filter(t=>t!==null&&at-t<CHECKPOINT_MS),resume:resumeRearms.map(wall),heal:healRearms.map(wall)}));
    } catch {}
  }
  function restoreCheckpoint(nowMs) {
    try {
      const c=JSON.parse(sessionStorage.getItem(CHECKPOINT_KEY)), at=Date.now();
      if (!c || !Number.isFinite(nowMs) || !Number.isFinite(c.at) || at-c.at<0 || at-c.at>=CHECKPOINT_MS) return;
      const mono=t=>Number.isFinite(t)&&at-t>=0&&at-t<CHECKPOINT_MS?nowMs-(at-t):-Infinity;
      const recent=(xs,n)=>Array.isArray(xs)?xs.map(mono).filter(Number.isFinite).slice(-n):[];
      rebuilds.push(...recent(c.rebuilds,MAX_REBUILDS_PER_10_MIN));resumeRearms=recent(c.resume,1);healRearms=recent(c.heal,1);
      manualRestartAt=mono(c.manual);retryAt=mono(c.retry);
      if(c.scope!==scope || ![1,2].includes(c.steps) || !Number.isFinite(mono(c.last))) return;
      steps=c.steps;lastStepAt=mono(c.last);rejoinSpent=c.spent===true;outcome='recovery-budget-restored';
      window.watchFusionRoomSyncLog?.note?.('tv-decoder-resumed',{step:steps,reason:outcome});
    } catch {}
  }
  function enterScope(next, nowMs) {
    if (next === scope) return;
    const first=!scope;
    warm = null; recovered = null; protectedStep=0; rejoinCandidate = null; rejoinSpent = false; motion=null;provenStep=-Infinity;retrySince=null;handoff=null;handoffProof=null;scope = next; since = 0; steps = 0; lastStepAt = -Infinity; liveSeenAt = -Infinity;
    healthySince = 0; healthyAt = -1; healthyPosition = null; healthyProgressMs = 0;
    healthOffsets = [];
    pausedAt = -1; wasRoomPaused = false; outcome = 'scope-change';
    if(first)restoreCheckpoint(nowMs);
    checkpoint(nowMs);
  }
  // Called for TV followers from playback-sync, even while the room is paused.
  // It does not command the player and cannot rearm during a playing segment.
  function observeTransport({scope: raw, nowMs, paused} = {}) {
    const next = raw ? dwellScope(raw) : '';
    if (!next || !Number.isFinite(nowMs)) return false;
    enterScope(next,nowMs);
    if (raw !== transportScope || paused === true) { transportScope=raw; recovered=null; rejoinCandidate=null; motion=null;retrySince=null;handoffProof=null; }
    if (paused === true) {
      warm = null;
      if (!wasRoomPaused) { pausedAt = nowMs; wasRoomPaused = true; }
      return false;
    }
    if (!wasRoomPaused || paused !== false) return false;
    const dwell = nowMs - pausedAt;
    wasRoomPaused = false; pausedAt = -1;
    resumeRearms = resumeRearms.filter(t => nowMs - t < REARM_WINDOW_MS);
    healRearms = healRearms.filter(t => nowMs - t < HEAL_REARM_WINDOW_MS);
    if (steps !== 2 || dwell < PAUSE_REARM_MS || nowMs - lastStepAt < REARM_QUIET_MS ||
        resumeRearms.length >= 1 || healRearms.length >= 1 || document.hidden) return false;
    steps = 0; since = 0; lastStepAt = -Infinity;
    healthySince = 0; healthyAt = -1; healthyPosition = null; healthyProgressMs = 0;
    healthOffsets = [];
    resumeRearms.push(nowMs); rearmCount++; lastRearmDwellMs = Math.round(dwell);
    outcome = 'long-pause-resume-budget-rearmed'; checkpoint(nowMs);
    window.watchFusionRoomSyncLog?.note?.('tv-resume-rearmed', {pauseMs: Math.round(dwell), count: rearmCount});
    return true;
  }
  // Never replenish decoder-reload budgets just because YT reports PLAYING.
  // Qualify healing from actual progress and near-room phase across 30 seconds.
  function observeHealth(input, nowMs, wedged) {
    const position = Number(input.position), drift = Number(input.drift);
    const healthy = !wedged && input.playing && !input.buffering && !input.exhausted
      && input.trusted && !input.sourceBuffering && Number.isFinite(nowMs)
      && Number.isFinite(position) && Number.isFinite(drift) && Math.abs(drift) <= HEALTH_PHASE_SEC;
    if (!healthy || document.hidden) { healthySince = 0; healthyAt = -1; healthyPosition = null;
      healthyProgressMs = 0; healthOffsets = []; return; }
    if (healthyAt < 0) healthySince = nowMs;
    else {
      const elapsed = nowMs - healthyAt, advanced = position - healthyPosition;
      if (elapsed <= 0 || elapsed > HEALTH_GAP_MS || advanced < -.08 || advanced > elapsed / 1000 * 1.8 + .3) {
        healthySince = nowMs; healthyProgressMs = 0; healthOffsets = [];
      } else if (advanced > .05) healthyProgressMs += Math.min(elapsed, advanced * 1000);
    }
    healthyAt = nowMs; healthyPosition = position;
    healthOffsets.push({at:nowMs, drift});
    healthOffsets = healthOffsets.filter(sample => nowMs - sample.at <= HEALED_MS);
    healRearms = healRearms.filter(t => nowMs - t < HEAL_REARM_WINDOW_MS);
    const spread = healthOffsets.length ? Math.max(...healthOffsets.map(x=>x.drift)) -
      Math.min(...healthOffsets.map(x=>x.drift)) : Infinity;
    // Separate decoder continuity from room-clock and speaker alignment.
    // Recovery budget refill is rate-limited even when the player keeps healing.
    resumeRearms = resumeRearms.filter(t => nowMs - t < REARM_WINDOW_MS);
    if (steps && healRearms.length === 0 && resumeRearms.length === 0 &&
        nowMs - healthySince >= HEALED_MS &&
        healthyProgressMs >= HEALTH_PROGRESS_MS && spread <= HEALTH_JITTER_SEC &&
        nowMs - lastStepAt >= HEALED_MS) {
      steps = 0; lastStepAt = -Infinity; outcome = 'healed-advancing-stable-offset';
      healRearms.push(nowMs); healCount++; checkpoint(nowMs);
      window.watchFusionRoomSyncLog?.note?.('tv-decoder-recovered',
        {progressMs: Math.round(healthyProgressMs), offsetMs: Math.round(drift*1000)});
    }
  }
  function restartAfterSync(input, nowMs, wedged) {
    if (!scope || steps < 2 || !wedged || document.hidden || !Number.isFinite(nowMs) ||
        input.trusted !== true || input.sourceBuffering || typeof input.rebuild !== 'function' ||
        (input.buffering && !(Math.abs(input.drift) >= MIN_DRIFT_SEC))) return false;
    if (nowMs - manualRestartAt < RETRY_AFTER_MS) return true;
    manualRestartAt = lastStepAt = nowMs; motion=null;provenStep=-Infinity;retrySince=null;handoff=null; checkpoint(nowMs);
    since = 0;
    recordRecovery('manual-rebuild-requested',input);
    try {
      input.rebuild();
      outcome = 'manual-player-rebuilt';recordRecovery('manual-rebuild-issued',input);
      window.watchFusionRoomSyncLog?.note?.('tv-decoder-manual-restart', {reason:outcome});
    } catch { outcome = 'manual-restart-failed';recordRecovery('manual-rebuild-failed',input); }
    return true;
  }
  function qualifiesStall({io, media, videoId, nowMs, stalledMs, exhausted, buffering} = {}) {
    if (buffering || !exhausted || !(stalledMs >= STALL_DWELL_MS) || document.hidden ||
        !io?.follower || !io.linkedSourceActive?.() || !io.sourceReferenceQualified?.(100) ||
        io.mirrorContradicted?.() || media?.getVideoData?.()?.video_id !== videoId) return false;
    const precision=io.referenceUncertaintyMs?.();
    return Number.isFinite(precision) && precision >= 0 && precision <= 70 &&
      window.WatchFusionSensorProvenance?.describe?.({media,now:nowMs})?.timelineState === 'held';
  }
  function consider(input = {}) {
    const nextScope = input.scope ? dwellScope(input.scope) : '';
    const nowMs = Number(input.nowMs);
    enterScope(nextScope,nowMs);
    if (input.trusted) liveSeenAt = nowMs;
    const wedged = input.buffering ? true : !!(input.exhausted && input.playing && (input.manual || !motionVerified(input.scope,nowMs)));
    if(wedged || document.hidden || !input.playing) recovered=null;
    if(wedged || document.hidden || !input.playing || !input.trusted || input.sourceBuffering || input.sourceQualified===false || input.mirrorContradicted===true) rejoinCandidate=null;
    if (input.manual) return restartAfterSync(input, nowMs, wedged);
    const provenStall = input.qualifiedStall === true && input.trusted === true && !input.sourceBuffering &&
      !document.hidden && !input.buffering && input.exhausted === true && input.playing === true &&
      Number.isFinite(input.stalledMs) && input.stalledMs >= STALL_DWELL_MS && Number.isFinite(input.position) && Number.isFinite(input.drift);
    const failedReload = provenStall && steps === 1 && nowMs-lastStepAt >= FAILED_RELOAD_MS;
    const prequalified = provenStall && steps === 0;
    if (input.fastOnly && !failedReload) return false;
    observeHealth(input, nowMs, wedged);
    if (!scope || !wedged || document.hidden || !Number.isFinite(nowMs)) { since = 0; return false; }
    // A one-report "frozen" blink of the linked source is not a frozen room.
    if (input.sourceBuffering || nowMs - liveSeenAt > TRUST_GRACE_MS) { since = 0; outcome = 'room-reference-not-live'; return false; }
    if (!(input.exhausted && input.playing && !input.buffering) && !(Math.abs(Number(input.drift)) >= MIN_DRIFT_SEC)) { since = 0; outcome = 'within-buffer-guard'; return false; }
    // A stale exhausted label alone is not a new freeze; the startup sensor
    // must still confirm a prolonged lack of playback progress.
    if (input.exhausted && input.playing && !input.buffering &&
        Number.isFinite(input.stalledMs) && input.stalledMs < STALL_DWELL_MS) {
      since = 0; outcome = 'freeze-unverified'; return false;
    }
    // After the protected warmup, a still-wedged decoder with no budget
    // needs no further action dwell: publish the spent status, not another command.
    if (steps >= 2) {
      if (isSettling(input.scope, nowMs)) return false;
      if (retryTerminal(input,nowMs,wedged))return true;
      if (outcome !== 'terminal-recovery-spent') {input.onSpent?.();recordRecovery('budget-spent',input);}
      outcome = 'terminal-recovery-spent'; return false;
    }
    if (!failedReload && !prequalified) {
      if (!since) { since = nowMs; outcome = 'confirming-wedged-decoder'; return false; }
      if (nowMs - since < (input.buffering ? BUFFER_DWELL_MS : STALL_DWELL_MS)) return false;
      if (steps === 1 && nowMs - lastStepAt < RETRY_AFTER_MS) { outcome = 'verifying-decoder-reload'; return false; }
    }
    // A brief trust blink may preserve dwell, but cannot authorize a transport action.
    if(input.trusted!==true || input.mirrorContradicted===true){outcome='awaiting-fresh-recovery-reference';return false;}
    const recent = rebuilds.filter(t => nowMs - t < 600000);
    const rebuild = steps === 1 && recent.length < MAX_REBUILDS_PER_10_MIN && typeof input.rebuild === 'function';
    if (steps === 1 && !rebuild) { steps = 2; outcome = 'rebuild-budget-spent'; checkpoint(nowMs); return false; }
    steps++; lastStepAt = nowMs; since = 0; motion=null;provenStep=-Infinity;retrySince=null;recovered = null; protectedStep=0; rejoinCandidate = null; rejoinSpent = false;
    warm = {scope:input.scope,at:nowMs,sample:null,progress:0};
    const action=rebuild?'rebuild':'reload';recordRecovery(action+'-requested',input);
    try {
      if (rebuild) { rebuilds.push(nowMs); checkpoint(nowMs); input.rebuild(); outcome = 'player-rebuilt-once'; }
      else { checkpoint(nowMs); input.reload(); outcome = 'one-decoder-reload'; }
      recordRecovery(action+'-issued',input);
      window.watchFusionRoomSyncLog?.note?.('tv-decoder-' + (rebuild ? 'rebuild' : 'reload'), {positionMs: Math.round(Number(input.drift) * 1000),step:steps,
        reason:failedReload?'verified-reload-failure':prequalified?'verified-stall-exhausted':'ordinary-dwell'});
      return true;
    } catch { warm = null; outcome = 'recovery-failed';recordRecovery(action+'-failed',input); return false; }
  }
  // A decoder reload/rebuild is not permission to immediately seek the newly
  // advancing player again. For offsets <=5 s, require a quiet, qualified window; permit at
  // most one ordinary rejoin per decoder recovery step, never a fresh ladder.
  // The release owner may defer to this guard only after measured decoder warmup.
  // This grants no command: the existing buffered rejoin guard still must qualify.
  function canOwnPostRelease(io,at,error) {
    if(handoffReady(io,at,error))return true;
    return !!(recovered && recovered.scope===transportScope && recovered.step===steps && steps>0 && !rejoinSpent && !warm &&
      Number.isFinite(at) && at>=recovered.at && at-recovered.at<=30000 && error>=.45 && error<=4 &&
      io?.follower===true && !io.hostLinked && io.tvIdentity===scope && io.valid?.()!==false && !document.hidden &&
      io.linkedSourceActive?.()===true && io.state?.()===1 && io.referenceTrusted?.()===true &&
      io.sourceReferenceQualified?.(100)===true && !io.sourceBuffering?.() && !io.mirrorContradicted?.());
  }
  function allowAutomaticRejoin({nowMs, error, io, lead} = {}) {
    const qualifiedHandoff=handoffReady(io,nowMs,error);
    if (!steps || (!qualifiedHandoff && Math.abs(error) > 5 && !(protectedStep===steps && io?.follower===true && !io.hostLinked)) || (io?.follower !== true && !io?.hostLinked) || io.linkedSourceActive?.() !== true) return true;
    const precision = io.referenceUncertaintyMs?.(), pos = io.current?.(), target = io.target?.(nowMs);
    if (rejoinSpent || document.hidden || io.valid?.()===false || (io.tvIdentity && io.tvIdentity!==scope) || io.state?.() !== 1 || io.referenceTrusted?.() !== true ||
        io.sourceReferenceQualified?.(100) !== true || io.mirrorContradicted?.() || io.sourceBuffering?.() ||
        ![nowMs,error,pos,target,precision,lead,io.baseRate].every(Number.isFinite) || io.baseRate <= 0 || precision < 0 || precision > 70 ||
        Math.abs(target-pos-error)>.14 || (io.buffered?.(target+lead) !== true && !(qualifiedHandoff&&error>=2.5))) { rejoinCandidate = null; return false; }
    const c = rejoinCandidate, dt = c ? nowMs-c.at : 0;
    if (c && dt === 0) return false;
    if (!c || dt < 0 || dt > 1000 || Math.abs(c.initialError-error) > .14 ||
        Math.abs(target-c.target-dt/1000*io.baseRate)>.08 ||
        pos-c.pos < dt/1000*io.baseRate*.5 || pos-c.pos > dt/1000*io.baseRate*1.5+.025) {
      rejoinCandidate = {at:nowMs,since:nowMs,pos,target,initialError:error}; return false;
    }
    c.at=nowMs; c.pos=pos;c.target=target;
    const buffered=io.buffered?.(target+lead)===true;
    if (nowMs-c.since < (qualifiedHandoff&&buffered?2500:8000) || nowMs-lastStepAt < (qualifiedHandoff&&buffered?6500:12000)) return false;
    rejoinSpent=true; rejoinCandidate=null; checkpoint(nowMs);if(qualifiedHandoff){handoff={scope:transportScope,at:nowMs,error};recordRecovery('handoff-issued',{scope:transportScope,drift:error});}return true;
  }
  // The same thing a manual URL reload does for the player, without leaving the room.
  function rebuildPlayer(videoId, startSeconds) {
    if (!videoId || typeof ensurePlayer !== 'function') throw Error('rebuild unavailable');
    // Nova R14r, selectively retained: retire ownership of the OLD iframe
    // before destroying it. A stale lease must not block the new player.
    try { window.WatchFusionLinkedTrackOwnership?.invalidate?.(ytPlayer); } catch {}
    try { ytPlayer?.destroy?.(); } catch {}
    ytPlayer = null; ytPlayerReady = false; playerPrimed = false; playerInitializing = false;
    ensurePlayer(videoId, startSeconds);
  }
  window.WatchFusionDecoderRescue = {version: 'adaptive-room-06jidk', observeContinuity,motionVerified,handoffReady,postRecoveryRateReady,recoveryEvents,acknowledgeRecovery,consider, qualifiesStall, observeTransport, rebuildPlayer, settling, isSettling, allowAutomaticRejoin, canOwnPostRelease,
    diagnostics: () => ({scope, attempted: steps > 0, steps, outcome, healthyProgressMs: Math.round(healthyProgressMs),
      rearmCount, healCount, lastRearmDwellMs, pauseObserved: wasRoomPaused})};
})();

/* Shared linked-host acquisition: actual identity + motion, bounded local recovery. */
(() => {
  let job = null, connectionState=null, reportedScope=null, transportCheck=null;
  const note = (reason, detail = {}) => window.watchFusionRoomSyncLog?.note?.('linked-acquisition', {reason,...detail});
  function context(m = window.watchFusionLinkedTab?.metadata?.()) {
    const l = window.watchFusionLinkedTab, e = l?.soloEvidence?.(), id = window.parseYoutubeInput?.(m?.pageUrl || '');
    if (!l?.active?.() || !e?.scope || !/^[A-Za-z0-9_-]{11}$/.test(id || '') || (roomId && (!isHost() || followsRoomPlayback()))) return null;
    if (state?.source?.videoId !== id) return {l,e,m,id,waiting:true};
    return {l,e,m,id,key:JSON.stringify([roomId||'',e.scope,id])};
  }
  function current(c) {return !!c && !c.waiting && job?.key === c.key;}
  function holding() {const c=context();return !!c && (c.waiting || ytPlayer?.getVideoData?.()?.video_id !== c.id || !current(c) || !job.verified);}
  function terminal(reason,event) {const c=context();if(!c || c.waiting || pendingVideoId!==c.id || (event?.target && event.target !== ytPlayer))return; if(!current(c)) job={key:c.key,step:0,verified:false,previous:null,sourceSince:null,lastAction:performance.now()};job.terminal=reason;note(reason);}
  function connection(ready,age,hasSample){
    const next=!ready?'socket-not-ready':!hasSample?'awaiting-source-sample':age>1800?'source-metadata-stale':'source-transport-healthy';
    if(next!==connectionState){connectionState=next;note(next,{sampleAgeMs:Math.max(0,Math.round(age||0))});}
  }
  function cancelTransport(reason){if(transportCheck){note(reason,{action:transportCheck.action});transportCheck=null;}}
  // A source ACK is a new authoritative transport intent, not another automatic retry.
  function confirmedTransport(m,action){
    const c=context(m),age=Date.now()-Number(m?.sampledAt),p=ytPlayer;
    if(!c||c.waiting||!c.e.connected||!c.e.matches||!Number.isFinite(age)||age<0||age>900||!['play','pause','seek'].includes(action))return false;
    const identity=p?.getVideoData?.()?.video_id===c.id,ps=p?.getPlayerState?.(),pos=Number(p?.getCurrentTime?.());
    note('source-transport-confirmed',{action,status:Number.isFinite(ps)?ps:null,positionMs:Number.isFinite(m.currentTime)?Math.round(m.currentTime*1000):null});
    if(!identity||!ytPlayerReady||(action==='play'&&(m.paused!==false||m.ended||m.buffering))||(action==='pause'&&m.paused!==true))return false;
    cancelTransport('local-transport-superseded');const held=!current(c)||!job.verified;
    if(!held&&((action==='play'&&ps===1)||(action==='pause'&&ps===2)||action==='seek')){transportCheck={key:c.key,action,at:performance.now(),pos,stamp:Number(m.sampledAt),first:null};note('local-transport-observing',{action,status:Number.isFinite(ps)?ps:null});return false;}
    if(current(c)&&job.terminal&&action!=='pause')return false;
    if(held&&(action==='play'||action==='seek')) {job={key:c.key,step:0,verified:false,previous:null,sourceSince:null,lastAction:performance.now()};note('transport-rearmed',{action});}
    c.l.suppressPlaybackEcho?.();
    try{
      if(action==='pause')p.pauseVideo?.();
      else if(action==='play')p.playVideo?.();
      else {const target=window.WatchFusionLinkedPlaybackSync?.projectedPosition?.(m,Date.now());if(!Number.isFinite(target))return false;p.seekTo?.(Math.max(0,target),true);job.alignSpent=true;job.alignAt=performance.now();}
      transportCheck={key:c.key,action,at:performance.now(),pos,stamp:Number(m.sampledAt),first:null};note('local-transport-requested',{action,status:Number.isFinite(ps)?ps:null});return true;
    }catch{note('local-transport-failed',{action});return false;}
  }
  function observe(m) {
    const c=context(m);if(!c){cancelTransport('local-transport-cancelled');job=null;return false;} if(c.waiting){cancelTransport('local-transport-track-changed');return true;}
    const at=performance.now(), age=Date.now()-Number(m.sampledAt), p=ytPlayer, identity=p?.getVideoData?.()?.video_id===c.id, playing=p?.getPlayerState?.()===1;
    const pos=Number(p?.getCurrentTime?.()), raw=Number(m.currentTime), stamp=Number(m.sampledAt), rate=Number(m.rate)||1;
    if(reportedScope!==c.e.scope){reportedScope=c.e.scope;const reference=window.parent&&window.parent!==window?'iframe':'standalone';note('solo07-client-running',{reference});note('solo08-client-running',{reference});note('solo09-client-running',{reference});note('solo10-client-running',{reference});note('solo11-client-running',{reference});note('solo12-client-running',{reference});if(window.watchFusionEveBridge?.refreshVerified?.())note('iframe-refresh-executed',{reference});}if(!current(c)){job={key:c.key,step:0,verified:false,previous:null,sourceSince:null,lastAction:at};note('awaiting-motion');}
    if(transportCheck){const q=transportCheck,expectedPause=q.action==='pause',expectedPlay=q.action==='play';
      if(q.key!==c.key||(expectedPause&&m.paused===false)||(expectedPlay&&m.paused===true)){transportCheck=null;note('local-transport-superseded',{action:q.action});}
      else if(at-q.at<=4200&&identity&&ytPlayerReady&&c.e.connected&&c.e.matches&&age>=0&&age<=900&&stamp>q.stamp&&Number.isFinite(pos)){
        if(!q.first||at-q.first.at>1800)q.first={pos,at,stamp};
        const motion=q.first&&stamp>q.first.stamp&&at-q.first.at>=250&&pos-q.first.pos>.08;
        const stopped=q.first&&stamp>q.first.stamp&&at-q.first.at>=250&&Math.abs(pos-q.first.pos)<.08;
        const target=window.WatchFusionLinkedPlaybackSync?.projectedPosition?.(m,Date.now());
        const ps=p?.getPlayerState?.(),landed=q.action==='seek'&&Number.isFinite(target)&&Math.abs(target-pos)<=.65;if(landed&&ps===3&&!q.landed){q.landed=true;note('local-seek-landing',{action:q.action,status:ps,positionMs:Math.round(pos*1000),residualMs:Math.round((pos-target)*1000)});}
        if((expectedPlay&&playing&&motion)||(expectedPause&&ps===2&&stopped)||(landed&&(ps===1||ps===2))){transportCheck=null;note('local-transport-verified',{action:q.action,status:p?.getPlayerState?.(),ackLatencyMs:Math.round(at-q.at),positionMs:Math.round(pos*1000),residualMs:Number.isFinite(target)?Math.round((pos-target)*1000):null});}
      }
      if(transportCheck===q&&(at-q.at>=4200||at-q.at>=2500&&((expectedPlay&&!playing)||(expectedPause&&p?.getPlayerState?.()!==2)))){transportCheck=null;const fresh=identity&&ytPlayerReady&&c.e.connected&&c.e.matches&&age>=0&&age<=900&&stamp>q.stamp;note(fresh?'local-transport-unconfirmed':'local-transport-evidence-lost',{action:q.action,status:p?.getPlayerState?.(),ackLatencyMs:Math.round(at-q.at),positionMs:Number.isFinite(pos)?Math.round(pos*1000):null});}
    }
    if(m.paused!==false||m.ended||m.buffering||document.hidden||!c.e.connected||!c.e.matches||c.e.pending||!Number.isFinite(age)||age<0||age>900||!Number.isFinite(raw)){job.previous=null;job.sourceSince=null;job.motionSince=null;job.mismatchSince=null;return !identity || (!job.verified && m.paused===false);}
    if(job.verified&&!identity){job.verified=false;job.previous=null;job.sourceSince=null;job.motionSince=null;job.lastAction=at;}
    const prev=job.previous;if(prev&&stamp<=prev.stamp)return !job.verified;
    const dt=prev?(stamp-prev.stamp)/1000:0, ds=prev?raw-prev.raw:0, elapsed=prev?(at-prev.at)/1000:0, dp=prev?pos-prev.pos:0;
    const sourceMoving=prev&&dt>0&&dt<=1.8&&ds>=Math.max(.015,dt*rate*.35-.05)&&ds<=dt*rate*1.65+.2;
    if(!sourceMoving)job.sourceSince=null;else if(job.sourceSince===null)job.sourceSince=prev.at;
    const localMoving=sourceMoving&&prev.player===p&&prev.identity&&prev.playing&&identity&&playing&&ytPlayerReady&&elapsed>0&&elapsed<=1.8&&Number.isFinite(dp)&&dp>=Math.max(.015,elapsed*.25-.05)&&dp<=elapsed*3+.2;
    job.previous={at,stamp,raw,pos,player:p,identity,playing};
    if(job.verified){
      if(!sourceMoving||localMoving||!identity||!ytPlayerReady){job.mismatchSince=null;return false;}
      if(job.mismatchSince==null)job.mismatchSince=prev.at;
      if(at-job.mismatchSince<1400)return false;
      // Re-enter bounded recovery only after a new measured loss of motion.
      job={key:c.key,step:0,verified:false,previous:null,sourceSince:null,lastAction:at-3500};note('local-motion-lost',{status:p?.getPlayerState?.()});if(p?.getPlayerState?.()===2&&typeof p.playVideo==='function'){job.step=1;job.lastAction=at;c.l.suppressPlaybackEcho?.();note('play-retry',{attempt:1});try{p.playVideo();}catch{note('attempt-failed',{attempt:1});}}return true;
    }
    if(localMoving){if(job.motionSince==null){job.motionSince=prev.at;job.motionSamples=0;}job.motionSamples++;if(at-job.motionSince>=(job.alignSpent?700:900)&&job.motionSamples>=2){
      if(!job.motionNoted){job.motionNoted=true;note('motion-confirmed',{attempt:job.step,positionMs:Math.round(pos*1000)});}
      const target=window.WatchFusionLinkedPlaybackSync?.projectedPosition?.(m,Date.now()), gap=target-pos;
      if(!Number.isFinite(gap))return true;
      if(Math.abs(gap)>1.25 && !job.alignSpent && !job.terminal && typeof p?.seekTo==='function'){
        job.alignSpent=true;job.alignAt=at;job.previous=null;job.motionSince=null;c.l.suppressPlaybackEcho?.();
        note('alignment-requested',{positionMs:Math.round(target*1000),residualMs:Math.round(-gap*1000)});try{p.seekTo(Math.max(0,target),true);}catch{}return true;
      }
      if(job.alignSpent&&at-job.alignAt<1800&&Math.abs(gap)>.65)return true;
      if(Math.abs(gap)>1.25&&job.alignSpent&&!job.terminal){if(at-job.alignAt>=3500){job.motionSince=null; /* bounded existing ladder below */}else return true;}else {job.verified=true;job.terminal=null;note(Math.abs(gap)<=.1?'alignment-confirmed':'alignment-handoff',{positionMs:Math.round(pos*1000),residualMs:Math.round(-gap*1000)});return false;}
    }else return true;}job.motionSince=null;
    if(job.terminal||job.sourceSince===null||at-job.sourceSince<3500||at-job.lastAction<[3500,5000,8000,8000][Math.min(job.step,3)])return true;
    if(job.step>=3){if(!job.exhausted){job.exhausted=true;note('budget-exhausted');setStatus('Linked video could not start locally. Source preserved; reconnect or re-link to retry.');}return true;}
    const target=window.WatchFusionLinkedPlaybackSync?.projectedPosition?.(m,Date.now());if(!Number.isFinite(target))return true;
    const step=job.step===0&&job.alignSpent&&at-job.alignAt>=3500&&identity&&playing&&localMoving?(job.step=2):++job.step;job.lastAction=at;job.previous=null;job.sourceSince=null; c.l.suppressPlaybackEcho?.();
    try {
      if(step===1&&identity&&ytPlayerReady&&typeof p?.playVideo==='function'){note('play-retry',{attempt:step});p.playVideo();}
      else if(step<=2&&ytPlayerReady&&typeof p?.loadVideoById==='function'){note('reload-requested',{attempt:step,positionMs:Math.round(target*1000)});p.loadVideoById({videoId:c.id,startSeconds:Math.max(0,target)});}
      else if(step===3){note('rebuild-requested',{attempt:step,positionMs:Math.round(target*1000)});window.WatchFusionDecoderRescue.rebuildPlayer(c.id,target);}
      else {note('waiting-player-ready',{attempt:step});}
    }catch{note('attempt-failed',{attempt:step});}
    return true;
  }
  window.WatchFusionLinkedAcquisition={observe,holding,terminal,confirmedTransport,connection,reset:()=>{cancelTransport('local-transport-cancelled');job=null;connectionState=null;}};
})();

/* Shared source transition qualification. Page navigation can precede actual media metadata. */
(() => {
  let candidate=null, mirrorTimer=null;
  const id=m=>window.parseYoutubeInput?.(m?.pageUrl||'');
  const cancelMirror=()=>{if(mirrorTimer!==null)clearTimeout(mirrorTimer);mirrorTimer=null;};
  const reset=()=>{candidate=null;cancelMirror();};
  function accept(previous,sample,stamp,now){
    const next=id(sample),old=id(previous),raw=Number(sample.currentTime),rate=Number(sample.rate)||1;
    if(!next||!old||next===old){candidate=null;return true;}
    if(!Number.isFinite(raw)||raw<0||!Number.isFinite(stamp)||!Number.isFinite(now)||now-Number(sample.sampledAt)>900||sample.buffering){candidate=null;return false;}
    const sameTitle=!!previous.title&&sample.title===previous.title, oldTarget=Number(previous.currentTime)+(sample.sampledAt-Number(previous.sampledAt))/1000*(previous.paused||previous.ended?0:(Number(previous.rate)||1));
    // Reject the previous track's still-advancing metadata under the new page URL.
    if(sameTitle&&Number.isFinite(oldTarget)&&Math.abs(raw-oldTarget)<1.5){candidate=null;return false;}
    const p=candidate;if(p&&p.id===next&&now-p.now<120)return false;const dt=p?(stamp-p.stamp)/1000:0, delta=p?raw-p.raw:0;
    const coherent=p&&p.id===next&&p.paused===sample.paused&&p.title===sample.title&&dt>0&&dt<=1.8&&now-p.now>=120&&Math.abs(delta-(sample.paused?0:dt*rate))<.45;
    candidate={id:next,stamp,raw,now,paused:sample.paused,title:sample.title,since:coherent?p.since:now};
    if(!coherent||now-candidate.since<350)return false;
    if(sameTitle)sample.title='Matching linked video';candidate=null;return true;
  }
  // Coalesce burst arrivals; the latest sample wins. Never defer forced/transport/audio mirrors.
  function queueMirror(fn){const coalesced=mirrorTimer!==null;cancelMirror();mirrorTimer=setTimeout(()=>{mirrorTimer=null;fn();},80);return coalesced;}
  window.WatchFusionLinkedTransition={accept,reset,queueMirror,cancelMirror};
})();
