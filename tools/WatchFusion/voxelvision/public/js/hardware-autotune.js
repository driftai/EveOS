import {
  DEPTH_FPS_STEPS,
  detectMachineProfile,
  describeMachineProfile,
  GRID_STEPS,
  gridForLiveDetail,
  LUMA_FALLBACK_LIMITS
} from './capability-profile.js';
import { AdaptiveQualityGovernor, QUALITY_TUNING_MODES } from './adaptive-quality-governor.js';
import { restoredProfileState } from './depth-profile-resume.js';

const PERFORMANCE_SAMPLE_MIN = 4;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function optionNumber(option) {
  const value = Number(option?.value);
  return Number.isFinite(value) ? value : null;
}

function waitForApp(timeoutMs = 5000) {
  if (window.app) return Promise.resolve(window.app);
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const timer = setInterval(() => {
      if (window.app) {
        clearInterval(timer);
        resolve(window.app);
      } else if (performance.now() - started >= timeoutMs) {
        clearInterval(timer);
        reject(new Error('VoxelVision app did not initialize in time.'));
      }
    }, 25);
  });
}

function waitForStartupIdle() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(resolve, { timeout: 200 });
    else requestAnimationFrame(() => requestAnimationFrame(resolve));
  });
}

async function installHardwareAutotune() {
  const app = await waitForApp();
  // WebGPU adapter probing is non-critical startup work. Avoid competing with
  // the initial WebGL context, first paint and control binding.
  await waitForStartupIdle();
  const profile = await detectMachineProfile();
  const gridSelect = document.getElementById('gridSelect');
  const gridLabel = document.getElementById('gridResLabel');
  const depthSelect = document.getElementById('liveDepthRate');
  const tuningSelect = document.getElementById('qualityTuningMode');
  const capabilityLine = document.getElementById('machineCapability');

  let preferredLiveGridCols = Math.min(Number(gridSelect?.value) || 128, profile.maxGridCols);
  let requestedDepthFps = Math.min(Number(depthSelect?.value) || 3, profile.maxDepthFps);
  const governor = new AdaptiveQualityGovernor({
    mode: tuningSelect?.value || QUALITY_TUNING_MODES.MANUAL,
    detailSteps: GRID_STEPS,
    fpsSteps: DEPTH_FPS_STEPS,
    maxDetail: profile.maxGridCols,
    maxFps: profile.maxDepthFps,
    requestedDetail: preferredLiveGridCols,
    requestedFps: requestedDepthFps
  });
  let lastMeasurement = null;
  let restoringCachedMedia = false;

  app.machineProfile = profile;
  app.maxLiveVoxels = profile.maxLiveVoxels;
  app.preferredLiveGridCols = preferredLiveGridCols;
  app.qualityGovernor = governor;
  app.depthPlayback?.setSystemMemory(profile.systemMemoryGb);

  function describeTuning(state = governor.snapshot()) {
    if (state.mode === QUALITY_TUNING_MODES.MANUAL) {
      return `manual lock ${state.activeDetail} detail / ${state.activeFps} FPS`;
    }
    const mode = state.mode === QUALITY_TUNING_MODES.DETAIL ? 'detail priority' : 'motion priority';
    const requested = `${state.requestedDetail} detail / ${state.requestedFps} FPS requested`;
    const active = `${state.activeDetail} detail / ${state.activeFps} FPS active`;
    return `${mode} · ${active} · ${requested}`;
  }

  function renderCapabilityStatus(extra = '') {
    if (!capabilityLine) return;
    const isLuma = (app.liveDepth?.getEffectiveBackend?.() || app.liveDepth?.backend) === 'luma';
    const machine = isLuma
      ? `Luma fallback · ${LUMA_FALLBACK_LIMITS.maxGridCols} detail / ${LUMA_FALLBACK_LIMITS.maxDepthFps} FPS quality sweet spot (not a cap)`
      : describeMachineProfile(profile);
    const tuning = describeTuning();
    capabilityLine.textContent = [machine, tuning, extra].filter(Boolean).join(' · ');
    capabilityLine.dataset.state = isLuma || !profile.webgpu ? 'working' : 'ready';
  }

  function updateControlAvailability() {
    if (gridSelect) {
      for (const option of gridSelect.options) {
        const detail = optionNumber(option);
        if (!detail) continue;
        const available = detail <= profile.maxGridCols;
        option.disabled = !available;
        option.hidden = !available;
        option.title = available
          ? 'Available as a manual lock or an adaptive starting point.'
          : `Outside this machine's ${profile.label} profile (maximum ${profile.maxGridCols} detail).`;
      }
    }
    if (depthSelect) {
      for (const option of depthSelect.options) {
        const fps = optionNumber(option);
        if (!fps) continue;
        const available = fps <= profile.maxDepthFps;
        option.disabled = !available;
        option.hidden = !available;
        option.title = available
          ? 'Available as a manual lock or an adaptive target.'
          : `Outside this machine's ${profile.label} profile (maximum ${profile.maxDepthFps} FPS).`;
      }
    }
  }

  app.gridForLiveVideo = requestedDetail => gridForLiveDetail(
    requestedDetail,
    app.video.videoWidth,
    app.video.videoHeight,
    profile.maxGridCols,
    profile.maxLiveVoxels
  );

  const originalSetGridResolution = app.setGridResolution.bind(app);

  function primeFromLast(state) {
    const backend = app.liveDepth.getEffectiveBackend?.() || app.liveDepth.backend;
    if (!lastMeasurement || lastMeasurement.backend !== backend
      || lastMeasurement.sourceGeneration !== app.sourceGeneration) return state;
    return governor.prime(lastMeasurement.durationMs, lastMeasurement.detail);
  }

  function applyGovernorState(state = governor.snapshot(), { forceDetail = false } = {}) {
    const previousDetail = app.activeGridDetail;
    const previousFps = app.liveDepth.targetFps;
    app.liveDepth.targetFps = clamp(state.activeFps, 1, profile.maxDepthFps);
    if (app.depthMode === 'live' && (forceDetail || app.activeGridDetail !== state.activeDetail)) {
      originalSetGridResolution(state.activeDetail, { activeOnly: true, preserveSurface: true });
    }
    if (gridSelect) gridSelect.value = String(state.requestedDetail);
    if (depthSelect) depthSelect.value = String(state.requestedFps);
    if (gridLabel && app.depthMode !== 'live') {
      gridLabel.textContent = state.requestedDetail > 128
        ? `${app.activeCols} × ${app.activeRows} · next live ${state.requestedDetail}`
        : `${app.activeCols} × ${app.activeRows}`;
    }
    renderCapabilityStatus();
    if (app.depthMode === 'live' && (previousDetail !== app.activeGridDetail || previousFps !== app.liveDepth.targetFps)) {
      app.depthPlayback?.scheduleRestart();
    }
  }

  app.setGridResolution = (cols, options = {}) => {
    if (options.activeOnly) return originalSetGridResolution(cols, options);
    const requested = Math.min(Number(cols) || 128, profile.maxGridCols);
    preferredLiveGridCols = requested;
    app.preferredLiveGridCols = requested;
    const state = primeFromLast(governor.setRequestedDetail(requested));

    if (app.depthMode === 'live') {
      const result = originalSetGridResolution(state.activeDetail, { preserveSurface: true });
      app.currentGridCols = state.requestedDetail;
      applyGovernorState(state);
      return result;
    }

    const result = originalSetGridResolution(Math.min(requested, 128));
    app.currentGridCols = requested;
    applyGovernorState(state);
    return result;
  };

  app.liveDepth.setTargetFps = value => {
    requestedDepthFps = clamp(Number(value) || 1, 1, profile.maxDepthFps);
    const state = primeFromLast(governor.setRequestedFps(requestedDepthFps));
    requestedDepthFps = state.requestedFps;
    applyGovernorState(state);
    return state.activeFps;
  };

  app.updateGridAvailability = updateControlAvailability;

  app.restoreCachedQualityProfile = async session => {
    const cached = restoredProfileState(session);
    await app.depthPlayback.setConversionMode(cached.conversionMode, { load: false, reconfigure: false });
    if (cached.conversionMode !== 'luma') {
      await app.liveDepth.setModelProfile(cached.model, { load: false });
    }
    app.liveDepth.setInvert(cached.invert);
    const modelSelect = document.getElementById('depthModelSelect');
    const conversionSelect = document.getElementById('depthFusionMode');
    const invertCheck = document.getElementById('invertDepthCheck');
    if (modelSelect && [...modelSelect.options].some(option => option.value === cached.model)) modelSelect.value = cached.model;
    if (conversionSelect) conversionSelect.value = cached.conversionMode;
    if (invertCheck) invertCheck.checked = cached.invert;
    if (tuningSelect) tuningSelect.value = cached.mode;
    const state = governor.restoreProfile(cached);
    preferredLiveGridCols = state.requestedDetail;
    requestedDepthFps = state.requestedFps;
    app.currentGridCols = state.requestedDetail;
    app.preferredLiveGridCols = state.requestedDetail;
    applyGovernorState(state, { forceDetail: true });
    restoringCachedMedia = true;
    return state;
  };

  tuningSelect?.addEventListener('change', () => {
    const state = primeFromLast(governor.setMode(tuningSelect.value, { restoreRequested: true }));
    applyGovernorState(state, { forceDetail: app.depthMode === 'live' });
  });

  const originalLoadLiveMedia = app.loadLiveMedia.bind(app);
  app.loadLiveMedia = async (...args) => {
    restoringCachedMedia = false;
    lastMeasurement = null;
    const state = governor.reset({ restoreRequested: true });
    app.currentGridCols = state.requestedDetail;
    app.preferredLiveGridCols = state.requestedDetail;
    applyGovernorState(state);
    try {
      const result = await originalLoadLiveMedia(...args);
      applyGovernorState(governor.snapshot(), { forceDetail: true });
      return result;
    } finally {
      restoringCachedMedia = false;
    }
  };

  const originalRestoreDefaultMedia = app.restoreDefaultMedia.bind(app);
  app.restoreDefaultMedia = async (...args) => {
    lastMeasurement = null;
    const result = await originalRestoreDefaultMedia(...args);
    applyGovernorState(governor.reset({ restoreRequested: true }));
    updateControlAvailability();
    return result;
  };

  // Keep the latest accepted cost even while paused/manual so switching to an
  // Auto mode can react immediately. Adaptive changes still apply only during
  // playback, in the next task after app.js consumes the completed frame.
  const originalMaybeUpdate = app.liveDepth.maybeUpdate.bind(app.liveDepth);
  app.liveDepth.maybeUpdate = (...args) => {
    const effectiveBackend = () => app.liveDepth.getEffectiveBackend?.() || app.liveDepth.backend;
    const readyBefore = Boolean(app.liveDepth.pipeline) || effectiveBackend() === 'luma';
    const backendBefore = effectiveBackend();
    const started = performance.now();
    const result = originalMaybeUpdate(...args);
    if (!result || typeof result.then !== 'function') return result;

    return result.then(frame => {
      if (readyBefore && frame && backendBefore === effectiveBackend()) {
        const elapsed = performance.now() - started;
        lastMeasurement = {
          durationMs: elapsed,
          detail: app.activeGridDetail,
          backend: effectiveBackend(),
          sourceGeneration: app.sourceGeneration
        };
        if (app.video.paused || !app.isPlaying) return frame;
        const state = governor.record(elapsed);
        if (state.sampleCount >= PERFORMANCE_SAMPLE_MIN || state.changed) {
          if (state.changed) {
            window.setTimeout(() => applyGovernorState(state), 0);
          }
          const measured = Number.isFinite(state.emaMs)
            ? `measured ${Math.round(state.emaMs)} ms/frame${Number.isFinite(state.p90Ms) ? ` (p90 ${Math.round(state.p90Ms)} ms)` : ''}`
            : '';
          renderCapabilityStatus(measured);
        }
      }
      return frame;
    });
  };

  const originalOnStatus = app.liveDepth.onStatus?.bind(app.liveDepth);
  app.liveDepth.onStatus = state => {
    if (typeof originalOnStatus === 'function') originalOnStatus(state);
    if (state?.phase === 'fallback' || state?.phase === 'local'
      || (state?.phase === 'ready' && !restoringCachedMedia)) {
      restoringCachedMedia = false;
      lastMeasurement = null;
      const reset = governor.reset({ restoreRequested: true });
      window.setTimeout(() => applyGovernorState(reset, { forceDetail: app.depthMode === 'live' }), 0);
      updateControlAvailability();
    }
  };

  updateControlAvailability();
  applyGovernorState(governor.snapshot());
  console.info('VoxelVision hardware profile:', profile);
}

window.addEventListener('DOMContentLoaded', () => {
  installHardwareAutotune().catch(error => {
    console.warn('VoxelVision hardware tuning controls unavailable:', error);
    const line = document.getElementById('machineCapability');
    if (line) {
      line.textContent = 'Hardware tuning controls unavailable — manual controls remain active.';
      line.dataset.state = 'working';
    }
  });
});
