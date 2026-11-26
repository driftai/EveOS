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
  let motion=null, provenStep=-Infinity, retryAt=-Infinity, retrySince=null, handoff=null;
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
    if(handoff&&at-handoff.at>=3000){recordRecovery(Math.abs(target-position)<=.1||Math.abs(target-position)<Math.abs(handoff.error)*.7?'handoff-verified':'handoff-unverified',{scope:raw,drift:target-position});handoff=null;}
    return true;
  }
  function handoffReady(io,at,error){return steps>0&&!warm&&!rejoinSpent&&provenStep===lastStepAt&&error>=.45&&error<=8&&motionVerified(transportScope,at)&&io?.follower===true&&!io.hostLinked&&io.tvIdentity===scope&&io.valid?.()===true;}
  // Only a decoder that really recovered and subsequently stalled gets one
  // further reload, after a fresh reference dwell. Persistent failure stops.
  function retryTerminal(input,at,wedged){
    const confirmed=input.buffering&&Math.abs(input.drift)>=MIN_DRIFT_SEC||input.qualifiedStall===true&&input.stalledMs>=STALL_DWELL_MS;
    if(!wedged||!confirmed||input.follower!==true||!input.trusted||input.sourceQualified!==true||input.sourceBuffering||input.mirrorContradicted||document.hidden||steps!==2||warm||provenStep!==lastStepAt||at-lastStepAt<45000||at-retryAt<CHECKPOINT_MS||typeof input.reload!=='function'){retrySince=null;return false;}
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
    warm = null; recovered = null; protectedStep=0; rejoinCandidate = null; rejoinSpent = false; motion=null;provenStep=-Infinity;retrySince=null;handoff=null;scope = next; since = 0; steps = 0; lastStepAt = -Infinity; liveSeenAt = -Infinity;
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
    if (raw !== transportScope || paused === true) { transportScope=raw; recovered=null; rejoinCandidate=null; motion=null;retrySince=null; }
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
  window.WatchFusionDecoderRescue = {version: 'adaptive-room-06jidk', observeContinuity,motionVerified,handoffReady,recoveryEvents,acknowledgeRecovery,consider, qualifiesStall, observeTransport, rebuildPlayer, settling, isSettling, allowAutomaticRejoin, canOwnPostRelease,
    diagnostics: () => ({scope, attempted: steps > 0, steps, outcome, healthyProgressMs: Math.round(healthyProgressMs),
      rearmCount, healCount, lastRearmDwellMs, pauseObserved: wasRoomPaused})};
})();
