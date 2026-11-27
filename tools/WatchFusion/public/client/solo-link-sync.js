/* v13.10.7: Linked-tab auto sync with no room.
 * Before this, a solo preview only re-seeked when it was more than 1.25 s away from the linked tab, so it
 * could sit hundreds of ms off forever. Same policy as rooms: <=50 ms Locked (then a gentle walk toward 0),
 * 50 ms .. 1 s soft rate pulses, a stable >0.9 s gap gets one quiet rejoin per video. The source tab stays
 * authoritative; nothing here is ever sent back to it (rate pulses and rejoins are echo-suppressed).
 */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.WatchFusionSoloLinkSync) return;
  const PERIOD = 250, MAX_AGE = 900, WINDOW_MS = 2400, MIN_SAMPLES = 6, MIN_SPAN = 1200, COOLDOWN = 1800;
  const ZERO_MS = 16, LOCK_MS = window.WatchFusionPrecisionPolicy?.LOCK_MS ?? 50, ACTION_MS = window.WatchFusionPrecisionPolicy?.ACTION_MS ?? 100, REJOIN_SEC = .9, MAX_FAIL = 3;
  let scope = '', points = [], pulse = null, cooldownUntil = 0, rejoins = 0, fail = 0, lastAt = -Infinity, pending = null;
  let reason = 'idle', lastErrorMs = null, medianMs = null;
  let fineFail = 0, uncertainTrials = 0, exhausted = null, rearmed = false, lastTransport = '', lastTransportAt = -Infinity, lastSample = null, honored = false, fineUncertain = 0, evidenceRetry = false, blockedAt = -Infinity, lastBlock = '';
  const emit = (kind, detail) => { try { window.watchFusionRoomSyncLog?.note?.(kind,detail); } catch {} };
  const now = () => performance.now();
  const median = v => { const s = v.slice().sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const readRate = () => { try { return Number(ytPlayer?.getPlaybackRate?.()); } catch { return NaN; } };
  function release(why = 'rate-complete') {
    const p = pulse; if (!p) return;
    pulse = null; clearTimeout(p.timer); lastAt = now(); cooldownUntil = lastAt + COOLDOWN;
    try { if (Math.abs(Number(p.player?.getPlaybackRate?.()) - p.rate) < .015) { window.watchFusionLinkedTab?.suppressPlaybackEcho?.('solo-rate'); p.player.setPlaybackRate(p.base); } } catch {}
    reason = why;
    emit('solo-rate-finished',{reason:why,rate:p.rate,durationMs:Math.round(now()-p.at)});
  }
  function reset(next) { release('scope-ended'); scope = next; points = []; rejoins = fail = fineFail = uncertainTrials = 0; pending = exhausted = lastSample = null; rearmed = honored = evidenceRetry = false; fineUncertain=0; blockedAt = -Infinity; lastBlock = ''; lastTransport = ''; lastTransportAt = -Infinity; cooldownUntil = 0; lastErrorMs = medianMs = null; reason = next ? 'new-source' : 'idle'; }
  function transport(kind) { if (!scope || roomId || !['source-play','source-pause','source-seek-confirmed'].includes(kind)) return; release('transport-changed'); points = []; pending = lastSample = exhausted = null; fail = fineFail = rejoins = uncertainTrials = 0; rearmed = evidenceRetry = false; fineUncertain=0; blockedAt = -Infinity; lastBlock = ''; lastTransportAt = now(); reason = 'transport-changed'; emit('solo-transport-rearmed',{reason:kind}); }
  function discardPending(why,block) { if(pending===null)return; if(Math.abs(pending)*1000<=LOCK_MS)fineUncertain++;else {uncertainTrials++;if(uncertainTrials>=MAX_FAIL&&!exhausted)exhausted={at:now(),error:Math.abs(pending)};} emit('solo-rate-verified',{reason:why,action:block,beforeMs:Math.round(-pending*1000)}); pending=null; }
  function recordBlock(block,at){if(block){blockedAt=at;if(block!==lastBlock)emit('solo-correction-blocked',{reason:block});}else if(lastBlock)emit('solo-correction-unblocked',{reason:lastBlock});lastBlock=block;}
  const isApplying = () => !!pulse || now() - lastAt < 700;
  function display() {
    let node = document.getElementById('watchfusionSoloLinkStatus');
    if (!node) {
      const host = document.getElementById('syncStatus'); if (!host?.parentNode) return;
      node = document.createElement('small'); node.id = 'watchfusionSoloLinkStatus'; node.style.marginLeft = '8px';
      node.setAttribute('role', 'status'); host.parentNode.insertBefore(node, host.nextSibling);
    }
    node.hidden = !scope || !!roomId || window.WatchFusionSoloDiagnostics?.active?.()===true; if (node.hidden) return;
    const e = medianMs ?? lastErrorMs, a = Math.abs(e ?? 0);
    const label = e === null ? 'Measuring' : a <= LOCK_MS ? 'Locked' : a <= 100 ? 'Refining' : 'Correcting';
    node.textContent = 'Linked tab sync: ' + label + (e === null ? '' : ' (' + (e > 0 ? '+' : '') + Math.round(e) + ' ms)');
  }
  function step() {
    const linked = window.watchFusionLinkedTab, metadata = linked?.metadata?.();
    const on = linked?.active?.() && !roomId && ytPlayer && ytPlayerReady && !playerInitializing && !primingPlayer && metadata?.pageUrl;
    const id = on ? window.parseYoutubeInput?.(metadata.pageUrl) : '';
    const next = on && id && (state?.source?.videoId || pendingVideoId) === id ? id : '';
    if (next !== scope) reset(next);
    display();
    const at = now();
    const age = Date.now() - Number(metadata?.sampledAt), evidence=linked?.soloEvidence?.();
    const applyBlock=typeof linked?.soloCorrectionBlock==='function'?linked.soloCorrectionBlock():linked?.applying?.()?'external-apply':null;
    const blocked = !next?'media-scope':window.WatchFusionLinkedAcquisition?.holding?.()?'acquisition-pending':document.hidden?'background':evidence?.connected===false?'source-disconnected':evidence?.matches===false?'media-mismatch':metadata.paused!==false||metadata.ended?'source-paused':metadata.buffering===true?'source-buffering':ytPlayer.getPlayerState?.()!==1?'player-not-playing':ytPlayer.getVideoData?.()?.video_id!==next?'player-mismatch':['seek','rate','play','pause'].some(k=>linked.pendingControl?.(k))||evidence?.pending?'pending-transport':applyBlock||(!Number.isFinite(age)||age<0||age>MAX_AGE?'stale-source-sample':null);
    if (blocked) { if(scope)recordBlock(blocked,at); if(pulse)release('evidence-lost'); points = []; lastSample = null; discardPending('evidence-lost',blocked); lastErrorMs = medianMs = null; reason = blocked==='stale-source-sample'?blocked:'awaiting-playback'; return; }
    recordBlock('',at);
    if (pulse) { const base=Number(metadata.rate)||1, raw=Number(metadata.currentTime), stamp=Number(metadata.sampledAt), position=Number(ytPlayer.getCurrentTime?.()); const prior=pulse.motion; if(!Number.isFinite(raw)||!Number.isFinite(position)||Math.abs(base-pulse.base)>.015||(prior&&stamp!==prior.stamp&&((stamp-prior.stamp)>1800||stamp<=prior.stamp||Math.abs(raw-prior.raw-(stamp-prior.stamp)/1000*base)>.35||((stamp-prior.stamp)>=120&&raw-prior.raw<Math.max(.015,(stamp-prior.stamp)/1000*base*.35-.05))||Math.abs(position-prior.position-(at-prior.at)/1000*pulse.rate)>.45||((at-prior.at)>=120&&position-prior.position<Math.max(.015,(at-prior.at)/1000*pulse.rate*.35-.05))))){recordBlock('pulse-motion-discontinuity',at);release('evidence-lost');discardPending('evidence-lost','pulse-motion-discontinuity');return;}if(!prior||stamp!==prior.stamp)pulse.motion={stamp,raw,position,at}; if (at - pulse.at >= 350 && Math.abs(readRate() - pulse.rate) > .015) { const before = pulse.before; release('rate-rejected'); pending = null; fail = fineFail = MAX_FAIL; exhausted = {at,error:Math.abs(before)}; } return; }
    const base = Math.min(2, Math.max(.25, Number(metadata.rate) || 1));
    if (Math.abs(readRate() - base) > .015) { points = []; reason = 'awaiting-source-rate'; return; }
    const target = window.WatchFusionLinkedPlaybackSync?.projectedPosition?.(metadata, Date.now());
    const position = Number(ytPlayer.getCurrentTime?.());
    if (!Number.isFinite(target) || !Number.isFinite(position)) { points = []; return; }
    const error = target - position; lastErrorMs = Math.round(error * 1000);
    const sampleAt = Number(metadata.sampledAt), raw = Number(metadata.currentTime);
    const transportKey = String(base); if(lastTransport && lastTransport!==transportKey) transport('source-play'); lastTransport=transportKey;
    if (lastSample && sampleAt !== lastSample.sampleAt) { const dt=(sampleAt-lastSample.sampleAt)/1000, localDt=(at-lastSample.at)/1000, ds=raw-lastSample.raw, dp=position-lastSample.position; if(dt<=0||dt>1.8||localDt<=0||localDt>1.8||ds<Math.max(.015,dt*base*.35-.05)||ds>dt*base*1.65+.2||dp<Math.max(.015,localDt*base*.35-.05)||dp>localDt*base*1.65+.2){ points=[]; recordBlock('motion-discontinuity',at); discardPending('motion-discontinuity','motion-discontinuity'); } }
    if(!lastSample||sampleAt!==lastSample.sampleAt)lastSample={sampleAt,raw,position,at};
    if (at < cooldownUntil) { points = []; reason = 'settling'; return; }
    points.push({at, error,sampleAt,raw,position}); points = points.filter(p => at - p.at <= WINDOW_MS);
    if (points.length < MIN_SAMPLES || at - points[0].at < MIN_SPAN || new Set(points.map(p=>p.sampleAt)).size<3 || raw-points[0].raw<.35 || position-points[0].position<.35) { reason = 'measuring'; return; }
    const values = points.map(p => p.error), m = median(values), abs = Math.abs(m);
    const mad = median(values.map(v => Math.abs(v - m)));
    medianMs = Math.round(m * 1000); display();
    if (mad > Math.max(.012, abs * .25)) { reason = 'source-sample-jitter'; return; }
    if (pending) { const before=Math.abs(pending), improvement=before-abs, effective=abs*1000<=ZERO_MS||improvement>=Math.max(.008,before*.15); if(effective){honored=true;fail=fineFail=uncertainTrials=fineUncertain=0;exhausted=null;}else if(before*1000<=LOCK_MS)fineFail++;else fail++; if((fail>=MAX_FAIL||fineFail>=MAX_FAIL)&&!exhausted)exhausted={at,error:abs}; emit('solo-rate-verified',{reason:effective?'improved':'inconclusive',beforeMs:Math.round(-pending*1000),residualMs:Math.round(-m*1000)});pending=null; }
    if (abs * 1000 <= ZERO_MS) { reason = 'solo-zero-band'; return; }
    if(honored&&abs*1000<=LOCK_MS&&at-lastAt<10000){reason='solo-precision-retained';return;}
    if(exhausted&&!rearmed&&honored&&at-exhausted.at>=15000&&at-lastTransportAt>=15000&&abs*1000>LOCK_MS&&abs-exhausted.error>=.025){rearmed=true;fail=fineFail=uncertainTrials=0;exhausted=null;emit('solo-rate-rearmed',{reason:'material-drift-returned',residualMs:Math.round(abs*1000)});}
    if(uncertainTrials>=MAX_FAIL&&!evidenceRetry&&exhausted&&at-exhausted.at>=15000&&at-blockedAt>=3000&&abs*1000>ACTION_MS){evidenceRetry=true;uncertainTrials=0;if(fail<MAX_FAIL&&fineFail<MAX_FAIL)exhausted=null;emit('solo-rate-rearmed',{reason:'fresh-evidence-after-inconclusive',residualMs:Math.round(abs*1000)});}
    if (abs > REJOIN_SEC) {
      if (rejoins >= 1) { reason = 'solo-rejoin-spent'; return; }
      rejoins++; lastAt = at; cooldownUntil = at + 4000; points = [];
      try { linked.suppressPlaybackEcho?.(); ytPlayer.seekTo(target + .15 * base, true); reason = 'solo-one-rejoin';
        window.watchFusionRoomSyncLog?.note?.('solo-sync-one-rejoin', {positionMs: Math.round(m * 1000)}); } catch { reason = 'seek-unavailable'; }
      return;
    }
    if (fail >= MAX_FAIL || uncertainTrials >= MAX_FAIL || ((fineFail >= MAX_FAIL||fineUncertain>=MAX_FAIL) && abs*1000<=ACTION_MS)) { reason = 'solo-rate-not-effective'; return; }
    const rates = (ytPlayer.getAvailablePlaybackRates?.() || []).filter(r => Number.isFinite(r) && Math.sign(r - base) === Math.sign(m)
      && Math.abs(r - base) >= .03 && Math.abs(r - base) <= .26).sort((a, b) => Math.abs(a - base) - Math.abs(b - base));
    if (!rates.length) { reason = 'fixed-rate-preview'; return; }
    const rate = rates[0], ms = Math.max(60, Math.min(abs > .1 ? 3000 : 420, abs * .75 / Math.abs(rate - base) * 1000));
    try { linked.suppressPlaybackEcho?.('solo-rate'); ytPlayer.setPlaybackRate(rate); } catch { fail = MAX_FAIL; reason = 'rate-unavailable'; return; }
    pulse = {rate, base, at, before:m, player:ytPlayer, motion:{stamp:sampleAt,raw,position,at}, timer: setTimeout(() => release(), ms)}; lastAt = at; pending = m; points = []; lastSample = null;
    reason = abs * 1000 <= LOCK_MS ? 'solo-zero-walk' : 'solo-rate-refining';
    emit('solo-rate-started',{reason,rate,beforeMs:Math.round(-m*1000),durationMs:ms});
  }
  setInterval(() => { try { step(); } catch { reason = 'solo-controller-error'; } }, PERIOD);
  document.addEventListener('visibilitychange', () => { if (document.hidden) reset(''); });
  window.WatchFusionSoloLinkSync = {version: 'solo03', isApplying, transport,
    diagnostics: () => ({version:'solo03',active: !!scope, reason, block:lastBlock, evidenceRetry, fineUncertain, rejoins, fail, fineFail, uncertainTrials, rearmed, honored, errorMs: lastErrorMs, medianMs, rateActive: !!pulse})};
})();

