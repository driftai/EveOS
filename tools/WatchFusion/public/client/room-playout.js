// Playback timing is exchanged during ordinary room playback. Microphone input is never used here.
(() => {
  let lease = null, phaseSentAt = -Infinity, latestRoom, nextIdlePoll = 0;
  const health = $('roomPlayoutStatus');
  const roomKey = () => roomId && session && state?.presentationEpoch != null && state.playoutSegment != null
    ? [roomId, session.memberId, state.presentationEpoch, state.playoutSegment].join(':') : null;
  const supportedPlayback = () => !!(state?.source?.videoId || state?.source?.kind === 'media' && state.source.url);
  const playing = () => state?.playback && !state.playback.paused && !state.playback.ended;

  function render() {
    if (!health) return;
    const available = roomKey() && supportedPlayback();
    health.hidden = !available;
    if (!available) return;
    const current = target();
    const label = !playing() ? 'Auto sync ready' : current?.authorityBuffering ? 'Auto sync · source buffering'
      : (!current || current.reference === 'room-clock') ? 'Auto sync · room clock' : 'Auto sync active';
    if (health.textContent !== label) health.textContent = label;
  }

  function noteCoordination(value, key, sampledAt) {
    if (key !== roomKey() || !value || value.segment !== state.playoutSegment || sampledAt < phaseSentAt) return;
    phaseSentAt = sampledAt;
    lease = {key, value, at:performance.now()};
    render();
  }

  function target() {
    if (!playing() || document.hidden || !lease || lease.key !== roomKey() || performance.now() - lease.at > 3500) return null;
    return lease.value;
  }

  function adjustedPosition(position, mode) {
    const current = target();
    if (!current) return position;
    // A phase report is in units of media time. Holdback is measured in wall time.
    const phase = current.phaseMs / 1000;
    const holdback = mode === 'direct' ? current.holdbackMs / 1000 * state.playback.rate : 0;
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
    if (!key || !diagnostics?.exchange || !supportedPlayback() || document.hidden) { render(); return; }
    if (!playing() && !diagnostics.open() && performance.now() < nextIdlePoll) return;
    if (playing() || diagnostics.open()) nextIdlePoll = 0;
    else nextIdlePoll = performance.now() + 4000;
    try { await diagnostics.exchange(noteCoordination, key); } finally { render(); }
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) lease = null; else void tick().catch(() => {}); });
  window.watchFusionPlayout = {
    render,
    position:adjustedPosition,
    precision:availablePrecision,
    bufferedThreshold, bufferedUntil,
    status:target,
    sourceBuffering: () => target()?.authorityBuffering === true
  };
  setInterval(() => void tick().catch(() => {}), 700);
})();
