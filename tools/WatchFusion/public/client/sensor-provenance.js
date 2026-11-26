/* WatchFusion v13.10.8e: say what a player timing sample is, and what it is not.
 * A YouTube IFrame position is relayed by message and can be held between updates; the attached
 * source tab is muted at tab level, so the room clock it drives is silent. Neither is speaker time.
 * Read-only: this module never seeks, rate-adjusts, mutes or calibrates anything. */
(() => {
  'use strict';
  const root = typeof window === 'undefined' ? globalThis : window;
  if (root.WatchFusionSensorProvenance) return;
  const POLL_MS = 50, KEEP = 24;
  let player = null, videoId = null, held = {value: null, since: -Infinity}, changes = [];
  // R14j: separate DOM sampling cadence from forward progress at the expected rate.
  // This describes the iframe's media clock, NOT decoded frames or speaker output.
  const MOTION_WINDOW_MS = 2400, MAX_POLL_GAP_MS = 500;
  let timeline = [], jumpedAt = -Infinity;
  function freshPoll(now, last) {
    return !!last && Number.isFinite(now) && now >= last.at && now - last.at <= MAX_POLL_GAP_MS;
  }
  function timelineMotion(now) {
    if (timeline.length < 3) return {timelineState:'unverified', timelineRatePct:null};
    const first=timeline[0], last=timeline[timeline.length-1], dt=last.at-first.at;
    if (!freshPoll(now, last) || dt < 1200) return {timelineState:'unverified',timelineRatePct:null};
    const expected=dt/1000*Math.max(.25,Math.min(2.1,last.rate||1));
    const moved=last.value-first.value, pct=Math.max(0,Math.min(300,Math.round(100*moved/expected)));
    const state=last.at-jumpedAt <= MOTION_WINDOW_MS ? 'jumped'
      : pct >= 70 && pct <= 135 ? 'advancing' : pct < 12 ? 'held' : 'slow';
    return {timelineState:state,timelineRatePct:pct};
  }

  function poll(now, value, playing, rate = 1) {
    if (!playing || !Number.isFinite(value) || !Number.isFinite(now)) {
      held = {value: null, since: -Infinity}; changes = []; timeline = []; jumpedAt = -Infinity; return;
    }
    const previous=timeline[timeline.length-1];
    if (previous && !freshPoll(now, previous)) {
      timeline = []; changes = []; jumpedAt = -Infinity; held = {value:null, since:now};
    } else if (previous) {
      const dt=Math.max(0,now-previous.at), moved=value-previous.value;
      // A seek/keyframe jump invalidates this window; do not treat it as smooth playback.
      if (moved < -.25 || moved > Math.max(1,dt/1000*Math.max(.25,rate)*3+.35)) {
        timeline=[]; jumpedAt=now;
      }
    }
    timeline.push({at:now,value,rate});
    timeline=timeline.filter(s=>now-s.at<=MOTION_WINDOW_MS).slice(-80);
    if (value === held.value) return;
    if (held.value !== null) { changes.push(now); if (changes.length > KEEP) changes.shift(); }
    held = {value, since: now};
  }
  function cadence() {
    if (changes.length < 4) return null;
    const gaps = changes.slice(1).map((at, i) => at - changes[i]).sort((a, b) => a - b);
    return Math.round(gaps[Math.floor(gaps.length / 2)]);
  }
  function audibleOutput({playerAudible, source}) {
    const sourceAudible = source && source.tabMuted === false && source.paused !== true && !(Number(source.volume) <= .01);
    const sourceKnown = !source || typeof source.tabMuted === 'boolean';
    if (playerAudible === null || !sourceKnown) return 'unknown';
    return playerAudible && sourceAudible ? 'both' : playerAudible ? 'player' : sourceAudible ? 'source-tab' : 'none';
  }
  // Four-timestamp offset intervals include path asymmetry; their intersection can tighten a conditional bound.
  // Clock fit includes timestamp granularity and modeled oscillator drift, not measured speaker accuracy.
  // Preserve the legacy spread check for callers without interval evidence; contradictory fits are unstable.
  // The remaining asymmetry inside the bound is unknown. Diagnostic only.
  function clockBound(c) {
    if (!c || !Number.isFinite(c.boundMs) || !Number.isFinite(c.ageMs)) return {clockBoundMs: null, clockState: 'unknown'};
    const clockBoundMs = Math.ceil(c.boundMs + Math.max(0, c.ageMs) * (c.intervalCoherent == null ? 1e-4 : 5e-4)) + 1;
    const clockState = c.ageMs > 15000 ? 'stale' : c.intervalCoherent === false ? 'unstable' : !c.precise ? 'coarse' : !(c.samples >= 3) ? 'thin'
      : c.intervalCoherent !== true && !(c.spreadMs <= 2 * c.boundMs + 2) ? 'unstable' : 'bounded';
    return {clockBoundMs, clockState};
  }
  // input: {direct, media, now, clock, source}: clock is watchPartyClock.offsetBound(); source is the linked tab's
  // metadata when this device publishes one.
  function describe(input = {}) {
    const {direct = false, media = null, now = performance.now(), clock = null, source = null} = input;
    let playerAudible = null;
    try {
      const volume = direct ? Number(media?.volume) : Number(media?.getVolume?.()) / 100;
      const muted = direct ? media?.muted === true : media?.isMuted?.();
      if (Number.isFinite(volume) && typeof muted === 'boolean') playerAudible = volume > .01 && !muted;
    } catch {}
    const tracked = !direct && media && media === player && currentVideo(media) === videoId &&
      held.value !== null && freshPoll(now, timeline.at(-1));
    return {
      domain: direct ? 'media-element' : 'player-timeline',
      heldMs: tracked ? Math.max(0, Math.round(now - held.since)) : null,
      cadenceMs: tracked ? cadence() : null,
      ...clockBound(clock),
      ...(tracked ? timelineMotion(now) : {timelineState:'unverified',timelineRatePct:null}),
      audibleOutput: audibleOutput({playerAudible, source})
    };
  }
  function currentVideo(media) {
    try { return media?.getVideoData?.()?.video_id || null; } catch { return null; }
  }
  function track(nextPlayer, now, value, playing, rate = 1) {
    const nextVideo = currentVideo(nextPlayer);
    if (nextPlayer !== player || nextVideo !== videoId) {
      player = nextPlayer; videoId = nextVideo;
      held = {value:null, since:-Infinity}; changes = []; timeline = []; jumpedAt = -Infinity;
    }
    poll(now, value, playing, rate);
  }
  if (typeof setInterval === 'function' && typeof document !== 'undefined') setInterval(() => {
    try {
      const yt = typeof ytPlayer === 'undefined' ? null : ytPlayer;
      track(yt, performance.now(), Number(yt?.getCurrentTime?.()), yt?.getPlayerState?.() === 1,
        Number(yt?.getPlaybackRate?.()) || 1);
    } catch {}
  }, POLL_MS);
  // Diagnostic only: membership, execution availability, and source following are independent.
  function activityEvidence({local, localKnown, hidden, paused, linked, rows, expectedViewers, previous, spread, gapMs}) {
    const advancing = p => !!p && Number.isFinite(p.comparisonOffsetMs) && p.playing && !p.buffering &&
      p.sensor?.timelineState === 'advancing' && ['decoder-confirmed','fine-locked','direct-ready'].includes(p.startupPhase);
    const active = advancing(local), sourceLive = linked?.mode === 'live-linked-source';
    const viewers = rows.filter(p=>p.role==='viewer'), measured = viewers.filter(p=>advancing(p) &&
      p.sensor?.clockState==='bounded' && Number.isFinite(p.sourceErrorMs));
    const maxViewerSourceErrorMs = measured.length ? Math.max(...measured.map(p=>Math.abs(p.sourceErrorMs))) : null;
    const expected = Number.isInteger(expectedViewers) && expectedViewers>=0 ? expectedViewers : null;
    const complete = sourceLive && expected>0 && measured.length===expected && viewers.length===expected;
    const sourceContinuity = paused ? 'room-paused' : !linked ? 'not-linked' : !sourceLive ? 'source-unverified' :
      maxViewerSourceErrorMs>100 ? 'viewer-source-outside-100' : !complete ? 'viewer-source-unmeasured' :
      maxViewerSourceErrorMs>50 ? 'viewer-source-monitoring' : 'viewer-source-within-50';
    const returning = previous?.localParticipation==='background-inactive' || previous?.localParticipation==='foreground-reacquiring' || (previous?.visibility==='hidden' && gapMs>10000 && !active);
    const aligned = active && sourceLive && Number.isFinite(local.sourceErrorMs) && Math.abs(local.sourceErrorMs)<=50 &&
      (expected===0 || (Number.isFinite(spread) && spread<=50));
    const localParticipation = paused ? 'room-paused' : !localKnown || typeof hidden!=='boolean' ? 'unverified' :
      hidden ? (active?'background-active':'background-inactive') : returning && !aligned ? 'foreground-reacquiring' :
      active ? 'foreground-active' : 'foreground-unavailable';
    return {visibility:typeof hidden==='boolean'?(hidden?'hidden':'visible'):'unverified',localParticipation,
      sourceContinuity,sourceLive,expectedViewers:expected,reportingViewers:viewers.length,measuredViewers:sourceLive?measured.length:0,
      maxViewerSourceErrorMs:sourceLive?maxViewerSourceErrorMs:null,coverageGapMs:Number.isFinite(gapMs)&&gapMs>=0?Math.round(gapMs):null};
  }
  root.WatchFusionSensorProvenance = {describe, track, audibleOutput, cadence, clockBound, activityEvidence};
})();
