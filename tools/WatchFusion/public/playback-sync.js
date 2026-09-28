/*
 * Conservative YouTube viewer synchronization.
 *
 * Mobile YouTube currentTime samples can be coarse/stale for a few ticks. A single
 * sample must never make a viewer run at 1.25x/0.75x. We keep the authoritative
 * playback rate, filter drift over a short window, and use one seek only when a
 * sustained offset is large enough to trust.
 */
(() => {
  const SYNC_TOLERANCE_SEC = 0.15;
  const SEEK_DRIFT_SEC = 0.65;
  const HARD_DRIFT_SEC = 1.5;
  const SEEK_COOLDOWN_MS = 2500;
  const TICK_MS = 250;
  const SENSOR_WINDOW = 7;
  const SENSOR_MIN_SAMPLES = 5;
  const SENSOR_MIN_AGE_MS = 900;
  const SENSOR_MAX_SPREAD_SEC = 0.22;

  let anchorKey = '';
  let anchorPosition = 0;
  let anchorServerTime = 0;
  let seekCooldownUntil = 0;
  let viewerSawEnded = false;
  let replayKey = '';
  let driftSamples = [];
  let diagnostics = {
    rawDriftSec: 0,
    filteredDriftSec: 0,
    spreadSec: 0,
    sampleCount: 0,
    stable: false,
    action: 'idle'
  };

  function median(values) {
    if (!values.length) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function resetDriftSensor(action = 'reset') {
    driftSamples = [];
    diagnostics = {
      rawDriftSec: 0,
      filteredDriftSec: 0,
      spreadSec: 0,
      sampleCount: 0,
      stable: false,
      action
    };
  }

  function syncStateKey() {
    const p = state?.playback;
    return p ? [state?.revision, p.updatedAt, p.projectedAt, p.position, p.rate, p.paused, p.ended].join('|') : '';
  }

  function refreshAnchor(force = false) {
    if (!state?.playback) return;
    const key = syncStateKey();
    if (!force && key && key === anchorKey) return;
    if (key !== anchorKey) resetDriftSensor('new-anchor');
    anchorKey = key;
    anchorPosition = Number(state.playback.position) || 0;
    anchorServerTime = Number(state.playback.projectedAt) || Number(state.serverTime) || Date.now();
  }

  function serverNow() {
    return typeof estimatedServerNow === 'function' ? estimatedServerNow() : Date.now();
  }

  function predictedPosition() {
    const p = state?.playback;
    if (!p) return 0;
    if (p.paused || p.ended) return Number(p.position) || 0;
    refreshAnchor(false);
    return Math.max(
      0,
      anchorPosition
        + Math.max(0, (serverNow() - anchorServerTime) / 1000) * (Number(p.rate) || 1)
    );
  }

  function sampleDrift(rawDrift, nowMs) {
    driftSamples.push({ drift: rawDrift, at: nowMs });
    if (driftSamples.length > SENSOR_WINDOW) driftSamples.shift();

    const values = driftSamples.map(sample => sample.drift);
    const filtered = median(values);
    const spread = values.length ? Math.max(...values) - Math.min(...values) : 0;
    const age = driftSamples.length > 1 ? driftSamples.at(-1).at - driftSamples[0].at : 0;
    const sameDirection = values.every(value => Math.abs(value) <= SYNC_TOLERANCE_SEC || Math.sign(value) === Math.sign(filtered));
    const stable = values.length >= SENSOR_MIN_SAMPLES
      && age >= SENSOR_MIN_AGE_MS
      && spread <= SENSOR_MAX_SPREAD_SEC
      && sameDirection;

    diagnostics = {
      rawDriftSec: rawDrift,
      filteredDriftSec: filtered,
      spreadSec: spread,
      sampleCount: values.length,
      stable,
      action: diagnostics.action
    };
    return diagnostics;
  }

  function connectedStatus() {
    return isTryCloudflare ? 'Connected (remote sync)' : 'Connected';
  }

  function markStable() {
    if (($('syncStatus')?.textContent || '') !== connectedStatus()) setStatus(connectedStatus());
    diagnostics.action = 'steady';
  }

  function playbackSnapshotKey() {
    const p = state?.playback;
    return p ? [state?.revision, p.updatedAt, p.position, p.paused, p.ended].join('|') : '';
  }

  function restartViewerFromEnded(target, baseRate) {
    const key = playbackSnapshotKey();
    if (!key || key === replayKey) return false;
    replayKey = key;
    viewerSawEnded = false;
    try {
      const startSeconds = Math.max(0, Number(target) || 0);
      if (typeof ytPlayer.loadVideoById === 'function') {
        ytPlayer.loadVideoById({ videoId: state.source.videoId, startSeconds });
      } else {
        ytPlayer.seekTo?.(startSeconds, true);
      }
      ytPlayer.setPlaybackRate?.(baseRate);
      requestViewerPlayback();
      resetDriftSensor('replay');
      return true;
    } catch {
      return false;
    }
  }

  function seekViewer(target, baseRate, nowMs, action = 'seek') {
    try {
      ytPlayer.setPlaybackRate?.(baseRate);
      ytPlayer.seekTo?.(target, true);
    } catch {}
    anchorPosition = target;
    anchorServerTime = serverNow();
    seekCooldownUntil = nowMs + SEEK_COOLDOWN_MS;
    resetDriftSensor(action);
    setStatus('Re-synced');
  }

  function applyViewerCorrection(force = false) {
    if (!roomId || !state?.source?.videoId || !ytPlayer || !ytPlayerReady || isHost()) return;

    applyRoomAudioState();
    refreshAnchor(false);

    const baseRate = Math.min(2, Math.max(0.25, Number(state.playback.rate) || 1));
    const current = Number(ytPlayer.getCurrentTime?.()) || 0;
    const target = predictedPosition();
    const rawDrift = target - current;
    const absRaw = Math.abs(rawDrift);
    const nowMs = performance.now();

    // Always return the viewer to the host's actual playback rate. Sync logic is
    // not allowed to make a phone run faster/slower just to chase noisy samples.
    try {
      if (Math.abs((Number(ytPlayer.getPlaybackRate?.()) || baseRate) - baseRate) > 0.001) {
        ytPlayer.setPlaybackRate?.(baseRate);
      }
    } catch {}

    if (state.playback.ended) {
      viewerSawEnded = true;
      try {
        if (absRaw > SYNC_TOLERANCE_SEC) ytPlayer.seekTo?.(target, true);
        ytPlayer.pauseVideo?.();
      } catch {}
      resetDriftSensor('ended');
      markStable();
      return true;
    }

    if (state.playback.paused) {
      viewerSawEnded = false;
      try {
        if (absRaw > SYNC_TOLERANCE_SEC) ytPlayer.seekTo?.(target, true);
        ytPlayer.pauseVideo?.();
      } catch {}
      resetDriftSensor('paused');
      markStable();
      return true;
    }

    if (viewerSawEnded && target <= 1.5 && restartViewerFromEnded(target, baseRate)) return true;
    viewerSawEnded = false;

    if (force) {
      seekViewer(target, baseRate, nowMs, 'manual-sync');
      requestViewerPlayback();
      return true;
    }

    const sensor = sampleDrift(rawDrift, nowMs);
    const filteredAbs = Math.abs(sensor.filteredDriftSec);

    // A very large offset is safe to repair after a couple of consistent reads.
    const hardConsistent = sensor.sampleCount >= 2
      && driftSamples.slice(-2).every(sample => Math.sign(sample.drift) === Math.sign(sensor.filteredDriftSec));
    if (filteredAbs >= HARD_DRIFT_SEC && hardConsistent && nowMs >= seekCooldownUntil) {
      seekViewer(target, baseRate, nowMs, 'hard-seek');
    } else if (sensor.stable && filteredAbs >= SEEK_DRIFT_SEC && nowMs >= seekCooldownUntil) {
      seekViewer(target, baseRate, nowMs, 'stable-seek');
    } else {
      // Below the trusted seek threshold, do nothing. In particular, a reported
      // 0.2-0.5s mobile currentTime offset is treated as sensor jitter unless it
      // persists strongly enough to justify a seek.
      markStable();
    }

    requestViewerPlayback();
    return true;
  }

  window.applyAdaptiveViewerSync = applyViewerCorrection;
  window.watchFusionSyncDiagnostics = () => ({
    ...diagnostics,
    clockOffsetMs: window.watchPartyClock?.offsetMs?.() ?? null,
    clockRttMs: window.watchPartyClock?.rttMs?.() ?? null,
    playerRate: Number(ytPlayer?.getPlaybackRate?.()) || null,
    authoritativeRate: Number(state?.playback?.rate) || null
  });

  const originalRender = render;
  render = function watchPartyAdaptiveRender() {
    refreshAnchor(true);
    return originalRender();
  };

  const syncButton = $('syncBtn');
  if (syncButton) syncButton.onclick = () => syncPlayer({ force: true });

  setInterval(() => {
    try {
      if (!roomId || !state?.source?.videoId || !ytPlayer || !ytPlayerReady || isHost()) return;
      applyViewerCorrection(false);
    } catch {}
  }, TICK_MS);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      refreshAnchor(true);
      if (roomId && !isHost()) applyViewerCorrection(false);
    }
  });
})();
