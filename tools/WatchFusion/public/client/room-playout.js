// Playback timing is exchanged during ordinary room playback. Microphone input is never used here.
(() => {
  let lease = null, phaseSentAt = -Infinity, latestRoom, nextIdlePoll = 0, lastTransportKey = null, lifecycleKick = null;
  const health = $('roomPlayoutStatus');
  const roomKey = () => roomId && session && state?.presentationEpoch != null && state.playoutSegment != null
    ? [roomId, session.memberId, state.presentationEpoch, state.playoutSegment].join(':') : null;
  const supportedPlayback = () => !!(state?.source?.videoId || state?.source?.kind === 'media' && state.source.url);
  const playing = () => state?.playback && !state.playback.paused && !state.playback.ended;
  const backgroundHost = () => document.hidden && !!state?.source?.videoId && state.linkedSourceActive === true && isHost() && playing();

  function render() {
    if (!health) return;
    const available = roomKey() && supportedPlayback();
    const solo = window.WatchFusionSoloDiagnostics?.active?.() === true;
    health.hidden = !available && !solo;
    window.watchFusionSyncCenter?.setVisible(available || solo);
    try { window.WatchFusionSoloDiagnostics?.render?.(); } catch {}
    if (!available) {if(lifecycleKick!==null)clearTimeout(lifecycleKick);lifecycleKick=null;lastTransportKey=null;return;}
    const lifecycle = roomKey() + ':' + (playing()?'play':'pause');
    if (lifecycle !== lastTransportKey) {
      const acquire = lastTransportKey===null || lastTransportKey.endsWith(':pause');
      lastTransportKey = lifecycle;
      if(lifecycleKick!==null)clearTimeout(lifecycleKick);
      lifecycleKick=null;
      // Initial play/resume only: a live seek must retain the ordinary exchange cadence.
      if(acquire&&playing())lifecycleKick=setTimeout(()=>{lifecycleKick=null;if(roomKey()&&roomKey()+':'+(playing()?'play':'pause')===lifecycle)void tick().catch(()=>{});},0);
      window.watchFusionRoomSyncLog?.note?.('room-transition',{
        playing:playing(),segment:state.playoutSegment,positionMs:Math.round((state.playback?.position||0)*1000)});
    }
    const current = target();
    const label = !playing() ? 'Auto sync ready' : current?.authorityBuffering ? 'Auto sync · source buffering'
      : (!current || current.reference === 'room-clock') ? 'Auto sync · room clock'
      : current.reference === 'peer-cohort' ? 'Auto sync · shared timing' : 'Auto sync active';
    if (health.textContent !== label) health.textContent = label;
  }

  function noteCoordination(value, key, sampledAt) {
    if (key !== roomKey() || !value || value.segment !== state.playoutSegment || sampledAt < phaseSentAt) return;
    phaseSentAt = sampledAt;
    lease = {key, value, at:performance.now()};
    render();
  }

  function target() {
    if (!playing() || !lease || lease.key !== roomKey() || performance.now() - lease.at > 3500) return null;
    if (document.hidden && (!backgroundHost() || !hasSourceReference(lease.value,estimatedServerNow()))) return null;
    return lease.value;
  }

  function hasSourceReference(c, now) {
    return !!c && c.segment === state?.playoutSegment && c.reference === 'linked-tab' &&
      c.source === 'live' && !c.authorityBuffering && Number.isFinite(c.sourceReferenceAt) &&
      now >= c.sourceReferenceAt && now - c.sourceReferenceAt <= 1500 &&
      Number.isFinite(c.uncertaintyMs) && c.uncertaintyMs >= 0 && c.uncertaintyMs <= 75 &&
      Number.isFinite(c.phaseMs) && Number.isFinite(c.anchorPositionMs) && Number.isFinite(c.anchorAt) && c.rate > 0;
  }

  // Project the independently timed source to the instant of the player's
  // reading. The follower's chosen target and its manual delay are irrelevant.
  function sourceErrorMs(peer, c, now) {
    if (!hasSourceReference(c, now) || c.mirrorContradicted || peer.playoutSegment !== c.segment ||
        !peer.playing || !peer.ready || peer.buffering || peer.correcting ||
        !Number.isFinite(peer.positionMs) || !Number.isFinite(peer.sampledAt) ||
        now < peer.sampledAt || now - peer.sampledAt > 1500 ||
        !['decoder-confirmed','fine-locked','direct-ready'].includes(peer.startupPhase)) return null;
    const sourcePosition = c.anchorPositionMs + (peer.sampledAt - c.anchorAt) * c.rate + c.phaseMs;
    return Math.round(peer.positionMs - sourcePosition);
  }

  // The coordinator's anchor and phase always travel together. Using them as one
  // absolute timeline keeps the target continuous when the room anchor is
  // republished before the next coordination lease arrives (v13).
  function sameAnchor(current) {
    const p = state?.playback;
    return p && Number.isFinite(current.anchorPositionMs) && Number.isFinite(current.anchorAt) && current.rate > 0 &&
      Math.abs(current.rate - (Number(p.rate) || 1)) < .001;
  }
  function adjustedPosition(position, mode) {
    const current = target();
    if (!current) return position;
    // A phase report is in units of media time. Holdback is measured in wall time.
    const phase = current.phaseMs / 1000;
    const holdback = mode === 'direct' ? current.holdbackMs / 1000 * state.playback.rate : 0;
    if (sameAnchor(current)) {
      const now = typeof estimatedServerNow === 'function' ? estimatedServerNow() : Date.now();
      const absolute = (current.anchorPositionMs + (now - current.anchorAt) * current.rate) / 1000 + phase;
      // Only bridge a republished anchor; a real transport change starts a new segment.
      if (Math.abs(absolute - (position + phase)) < .6) return Math.max(0, absolute - holdback);
    }
    return Math.max(0, position + phase - holdback);
  }

  function availablePrecision(mode) {
    const current = target();
    if (!current || current.uncertaintyMs == null) return null;
    const precision = current.uncertaintyMs / 1000 * 2;
    return mode === 'direct' ? Math.max(.025, precision) : Math.max(.10, precision);
  }

  function bufferedUntil(media, position) {
    const ranges = media.buffered;
    for (let i = 0; i < (ranges?.length || 0); i++) {
      if (ranges.start(i) <= position + .04 && ranges.end(i) >= position) return ranges.end(i) * 1000;
    }
    return null;
  }

  function bufferedThreshold() {
    const precision = availablePrecision('youtube');
    return precision ?? .18;
  }

  async function tick() {
    const key = roomKey();
    if (key !== latestRoom) { latestRoom = key; lease = null; phaseSentAt = -Infinity; }
    const diagnostics = window.watchFusionPresentation;
    if (!key || !diagnostics?.exchange || !supportedPlayback() || (document.hidden && !backgroundHost())) { render(); return; }
    if (!playing() && !diagnostics.open() && performance.now() < nextIdlePoll) return;
    if (playing() || diagnostics.open()) nextIdlePoll = 0;
    else nextIdlePoll = performance.now() + 4000;
    try { await diagnostics.exchange(noteCoordination, key); } finally { render(); }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden && !backgroundHost()) lease = null; else void tick().catch(() => {}); });
  window.watchFusionPlayout = {
    render,
    position:adjustedPosition,
    precision:availablePrecision,
    bufferedThreshold, bufferedUntil,
    status:target,
    hasSourceReference, sourceErrorMs,
    sourceBuffering: () => target()?.authorityBuffering === true
  };
  setInterval(() => void tick().catch(() => {}), 700);
})();