/* Standalone Auto Sync observation only. No room, network, playback or audio commands. */
(() => {
  'use strict';
  const byId = id => typeof document !== 'undefined' ? document.getElementById?.(id) : null;
  const panel = byId('presentationPanel'), health = byId('roomPlayoutStatus'), status = byId('presentationStatus'), peers = byId('presentationPeers');
  if (!panel || !health || !status || !peers) return;
  const MAX_ROWS = 3000, MAX_EVENTS = 2400, MAX_AGE = 3600000;
  let scope = '', track = '', sequence = 0, previous = null, dwell = 0, accepted = 0;
  let snapshots = [], events = [], droppedSnapshots = 0, droppedEvents = 0, lastAt = -Infinity, lastKey = '', lastView = '', soloCard = null, copyGeneration = 0;
  const active = () => !roomId && window.watchFusionLinkedTab?.active?.() === true;
  const number = v => typeof v === 'number' && Number.isFinite(v) ? v : null;
  const ms = v => number(v) === null ? null : Math.round(v * 1000);
  const integer = v => number(v) === null ? null : Math.round(v);
  const safeWord = v => typeof v === 'string' && /^[a-z0-9-]{1,50}$/.test(v) ? v : null;
  const title = v => typeof v === 'string' ? v.replace(/(?:https?:\/\/|www\.)\S+/gi,'[link]').replace(/[\u0000-\u001f\u007f]/g,' ').trim().slice(0,110)||null : null;
  const signed = v => v === null ? 'Unavailable' : (v > 0 ? '+' : '') + v + ' ms';
  const iso = n => new Date(n).toISOString();
  const resetEvidence = () => { previous = null; dwell = accepted = 0; };
  function clear() { copyGeneration++; snapshots = []; events = []; droppedSnapshots = droppedEvents = 0; lastAt = -Infinity; lastKey = ''; resetEvidence(); }
  function context() {
    if (!active()) { if(scope)copyGeneration++; scope = ''; track = ''; sequence = 0; resetEvidence(); return null; }
    const link = window.watchFusionLinkedTab, evidence = link.soloEvidence?.(), m = link.metadata?.() || {};
    if (!evidence?.scope) return null;
    if (evidence.scope !== scope) { scope = evidence.scope; track = ''; sequence = 0; clear(); }
    if (m.pageUrl && m.pageUrl !== track) { track = m.pageUrl; sequence++; resetEvidence(); }
    return {m, evidence};
  }
  function prune(at) {
    while (snapshots.length && (snapshots.length > MAX_ROWS || at - snapshots[0].atMs > MAX_AGE)) { snapshots.shift(); droppedSnapshots++; }
    while (events.length && (events.length > MAX_EVENTS || at - events[0].atMs > MAX_AGE)) { events.shift(); droppedEvents++; }
  }
  function note(kind, detail = {}) {
    if (!context() || !/^(?:ui-intent|embedded-control|source-(?:play|pause|volume|track-transition|seek-confirmed|seek-unconfirmed|seek-retry|transport-unconfirmed|transport-retry|control-timeout|volume-unconfirmed)|mirror-(?:request|applied|expired|stale-skipped)|linked-(?:auto-reconnect|queued-control-sent)|solo-(?:sync-one-rejoin|rate-started|rate-finished|rate-verified|rate-rearmed|transport-rearmed|correction-blocked|correction-unblocked)|media-player-error|linked-acquisition|runtime-(?:visibility|freeze|resume))$/.test(kind)) return;
    const atMs = Date.now(), row = {atMs, kind, track:sequence};
    for (const k of ['action','reason','reference']) { const v = safeWord(detail[k]); if (v) row[k] = v; }
    for (const k of ['positionMs','sampleAgeMs','sourceAgeMs','volumePct','rate','sequence','ackLatencyMs','roundTripMs','attempt','errorMs','beforeMs','residualMs','durationMs','status']) { const v = number(detail[k]); if (v !== null) row[k] = v; }
    for (const k of ['paused','playing','queued','hidden']) if (typeof detail[k] === 'boolean') row[k] = detail[k];
    events.push(row); prune(atMs);
  }
  function readPlayer(m, evidence) {
    const s = state?.source || {}, mode = window.watchFusionYoutubePlaybackMode?.mode?.(s);
    try {
      if (s.kind === 'media' && (mode !== 'embed')) {
        const v = typeof mediaVideo === 'undefined' ? null : mediaVideo;
        return {kind:'direct', matched:evidence.matches === true, ready:!!v && mediaPlayerReady === true && v.readyState >= 2,
          position:v ? number(v.currentTime) : null, rate:v ? number(v.playbackRate) : null, playing:!!v && !v.paused && !v.ended,
          buffering:!!v && (v.readyState < 3 || v.seeking), audible:v ? !v.muted && v.volume > 0 : null};
      }
      if (s.videoId || s.kind === 'youtube') {
        const p = ytPlayer, expected = window.parseYoutubeInput?.(m.pageUrl), ps = p?.getPlayerState?.();
        const vol = number(p?.getVolume?.()), muted = p?.isMuted?.();
        return {kind:'youtube', matched:evidence.matches === true && !!expected && s.videoId === expected && p?.getVideoData?.()?.video_id === expected,
          ready:!!p && ytPlayerReady === true && !playerInitializing && !primingPlayer, position:number(p?.getCurrentTime?.()), rate:number(p?.getPlaybackRate?.()),
          playing:ps === 1, buffering:ps === 3, audible:typeof muted === 'boolean' && vol !== null ? !muted && vol > 0 : null};
      }
    } catch { return {kind:'unavailable',matched:false,ready:false}; }
    return {kind:'unsupported',matched:false,ready:false};
  }
  function inspect(m,evidence,atMs) {
    const p = readPlayer(m,evidence), age = atMs - Number(m.sampledAt), sourceRate = number(m.rate) ?? 1;
    const sourcePos = number(m.currentTime), sourceClock = ['server-qualified','relay-bounded'].includes(m.sampleClock) ? m.sampleClock : 'unverified';
    const fresh = Number.isFinite(age) && age >= 0 && age <= 900 && sourcePos !== null && sourcePos >= 0;
    const c = p.kind === 'youtube' ? window.WatchFusionSoloLinkSync?.diagnostics?.() || {} : {};
    let phase = 'measuring', errorMs = null, progress = false;
    if (document.hidden) phase = 'background-unmeasured';
    else if (!evidence.connected) phase = 'source-disconnected';
    else if (!p.matched) phase = p.kind === 'unsupported' ? 'awaiting-supported-media' : 'awaiting-media-match';
    else if (evidence.pending) phase = 'transport-pending';
    else if (p.kind==='youtube'&&window.WatchFusionLinkedAcquisition?.holding?.()) phase='acquisition-pending';
    else if (!fresh) phase = 'stale-source';
    else if (m.buffering === true || p.buffering) phase = 'buffering';
    else if (m.ended === true || m.paused === true) phase = 'paused-or-ended';
    else if (m.paused !== false || !p.ready || !p.playing || p.position === null || p.position < 0 || p.rate === null || p.rate <= 0) phase = 'awaiting-playback';
    else {
      const target = window.WatchFusionLinkedPlaybackSync?.projectedPosition?.(m,atMs);
      if (Number.isFinite(target)) errorMs = ms(p.position-target);
      const cur = {at:atMs, sample:Number(m.sampledAt), source:sourcePos, local:p.position, rate:sourceRate, localRate:p.rate};
      const prior = previous;
      if (!prior || cur.sample !== prior.sample) previous = cur;
      if (prior && cur.sample !== prior.sample) {
        const dt = (cur.at-prior.at)/1000, ds = (cur.sample-prior.sample)/1000;
        const sourceStep = cur.source-prior.source, localStep = cur.local-prior.local;
        const expected = dt * p.rate, sourceExpected = ds * sourceRate;
        if (dt > 0 && dt <= 1.8 && ds > 0 && ds <= 1.8 && Math.abs(cur.rate-prior.rate)<.015 && Math.abs(cur.localRate-prior.localRate)<.015 &&
            localStep > Math.max(.02,expected*.45-.08) && localStep <= expected*1.6+.15 &&
            sourceStep > Math.max(.02,sourceExpected*.45-.08) && sourceStep <= sourceExpected*1.6+.15) { accepted++; dwell += dt; }
        else { accepted = dwell = 0; }
      }
      progress = accepted >= 2 && dwell >= 1.2;
      if (c.rateActive || Math.abs(p.rate-sourceRate)>.015) phase = 'correcting';
      else if (!progress || errorMs === null || sourceClock === 'unverified') phase = 'progress-unverified';
      else if (Math.abs(errorMs)<=50) phase = 'within-50-estimate';
      else if (Math.abs(errorMs)<=100) phase = 'monitoring';
      else phase = 'outside-100';
    }
    if (errorMs === null) resetEvidence();
    const h=typeof location==='undefined'?'':location.hostname,originClass=/(?:^|\.)sslip\.io$/i.test(h)?'sslip':/^(localhost|127\.0\.0\.1)$/i.test(h)?'loopback':/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)?'raw-ip':/(?:^|\.)trycloudflare\.com$/i.test(h)?'cloudflare':h?'other':'unverified';
    return {atMs,track:sequence,title:title(m.title||state?.source?.title),durationMs:ms(number(m.duration)),mode:p.kind,phase,originClass,
      playerPositionMs:ms(p.position),sourcePositionMs:ms(sourcePos),playerMinusSourceMs:errorMs,sourceSampleAgeMs:Number.isFinite(age)&&age>=0?integer(age):null,
      sourceClock,sourceUncertaintyMs:sourceClock==='server-qualified'?integer(m.uncertaintyMs):null,progressVerified:progress,sourceRate,playerRate:p.rate??null,
      playerPlaying:p.playing===true,sourcePlaying:m.paused===false&&m.ended!==true,sourceBuffering:m.buffering===true,playerBuffering:p.buffering===true,
      sourceTabMuted:typeof m.tabMuted==='boolean'?m.tabMuted:null,sourcePlayerSilenced:typeof m.sourcePlayerSilenced==='boolean'?m.sourcePlayerSilenced:null,
      playerAudible:p.audible??null,controller:{version:p.kind==='youtube'?(safeWord(c.version)||'v13.10.7'):null,active:c.active===true,reason:safeWord(c.reason),rateActive:c.rateActive===true,
        targetMinusPlayerMs:integer(c.errorMs),medianTargetMinusPlayerMs:integer(c.medianMs),rejoins:integer(c.rejoins),failedTrials:integer(c.fail),fineFailedTrials:integer(c.fineFail),inconclusiveTrials:integer(c.uncertainTrials),rateRearmed:c.rearmed===true,block:safeWord(c.block),evidenceRetry:c.evidenceRetry===true,fineInconclusiveTrials:integer(c.fineUncertain)}};
  }
  const labels = {'background-unmeasured':'Background · unmeasured','source-disconnected':'Source disconnected','awaiting-media-match':'Matching media','awaiting-supported-media':'Waiting for supported media','transport-pending':'Transport pending','acquisition-pending':'Acquiring media and timing','stale-source':'Waiting for fresh source','buffering':'Buffering','paused-or-ended':'Paused or ended','awaiting-playback':'Waiting for playback','correcting':'Correcting','progress-unverified':'Measuring progression','within-50-estimate':'Within 50 ms · estimate','monitoring':'Monitoring 50–100 ms','outside-100':'Outside 100 ms','measuring':'Measuring'};
  function render() {
    const ctx = context(), enabled = active();
    if (!enabled) {
      if (soloCard) { soloCard.remove?.(); soloCard = null; lastView = ''; }
      if (!roomId) panel.hidden = true;
      return;
    }
    panel.hidden = false;
    for (const id of ['presentationCapture','presentationChoice']) { const el=byId(id);if(el)el.hidden=true; }
    if (!ctx) { health.textContent = 'Auto sync · waiting for source'; status.textContent = 'Waiting for linked source.'; return; }
    const r = inspect(ctx.m,ctx.evidence,Date.now()), label = labels[r.phase] || 'Measuring';
    const key = [r.track,r.phase,r.controller.reason,r.controller.rateActive,r.sourceTabMuted,r.playerAudible].join('|');
    if (key!==lastKey || r.atMs-lastAt >= (r.phase==='within-50-estimate'||r.phase==='paused-or-ended'?2300:650)) {
      snapshots.push(r); lastAt=r.atMs; lastKey=key; prune(r.atMs);
    }
    const headline = 'Auto sync · '+label; if (health.textContent!==headline) health.textContent=headline;
    window.watchFusionRoomSyncLog?.render?.();
    if (!panel.open) return;
    const view = JSON.stringify([r.phase,r.playerMinusSourceMs,r.sourceSampleAgeMs,r.sourceClock,r.progressVerified,r.playerRate,r.sourceTabMuted,r.playerAudible,r.controller.reason,r.controller.rejoins]);
    if (view!==lastView || !soloCard || soloCard.parentNode!==peers) {
      lastView=view; status.textContent=label+' · local player versus linked source (not speaker timing)';
      const values=[['Player vs source',signed(r.playerMinusSourceMs)],['Source sample age',r.sourceSampleAgeMs===null?'Unavailable':r.sourceSampleAgeMs+' ms'],['Source clock',r.sourceClock],['Playback progression',r.progressVerified?'Observed':'Unverified'],['Player rate',r.playerRate===null?'Unavailable':String(r.playerRate)],['Source tab mute',r.sourceTabMuted===null?'Unverified':r.sourceTabMuted?'Confirmed':'Not muted'],['Player audio',r.playerAudible===null?'Unverified':r.playerAudible?'Audible':'Muted'],['Controller reason',r.controller.reason||'No controller report'],['Rejoins',r.controller.rejoins===null?'N/A':String(r.controller.rejoins)]];
      const element=(tag,cls,text)=>{const el=document.createElement(tag);el.className=cls;if(text!=null)el.textContent=text;return el;};
      soloCard=element('li','sync-peer-card'); const heading=element('div','sync-peer-head');
      heading.append(element('strong','sync-peer-name','This device'),element('span','sync-peer-state',label));
      const metrics=element('div','sync-peer-metrics');
      for(const [k,v] of values){const el=element('span','sync-peer-metric');el.append(element('span','',k),element('b','',v));metrics.append(el);}
      soloCard.append(heading,metrics);peers.replaceChildren(soloCard);
    }
  }
  function logView() { prune(Date.now());return {count:snapshots.length+' snapshots · '+events.length+' transitions',display:[snapshots.slice(-15).map(x=>iso(x.atMs)+' · '+labels[x.phase]+' · '+signed(x.playerMinusSourceMs)).join('\n'),events.slice(-10).map(x=>iso(x.atMs)+' · '+x.kind+(x.reason?' · '+x.reason:'')).join('\n')].filter(Boolean).join('\n')}; }
  function payload() { prune(Date.now()); const serialize = ({atMs,...row}) => ({at:iso(atMs),...row}); return {format:'WatchFusion standalone sync trace v1',generatedAt:iso(Date.now()),mode:'standalone-linked',disclosure:'Local player/source timeline estimates only; no room, audio, URLs or credentials. Song titles included on copy.',retention:{maxSnapshots:MAX_ROWS,maxEvents:MAX_EVENTS,droppedSnapshots,droppedEvents},snapshots:snapshots.map(serialize),events:events.map(serialize)}; }
  panel.addEventListener('toggle',()=>{lastView='';render();});
  window.WatchFusionSoloDiagnostics = {active,render,note,payload,logView,clear,scopeToken:()=>context()?.evidence.scope||'',export:()=>JSON.stringify(payload(),null,2)};
})();
