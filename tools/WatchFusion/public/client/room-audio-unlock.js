/* v13.10.7: A member that joins starts at the host's room audio, not muted.
 * Members start muted when priming could not prove unmuted autoplay (slow TVs often miss the 2.5 s priming
 * window even when the browser would allow sound). Once playback is running, try the host's room volume once
 * and verify that it stays playing. If the browser really needs a tap, go back to muted playback, keep sync
 * intact, and show one "Enable room audio" button: a real tap is the only thing that can unlock sound.
 */
(() => {
  'use strict';
  if (typeof window === 'undefined' || window.WatchFusionRoomAudioUnlock) return;
  const ID = 'watchfusionEnableRoomAudio', VERIFY_MS = 900, START_GRACE_MS = 1500;
  const MISMATCH_DWELL_MS = 800, RECHECK_COOLDOWN_MS = 10000, VOLUME_TOLERANCE = 2;
  let scope = '', player = null, probe = null, tried = false, playingSince = 0, reason = 'idle';
  let mismatchSince = 0, nextRecheckAt = 0, needsTap = false, audioKey = '', recheckFailures = 0, lastGestureAt = -Infinity;
  let motion = null, movingSince = null, softDeferrals = 0, blockedEvents = 0, lastSegment = null;
  let fallbackAttempt = null;
  const owned = () => window.watchFusionViewerArbiter?.owns?.() === true || window.WatchFusionZeroConverge?.isApplying?.() === true || (!isHost() && window.WatchFusionDecoderRescue?.isSettling?.([roomId,state?.source?.videoId,state?.presentationEpoch,state?.playoutSegment].join(':'),performance.now()) === true);
  function motionReady(at) {
    const pos=Number(ytPlayer?.getCurrentTime?.()), rate=Number(ytPlayer?.getPlaybackRate?.())||1;
    if (!ytPlayerReady || playerInitializing || primingPlayer || ytPlayer?.getPlayerState?.()!==1 || !Number.isFinite(pos) || owned()) { motion=movingSince=null; return false; }
    const old=motion; motion={at,pos};
    if (!old || at-old.at<100 || at-old.at>1200 || pos-old.pos<(at-old.at)/1000*rate*.5 || pos-old.pos>(at-old.at)/1000*rate*1.5+.05) { movingSince=null; return false; }
    if (movingSince===null) movingSince=old.at;
    return at-movingSince>=400;
  }
  const safeVolume = () => { try { return Number(ytPlayer?.getVolume?.()); } catch { return NaN; } };
  const audioTelemetryAvailable = () => typeof ytPlayer?.getVolume === 'function'
    && typeof ytPlayer?.isMuted === 'function' && Number.isFinite(safeVolume());
  const audioMatches = target => {
    try { return ytPlayer?.isMuted?.() === false && Math.abs(safeVolume() - target.volume) <= VOLUME_TOLERANCE; }
    catch { return false; }
  };
  function button() {
    let node = document.getElementById(ID);
    if (node) return node;
    const anchor = document.getElementById('syncStatus'); if (!anchor?.parentNode) return null;
    node = document.createElement('button'); node.id = ID; node.type = 'button'; node.className = 'secondary';
    node.textContent = 'Enable room audio'; node.hidden = true; node.title = 'This browser needs one tap before it can play sound';
    node.addEventListener('click', () => {
      const audio = typeof authoritativeRoomAudio === 'function' ? authoritativeRoomAudio() : null;
      if (!scope || !ytPlayer || owned() || state?.playback?.paused || state?.playback?.ended || !audio || audio.muted || audio.volume <= 0 || ![1,2].includes(ytPlayer.getPlayerState?.())) return;
      userGesturePrimeUsed = true; autoplayWasBlocked = false; needsTap = false;
      try { applyRoomAudioState(ytPlayer, true); if (state?.playback && !state.playback.paused && ytPlayer?.getPlayerState?.() !== 1) ytPlayer.playVideo?.(); } catch { needsTap = true; }
      probe = needsTap ? null : {at: performance.now(), kind:'tap', blockedAt:blockedEvents};
      node.hidden = true; reason = needsTap ? 'audio-tap-failed' : 'audio-tap-verifying';
    });
    anchor.parentNode.insertBefore(node, anchor.nextSibling); return node;
  }
  function tick() {
    const audio = typeof authoritativeRoomAudio === 'function' ? authoritativeRoomAudio() : null;
    const ui = button();
    const next = roomId && audio && state?.source?.videoId && !isHost() ? [roomId, state.source.videoId, state.presentationEpoch].join(':') : '';
    // v13.10.8: a decoder rebuild or reload makes a new player that starts at its own default audio
    // (Drift's TV lost the room volume after a reload). A new player instance gets its own attempt.
    if (next !== scope || ytPlayer !== player) {
      scope = next; player = ytPlayer; probe = null; tried = false; playingSince = 0; lastGestureAt = -Infinity;
      mismatchSince = 0; nextRecheckAt = 0; needsTap = false; audioKey = ''; recheckFailures = 0; motion = movingSince = null; softDeferrals = 0; fallbackAttempt = null;
    }
    const expectedKey = audio ? `${audio.volume}:${audio.muted}` : '';
    if (expectedKey !== audioKey) { audioKey = expectedKey; probe=null; mismatchSince = 0; needsTap = false; nextRecheckAt = 0; recheckFailures = 0; tried=false; }
    const at = performance.now();
    if (state?.playback?.paused || state?.playback?.ended) { probe = null; mismatchSince = 0; playingSince = 0; motion = movingSince = null; if (ui) ui.hidden = true; return; }
    const segment = state?.playoutSegment;
    if (segment!==lastSegment) { lastSegment=segment; softDeferrals=0; motion=movingSince=null; playingSince=0; probe=null; if (!needsTap) tried=false; }
    const moving = motionReady(at);
    if (probe) { // while probing, applyRoomAudioState() keeps the room volume because autoplayWasBlocked is lowered
      if (ui) ui.hidden = true;
      if (!next) { probe = null; return; }
      if (at - probe.at < VERIFY_MS) return;
      // Buffering during a decoder reload is not an audio failure. A new PAUSED
      // state after unmuting, however, can mean the browser blocked autoplay.
      const playerState = ytPlayer?.getPlayerState?.();
      // A decoder stall, buffer or correction owner is not an autoplay refusal.
      // Keep a bounded observation window; do not restart transport or mute a healthy player.
      if (probe.blockedAt === blockedEvents && (playerState === 3 || owned() || (playerState === 1 && !moving))) {
        if (at-probe.at<4800) return;
        probe=null; playingSince=0; motion=movingSince=null; mismatchSince=0;
        softDeferrals++; tried=false; nextRecheckAt=at+1200;
        reason=softDeferrals<=2?'audio-decoder-deferred':'audio-motion-unverified';
        window.watchFusionRoomSyncLog?.note?.('room-audio-deferred',{reason});
        return;
      }
      if (probe.kind === 'recheck' && playerState !== 1 && at - probe.at < 1600) return;
      const ok = moving && ytPlayer?.getPlayerState?.() === 1 && audioMatches(audio) && probe.blockedAt === blockedEvents, wasStartup = probe.kind === 'startup';
      probe = null;
      if (ok) {
        mismatchSince = 0; needsTap = false; recheckFailures = 0; softDeferrals = 0; reason = 'room-audio-allowed';
        window.watchFusionRoomSyncLog?.note?.('room-audio-unlocked', {}); return;
      }
      // A live decoder can lose one volume application during track reinitialization.
      // Retry once with fresh evidence; never re-seek or loop indefinitely.
      if (!wasStartup && ytPlayer?.getPlayerState?.() === 1 && recheckFailures++ === 0) {
        mismatchSince = at; nextRecheckAt = at + 1200; reason = 'room-audio-retry-pending';
        window.watchFusionRoomSyncLog?.note?.('room-audio-retry-pending', {}); return;
      }
      needsTap = true; tried = true; reason = 'browser-requires-tap';
      // The startup probe may trigger a browser play-block; keep the video playing muted.
      // An ordinary volume mismatch must NOT cause a new mute or transport command.
      if (wasStartup) {
        autoplayWasBlocked = true;
        try { window.watchFusionLinkedTab?.suppressPlaybackEcho?.(); ytPlayer?.mute?.();
          if (state?.playback && !state.playback.paused) ytPlayer?.playVideo?.(); } catch {}
      }
      window.watchFusionRoomSyncLog?.note?.('room-audio-needs-tap', {reason: wasStartup ? 'autoplay' : 'audio-recheck'});
      return;
    }
    const wanted = !!next && !audio.muted && audio.volume > 0;
    const initialBlocked = wanted && autoplayWasBlocked && !userGesturePrimeUsed;
    if (ui) ui.hidden = !wanted || !(needsTap || (initialBlocked && (tried || ytPlayer?.getPlayerState?.() === 2)));
    if (!wanted || !ytPlayer || !ytPlayerReady || playerInitializing || primingPlayer || state?.playback?.paused) {
      mismatchSince = 0; if (!wanted && next) reason = 'room-audio-applied'; return;
    }
    // A legacy/rebuilt player may lack the position getter entirely. One audio-only
    // attempt after stable PLAYING is safe; missing telemetry is never motion proof.
    if (typeof ytPlayer.getCurrentTime !== 'function') {
      if (fallbackAttempt && !userGesturePrimeUsed && blockedEvents>fallbackAttempt.blockedAt) {
        needsTap=true; autoplayWasBlocked=true; reason='browser-requires-tap';
        if(ui)ui.hidden=false; return;
      }
      if (owned() || ytPlayer.getPlayerState?.() !== 1) { playingSince=0; return; }
      if (!playingSince) playingSince=at;
      if (!needsTap && !fallbackAttempt && initialBlocked && at-playingSince>=START_GRACE_MS) {
        tried=true; fallbackAttempt={blockedAt:blockedEvents}; autoplayWasBlocked=false;
        reason='audio-motion-telemetry-unavailable';
        try { ytPlayer.setVolume?.(audio.volume); ytPlayer.unMute?.(); }
        catch { reason='audio-attempt-unverified'; }
        window.watchFusionRoomSyncLog?.note?.('room-audio-deferred',{reason});
      }
      return;
    }
    if (!moving) { playingSince = 0; mismatchSince = 0; return; }
    if (!playingSince) playingSince = at;
    if (needsTap || softDeferrals > 2) return; // bounded attempts; a real refusal needs real authorization
    if (initialBlocked) {
      if (tried || at < nextRecheckAt || at - playingSince < START_GRACE_MS) return;
      tried = true; probe = {at, kind:'startup', blockedAt:blockedEvents}; autoplayWasBlocked = false;
      try { ytPlayer.setVolume?.(audio.volume); ytPlayer.unMute?.(); reason = 'trying-room-audio'; }
      catch { probe = null; autoplayWasBlocked = true; needsTap = true; reason = 'unmute-failed'; }
      return;
    }
    if (!audioTelemetryAvailable()) { mismatchSince = 0; reason = 'room-audio-telemetry-unavailable'; return; }
    // A decoder reload may reuse the SAME player object, and a browser may mute mid-play.
    // The initial one-shot check does not cover either case. Reapply the host's audio
    // locally after stable mismatch, with no seek, pause, play, or room publication.
    if (audioMatches(audio)) { mismatchSince = 0; recheckFailures = 0; reason = 'room-audio-applied'; return; }
    if (!mismatchSince) mismatchSince = at;
    if (at - mismatchSince < MISMATCH_DWELL_MS || at - playingSince < START_GRACE_MS || at < nextRecheckAt) return;
    nextRecheckAt = at + RECHECK_COOLDOWN_MS; mismatchSince = 0; tried = true;
    probe = {at, kind:'recheck', blockedAt:blockedEvents}; reason = 'room-audio-rechecking';
    window.watchFusionRoomSyncLog?.note?.('room-audio-reapplied', {volumePct: Math.round(audio.volume), reason:'audio-recheck'});
    try { if (applyRoomAudioState(ytPlayer, true) !== true) throw Error('room audio unavailable'); }
    catch { probe = null; needsTap = true; reason = 'room-audio-recheck-failed'; }
  }
  // An ordinary real click/remote-key can unlock autoplay; Sync me must not be required.
  function recoverOnGesture(event) {
    // TV remotes sometimes emit click without pointerdown. Any genuine interaction
    // can attempt room unmute before the explicit button is shown; never synthesize
    // a gesture or retry endlessly after browser refusal.
    if (event.isTrusted === false || owned() || !scope || !ytPlayer || !ytPlayerReady || playerInitializing || primingPlayer || probe || event.repeat
        || event.target?.closest?.('#' + ID)) return;
    const at=performance.now(); if(at-lastGestureAt<850)return;
    // Generic clicks/remote keys are audio gestures, not transport authority.
    // A paused/buffering decoder belongs to playback recovery or the explicit button.
    if ((!needsTap && !autoplayWasBlocked) || ytPlayer.getPlayerState?.() !== 1) return;
    lastGestureAt=at;
    const audio = typeof authoritativeRoomAudio === 'function' ? authoritativeRoomAudio() : null;
    if (!audio || audio.muted || audio.volume <= 0 || state?.playback?.paused) return;
    userGesturePrimeUsed = true; autoplayWasBlocked = false; needsTap = false;
    try {
      if (applyRoomAudioState(ytPlayer, true) !== true) throw Error('room audio unavailable');
      probe = {at:performance.now(),kind:'tap',blockedAt:blockedEvents}; reason = 'room-audio-gesture-verifying';
      window.watchFusionRoomSyncLog?.note?.('room-audio-reapplied', {reason:'member-gesture'});
    } catch { probe = null; needsTap = true; reason = 'room-audio-gesture-failed'; }
  }
  window.addEventListener('pointerdown', recoverOnGesture, {capture:true,passive:true});
  window.addEventListener('keydown', recoverOnGesture, {capture:true});
  window.addEventListener('click', recoverOnGesture, {capture:true});
  window.addEventListener('touchstart', recoverOnGesture, {capture:true,passive:true});
  setInterval(() => { try { tick(); } catch { reason = 'room-audio-error'; } }, 400);
  window.WatchFusionRoomAudioUnlock = {version: 'adaptive-room-03b', autoplayBlocked:()=>{blockedEvents++;}, diagnostics: () => ({reason, tried, probing: !!probe, needsTap, blockedEvents, softDeferrals, motionVerified:movingSince!==null, browserGestureRequired: needsTap, recheckCooldownMs:Math.max(0,Math.round(nextRecheckAt-performance.now()))})};
})();
