/**
 * VoxelVision Main Application Orchestrator
 * Coordinates cached and live AI depth, video decoding, color extraction,
 * audio reactivity, YouTube/local ingestion, UI controls and recording.
 */

import { DepthData } from './depth-engine.js';
import { AudioReactiveEngine } from './audio-reactive.js';
import { gridForLiveDetail } from './capability-profile.js';
import { DEFAULT_DEPTH_MODEL, depthFrameToRgba, LiveDepthEngine } from './live-depth.js';
import { blendDepthFrames, resampleFloatBilinear } from './depth-processing.js';
import { DepthPlaybackCoordinator } from './depth-playback-coordinator.js';
import { resolveDepthDiagnosticView } from './depth-diagnostic-view.js';
import { VoxelScene } from './voxel-scene.js';
import { youtubeSourceIdentity } from './youtube-source.js';
import { MediaPlaybackHealth } from './media-playback-health.js';
import { voxelVisionApiUrl, voxelVisionAssetUrl } from './runtime-paths.js';

const MAX_LIVE_VOXELS = 65536;
const DEFAULT_DEMO = Object.freeze({
  depthUrl: voxelVisionAssetUrl('/media/voxelvision-demo.depth.json'),
  videoUrl: voxelVisionAssetUrl('/media/voxelvision-demo.mp4'),
  title: 'VoxelVision Procedural Demo'
});

class VoxelVisionApp {
  constructor() {
    this.canvas = document.getElementById('renderCanvas');
    this.video = document.getElementById('videoPlayer');
    this.sampleCanvas = document.createElement('canvas');
    this.sampleCtx = this.sampleCanvas.getContext('2d', { willReadFrequently: true });

    this.scene = new VoxelScene(this.canvas);
    this.computePressureReasons = new Set(['startup']);
    this.computeRestoreTask = null;
    this.audio = new AudioReactiveEngine();
    const selectedDepthModel = document.getElementById('depthModelSelect')?.value || DEFAULT_DEPTH_MODEL;
    this.liveDepth = new LiveDepthEngine({
      targetFps: 3,
      modelProfile: selectedDepthModel,
      onStatus: state => this.handleLiveDepthStatus(state),
      onForegroundStatus: message => this.handleForegroundAssistStatus(message)
    });
    this.depthPlayback = new DepthPlaybackCoordinator(this);

    this.depthData = null;
    this.depthMode = 'cached';
    this.activeCols = 128;
    this.activeRows = 96;
    this.isPlaying = false;
    this.isSeeking = false;
    this.lastTime = performance.now();
    this.currentGridCols = 128;
    this.activeGridDetail = 128;
    this.brightness = 1.0;
    this.contrast = 1.0;
    this.recorder = null;
    this.recordedChunks = [];
    this.isRecording = false;
    this.currentObjectUrl = null;
    this.sourceBlob = null;
    this.sourceGeneration = 0;
    this.liveDepthFrameA = null;
    this.liveDepthFrameB = null;
    this.liveDepthBlendStartedAt = 0;
    this.liveDepthBlendDuration = 333;
    this.lastSourceMediaInfo = null;
    this.videoFrameVersion = 1;
    this.lastColorFrameVersion = -1;
    this.lastDepthFrameVersion = -1;
    this.lastDepthCompletedAt = 0;
    this.latestVideoPixels = null;
    this.loopStarted = false;
    this.videoFrameCallbackSupported = typeof this.video.requestVideoFrameCallback === 'function';
    this.videoFrameStats = {
      presentedFrames: 0,
      missedCallbacks: 0,
      decodeMs: null
    };
    this.videoFrameMetadata = {
      mediaTime: 0,
      expectedDisplayTime: 0,
      presentedFrames: 0
    };
    this.depthDiagnosticStage = 'off';
    this.depthDiagnosticPanel = document.getElementById('depthDiagnosticPanel');
    this.depthDiagnosticCanvas = document.getElementById('depthDiagnosticCanvas');
    this.depthDiagnosticCtx = this.depthDiagnosticCanvas?.getContext('2d');

    this.installVideoFrameTracking();
    this.bindUI();
    this.loadDefaultMedia();
  }

  installVideoFrameTracking() {
    const markFrameReady = () => {
      this.videoFrameVersion += 1;
    };

    let previousPresentedFrames = null;
    this.video.addEventListener('loadstart', () => {
      previousPresentedFrames = null;
      this.videoFrameStats.presentedFrames = 0;
      this.videoFrameStats.missedCallbacks = 0;
      this.videoFrameStats.decodeMs = null;
      this.videoFrameMetadata.mediaTime = 0;
      this.videoFrameMetadata.presentedFrames = 0;
      markFrameReady();
    });
    this.video.addEventListener('loadeddata', markFrameReady);
    this.video.addEventListener('seeked', markFrameReady);

    if (!this.videoFrameCallbackSupported) return;

    const onVideoFrame = (_now, metadata = {}) => {
      const presentedFrames = Number(metadata.presentedFrames) || 0;
      if (previousPresentedFrames != null && presentedFrames > previousPresentedFrames + 1) {
        this.videoFrameStats.missedCallbacks += presentedFrames - previousPresentedFrames - 1;
      }
      previousPresentedFrames = presentedFrames;
      this.videoFrameStats.presentedFrames = presentedFrames;
      this.videoFrameMetadata = {
        mediaTime: Number.isFinite(Number(metadata.mediaTime)) ? Number(metadata.mediaTime) : this.video.currentTime,
        expectedDisplayTime: Number(metadata.expectedDisplayTime) || 0,
        presentedFrames
      };

      const decodeMs = Number(metadata.processingDuration) * 1000;
      if (Number.isFinite(decodeMs) && decodeMs >= 0) {
        this.videoFrameStats.decodeMs = this.videoFrameStats.decodeMs == null
          ? decodeMs
          : this.videoFrameStats.decodeMs + (decodeMs - this.videoFrameStats.decodeMs) * 0.2;
      }

      markFrameReady();
      this.video.requestVideoFrameCallback(onVideoFrame);
    };

    this.video.requestVideoFrameCallback(onVideoFrame);
  }

  showStatus(message, { error = false, hideAfter = 0 } = {}) {
    const el = document.getElementById('statusMsg');
    el.textContent = message;
    el.classList.toggle('error', error);
    el.classList.remove('hidden');
    if (hideAfter > 0) {
      window.setTimeout(() => el.classList.add('hidden'), hideAfter);
    }
  }

  setDepthBadge(text, mode = 'cached') {
    const badge = document.getElementById('depthModeBadge');
    badge.textContent = text;
    badge.dataset.mode = mode;
  }

  updateDepthDiagnostic() {
    const panel = this.depthDiagnosticPanel;
    if (!panel) return;
    const stage = this.depthDiagnosticStage;
    const view = resolveDepthDiagnosticView({
      stage,
      depthMode: this.depthMode,
      playbackMode: this.depthPlayback?.mode,
      liveDiagnostics: this.liveDepth?.getDiagnostics?.(),
      playbackDiagnostic: this.depthPlayback?.getCachedDiagnostic?.()
    });
    panel.hidden = !view.visible;
    if (!view.visible) {
      panel.removeAttribute('aria-busy');
      return;
    }

    document.getElementById('depthDiagnosticTitle').textContent = view.label;
    if (!view.ready) {
      panel.setAttribute('aria-busy', 'true');
      this.depthDiagnosticCanvas.hidden = true;
      document.getElementById('depthDiagnosticGrid').textContent = 'Waiting';
      document.getElementById('depthDiagnosticMetrics').textContent = view.message;
      return;
    }

    panel.setAttribute('aria-busy', 'false');
    this.depthDiagnosticCanvas.hidden = false;
    const rgba = depthFrameToRgba(view.frame, { normalize: stage === 'raw' });
    this.depthDiagnosticCanvas.width = view.width;
    this.depthDiagnosticCanvas.height = view.height;
    this.depthDiagnosticCtx.putImageData(new ImageData(rgba, view.width, view.height), 0, 0);
    document.getElementById('depthDiagnosticGrid').textContent = `${view.width} × ${view.height}`;

    if (view.kind === 'playback') {
      const cached = view.snapshot;
      const blend = Math.round((Number(cached.blend) || 0) * 100);
      document.getElementById('depthDiagnosticMetrics').textContent = [
        `${Number(cached.mediaTime || 0).toFixed(3)}s media time`,
        `maps ${cached.firstIndex} → ${cached.secondIndex} (${blend}%)`,
        `${cached.origin || 'native'}${cached.provisional ? ' provisional' : ''}`,
        `${cached.nativeFrames || 0} native + ${cached.reusedFrames || 0} shared / ${cached.totalFrames || 0}`,
        cached.detailRecovery?.pixels ? `foreground recovery ${cached.detailRecovery.pixels} px` : null
      ].filter(Boolean).join(' · ');
      panel.hidden = false;
      return;
    }

    const metrics = view.snapshot.metrics || {};
    const bias = metrics.broadBias || {};
    const borderCount = metrics.borders?.repairedSegments || 0;
    const relief = metrics.relief || {};
    const parts = [
      `bias x/y ${Number(bias.xSpan || 0).toFixed(3)} / ${Number(bias.ySpan || 0).toFixed(3)}`,
      `correction ${Number(bias.xStrength || 0).toFixed(2)} / ${Number(bias.yStrength || 0).toFixed(2)}`,
      `edge repairs ${borderCount}`
    ];
    if (Number.isFinite(relief.inputSpan)) {
      parts.push(`relief ${relief.inputSpan.toFixed(3)} → ${relief.outputSpan.toFixed(3)}`);
    }
    if (metrics.foregroundDetail?.pixels) {
      parts.push(`foreground recovery ${metrics.foregroundDetail.pixels} px`);
    }
    const temporal = metrics.temporal || {};
    if (Number.isFinite(temporal.statistics?.strength)) {
      parts.push(`anchor ${(temporal.statistics.strength * 100).toFixed(0)}%`);
    }
    if (Number.isFinite(temporal.motion?.confidence) && temporal.motion.confidence > 0) {
      parts.push(`motion ${temporal.motion.x},${temporal.motion.y}`);
    }
    if (metrics.model?.name) {
      parts.unshift(`${metrics.model.name}${metrics.model.fallback ? ' fallback' : ''}`);
    }
    document.getElementById('depthDiagnosticMetrics').textContent = parts.join(' · ');
    panel.hidden = false;
  }

  sourceQualityLabel(width, height) {
    if (!width || !height) return null;
    const shortSide = Math.min(width, height);
    const tiers = [4320, 2160, 1440, 1080, 720, 480, 360];
    const tier = tiers.find(value => shortSide >= value);
    return tier ? `${tier}p` : `${shortSide}p`;
  }

  setMediaQualityBadge(mediaInfo = null) {
    const badge = document.getElementById('mediaQualityBadge');
    const width = Number(mediaInfo?.width) || this.video.videoWidth || 0;
    const height = Number(mediaInfo?.height) || this.video.videoHeight || 0;
    const label = mediaInfo?.qualityLabel || this.sourceQualityLabel(width, height);

    badge.textContent = label ? `${label} Source` : 'Source';
    badge.dataset.mode = this.depthMode === 'live' ? 'live' : 'cached';

    const details = [];
    if (width && height) details.push(`${width} × ${height}`);
    if (mediaInfo?.fps) details.push(`${mediaInfo.fps} FPS`);
    if (mediaInfo?.codec) details.push(String(mediaInfo.codec).toUpperCase());
    badge.title = details.length ? details.join(' · ') : 'Current source quality';
  }

  describeMediaInfo(mediaInfo = null) {
    if (!mediaInfo) return '';
    const parts = [];
    if (mediaInfo.qualityLabel) parts.push(mediaInfo.qualityLabel);
    else if (mediaInfo.width && mediaInfo.height) parts.push(`${mediaInfo.width}×${mediaInfo.height}`);
    if (mediaInfo.codec) parts.push(String(mediaInfo.codec).toUpperCase());
    if (mediaInfo.fps) parts.push(`${mediaInfo.fps} FPS`);
    return parts.join(' · ');
  }

  setComputePressure(reason, active) {
    if (!reason || !this.scene) return;
    if (this.computeRestoreTask) {
      const task = this.computeRestoreTask;
      if (task.idle && typeof cancelIdleCallback === 'function') cancelIdleCallback(task.id);
      else clearTimeout(task.id);
      this.computeRestoreTask = null;
    }
    if (active) this.computePressureReasons.add(reason);
    else this.computePressureReasons.delete(reason);
    if (this.computePressureReasons.size) {
      this.scene.setPerformanceMode('loading');
      return;
    }
    const restore = () => {
      this.computeRestoreTask = null;
      if (!this.computePressureReasons.size) this.scene.setPerformanceMode('normal');
    };
    this.computeRestoreTask = typeof requestIdleCallback === 'function'
      ? { idle: true, id: requestIdleCallback(restore, { timeout: 700 }) }
      : { idle: false, id: setTimeout(restore, 120) };
  }

  handleForegroundAssistStatus(message = '') {
    this.setComputePressure('foreground-model', String(message).startsWith('Loading'));
  }

  handleLiveDepthStatus(state) {
    if (!state) return;
    if (state.phase === 'module' || state.phase === 'model') {
      this.setComputePressure('depth-model', true);
    } else if (state.phase === 'ready' || state.phase === 'fallback' || state.phase === 'local') {
      this.setComputePressure('depth-model', false);
    }
    if (state.phase === 'local') {
      this.setDepthBadge('Live - Local Luminance', 'fallback');
      const modelCapability = document.getElementById('depthModelCapability');
      if (modelCapability) {
        modelCapability.textContent = 'Local luminance depth is selected; no AI model download or GPU inference is required.';
        modelCapability.dataset.state = 'working';
      }
      this.showStatus(state.message, { hideAfter: 2400 });
    } else if (state.phase === 'ready') {
      const effectiveBackend = this.liveDepth.getEffectiveBackend?.() || this.liveDepth.backend;
      const backend = effectiveBackend === 'webgpu' ? 'WebGPU' : 'WASM';
      const effectivePrecision = this.liveDepth.getEffectivePrecision?.() || this.liveDepth.precision;
      const precision = effectivePrecision ? ` ${effectivePrecision}` : '';
      const activeModel = this.liveDepth.getActiveModelProfile?.();
      const modelLabel = activeModel?.badge || 'AI Depth';
      const fallback = Boolean(this.liveDepth.modelFallbackReason);
      this.setDepthBadge(`Live · ${modelLabel} · ${backend}${precision}`, fallback ? 'fallback' : 'live');
      const modelCapability = document.getElementById('depthModelCapability');
      if (modelCapability) {
        modelCapability.textContent = fallback
          ? `${activeModel?.name || 'Compatible model'} active because the enhanced model could not initialize in this browser.`
          : `${activeModel?.name || 'Selected depth model'} active on ${backend}${precision}.`;
        modelCapability.dataset.state = fallback ? 'working' : 'ready';
      }
      this.showStatus(state.message, { hideAfter: 2400 });
    } else if (state.phase === 'fallback') {
      const cache = this.depthPlayback?.controller?.snapshot?.();
      const cachedReplayAvailable = this.depthPlayback?.mode === 'hybrid' && Number(cache?.cachedFrames) > 0;
      if (cachedReplayAvailable) {
        this.setDepthBadge('Cached Depth - AI Paused', 'fallback');
        const cachedCapability = document.getElementById('depthModelCapability');
        if (cachedCapability) {
          cachedCapability.textContent = 'Stored depth remains playable. AI analysis paused without changing the cache; Local Luminance is available as a separate path.';
          cachedCapability.dataset.state = 'working';
        }
        this.showStatus('Cached depth playback is preserved. AI analysis could not resume; choose Local Luminance to create a separate local conversion.', { hideAfter: 5000 });
        this.updateHeightScale();
        return;
      }
      this.setDepthBadge('Live · Luma Fallback', 'fallback');
      const modelCapability = document.getElementById('depthModelCapability');
      if (modelCapability) {
        modelCapability.textContent = 'Both AI model paths were unavailable; local luminance depth is active.';
        modelCapability.dataset.state = 'missing';
      }
      this.showStatus('AI Depth unavailable — using measured Luma fallback; 256 detail / 4 FPS is the recommended sweet spot, not a hard cap.', { error: true, hideAfter: 5000 });
    } else {
      this.showStatus(state.message);
    }
    this.updateHeightScale();
  }

  updateHeightScale() {
    const slider = document.getElementById('heightSlider');
    const label = document.getElementById('heightVal');
    const base = parseFloat(slider?.value || '16');
    const isLuma = this.depthMode === 'live' && this.liveDepth?.backend === 'luma';
    const effective = isLuma ? base * 0.72 : base;
    if (this.scene?.uniforms?.uHeightScale) {
      this.scene.uniforms.uHeightScale.value = effective;
    }
    if (label) {
      label.textContent = isLuma ? `${effective.toFixed(1)} (luma scaled)` : base.toFixed(1);
    }
  }

  updateGridAvailability() {
    const live = this.depthMode === 'live';
    document.querySelectorAll('#gridSelect option[data-live-only="true"]').forEach(option => {
      option.disabled = !live;
    });
  }

  async loadDefaultMedia() {
    const generation = ++this.sourceGeneration;
    try {
      this.showStatus('Loading the bundled procedural depth demo…');
      const depthData = await DepthData.load(DEFAULT_DEMO.depthUrl);
      if (generation !== this.sourceGeneration) return;
      this.depthData = depthData;
      this.depthMode = 'cached';
      this.updateDepthDiagnostic();
      this.lastSourceMediaInfo = null;
      this.setDepthBadge('Cached AI Depth', 'cached');
      this.updateGridAvailability();
      this.setGridResolution(this.currentGridCols);

      this.video.src = DEFAULT_DEMO.videoUrl;
      this.video.load();
      document.getElementById('clipTitle').textContent = DEFAULT_DEMO.title;

      this.showStatus('Ready. Click Play to start.', { hideAfter: 3000 });
      this.startLoop();
      this.setComputePressure('startup', false);
      this.refreshYoutubeCapability();
    } catch (err) {
      console.error('Failed to load default media:', err);
      this.showStatus(`Error: ${err.message}`, { error: true });
      this.setComputePressure('startup', false);
    }
  }

  gridForLiveVideo(requestedDetail) {
    return gridForLiveDetail(
      requestedDetail,
      this.video.videoWidth,
      this.video.videoHeight,
      Math.floor(Math.sqrt(MAX_LIVE_VOXELS)),
      MAX_LIVE_VOXELS
    );
  }

  currentLiveDepthFrame(timestamp = performance.now()) {
    if (!this.liveDepthFrameA || !this.liveDepthFrameB) return this.liveDepthFrameB || this.liveDepthFrameA;
    const elapsed = timestamp - this.liveDepthBlendStartedAt;
    const linear = Math.min(1, Math.max(0, elapsed / Math.max(1, this.liveDepthBlendDuration)));
    return blendDepthFrames(this.liveDepthFrameA, this.liveDepthFrameB, linear);
  }

  setGridResolution(cols, { activeOnly = false, preserveSurface = true } = {}) {
    let requestedCols = Math.max(16, parseInt(cols, 10) || 128);
    const gridSelect = document.getElementById('gridSelect');
    const oldCols = this.activeCols;
    const oldRows = this.activeRows;
    const oldSurface = this.depthMode === 'live' && preserveSurface
      ? this.currentLiveDepthFrame()
      : null;

    if (this.depthMode === 'cached' && this.depthData) {
      requestedCols = Math.min(requestedCols, this.depthData.baseCols || 128);
      this.currentGridCols = requestedCols;
      this.activeGridDetail = requestedCols;
      if (gridSelect) gridSelect.value = String(requestedCols);
      this.depthData.setGrid(requestedCols);
      this.activeCols = this.depthData.cols;
      this.activeRows = this.depthData.rows;
    } else {
      if (!activeOnly) this.currentGridCols = requestedCols;
      this.activeGridDetail = requestedCols;
      const grid = this.gridForLiveVideo(requestedCols);
      this.activeCols = grid.cols;
      this.activeRows = grid.rows;
    }

    this.sampleCanvas.width = this.activeCols;
    this.sampleCanvas.height = this.activeRows;
    this.latestVideoPixels = null;
    this.scene.setupVoxelMesh(this.activeCols, this.activeRows);
    const gridLabel = document.getElementById('gridResLabel');
    if (gridLabel) {
      gridLabel.textContent = activeOnly && this.activeGridDetail !== this.currentGridCols
        ? `${this.activeCols} × ${this.activeRows} · auto from ${this.currentGridCols}`
        : `${this.activeCols} × ${this.activeRows}`;
    }

    if (this.depthMode === 'live') {
      let surface = null;
      if (oldSurface && oldSurface.length === oldCols * oldRows && oldCols > 0 && oldRows > 0) {
        surface = oldCols === this.activeCols && oldRows === this.activeRows
          ? oldSurface
          : resampleFloatBilinear(oldSurface, oldCols, oldRows, this.activeCols, this.activeRows);
      }
      if (!surface) surface = new Float32Array(this.activeCols * this.activeRows).fill(72 / 255);
      this.liveDepthFrameA = surface;
      this.liveDepthFrameB = surface;
      this.liveDepthBlendStartedAt = performance.now();
      this.scene.updateDepthBuffers(surface, surface, 1);
      this.liveDepth.setInputDetail(this.activeGridDetail, { resetTemporal: false });
      this.lastColorFrameVersion = -1;
      this.lastDepthFrameVersion = -1;
      this.liveDepth.requestImmediate({ resetTemporal: true });
      this.depthPlayback.scheduleRestart();
    }
  }

  waitForVideoMetadata() {
    if (this.video.readyState >= HTMLMediaElement.HAVE_METADATA && this.video.videoWidth) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const onLoaded = () => {
        cleanup();
        resolve();
      };
      const onError = () => {
        cleanup();
        reject(new Error('The selected video could not be loaded by this browser.'));
      };
      const cleanup = () => {
        this.video.removeEventListener('loadedmetadata', onLoaded);
        this.video.removeEventListener('error', onError);
      };
      this.video.addEventListener('loadedmetadata', onLoaded, { once: true });
      this.video.addEventListener('error', onError, { once: true });
    });
  }

  async setLiveDepthModel(key) {
    const requested = key || DEFAULT_DEPTH_MODEL;
    const modelSelect = document.getElementById('depthModelSelect');
    if (modelSelect) modelSelect.value = requested;
    const shouldLoad = this.depthMode === 'live';
    const wasPlaying = shouldLoad && !this.video.paused;
    const preservedGrid = this.currentGridCols;
    if (wasPlaying) this.video.pause();
    if (shouldLoad) await this.depthPlayback.suspend();

    const capability = document.getElementById('depthModelCapability');
    if (capability) {
      capability.textContent = shouldLoad
        ? 'Switching model and validating a real inference frame…'
        : 'Model selected; it will load and validate when live video is imported.';
      capability.dataset.state = 'working';
    }
    if (shouldLoad) this.setDepthBadge('Live AI · Loading model', 'loading');

    try {
      await this.liveDepth.setModelProfile(requested, { load: shouldLoad });
      if (shouldLoad) {
        if (this.currentGridCols !== preservedGrid) this.setGridResolution(preservedGrid);
        const gridSelect = document.getElementById('gridSelect');
        if (gridSelect) gridSelect.value = String(preservedGrid);
        this.liveDepth.requestImmediate({ resetTemporal: true });
        this.lastDepthFrameVersion = -1;
      }
    } catch (error) {
      console.warn('Depth model switch failed:', error);
      this.showStatus(`Depth model switch failed: ${error.message}`, { error: true, hideAfter: 5000 });
    } finally {
      if (shouldLoad && this.depthPlayback.mode === 'hybrid') {
        try { await this.depthPlayback.configure(); } catch {}
      }
      if (wasPlaying) {
        try { await this.video.play(); } catch {}
      }
    }
  }

  async loadLiveMedia(src, title, {
    objectUrl = false,
    mediaInfo = null,
    sourceIdentity = null,
    sourceBlob = null,
    resumeSessionId = null
  } = {}) {
    const generation = ++this.sourceGeneration;
    this.setComputePressure('source-load', true);
    try {
    this.liveDepth.requestImmediate({ resetTemporal: true });
    this.video.pause();
    this.isPlaying = false;
    this.updatePlayButton();

    await this.depthPlayback.clearSource();
    if (generation !== this.sourceGeneration) return;

    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    if (objectUrl) this.currentObjectUrl = src;
    this.sourceBlob = sourceBlob || null;

    this.depthMode = 'live';
    this.depthData = null;
    this.updateDepthDiagnostic();
    this.lastSourceMediaInfo = mediaInfo;
    this.updateGridAvailability();
    this.setDepthBadge('Live AI · Loading', 'loading');
    document.getElementById('clipTitle').textContent = title;

    this.video.src = src;
    this.video.load();
    await this.waitForVideoMetadata();
    if (generation !== this.sourceGeneration) return;

    this.setMediaQualityBadge(mediaInfo);
    this.liveDepth.setAspect(this.video.videoWidth, this.video.videoHeight);
    const identity = sourceIdentity || `media:${src}`;
    const restoredProfile = await this.depthPlayback.restoreBestProfileForSource(identity, {
      preferredSessionId: resumeSessionId
    });
    if (generation !== this.sourceGeneration) return;
    if (!restoredProfile) this.setGridResolution(this.currentGridCols);
    const cachedReplayAvailable = this.depthPlayback.mode === 'hybrid'
      && Number(restoredProfile?.playableFrames) > 0;
    if (!cachedReplayAvailable) {
      const localPath = this.depthPlayback.conversionMode === 'luma';
      this.showStatus(localPath
        ? 'Preparing local luminance depth for this video…'
        : `Preparing ${this.liveDepth.getRequestedModelProfile().name} for this video…`);
      const backend = await this.liveDepth.ensureReady({ retry: !localPath });
      if (generation !== this.sourceGeneration) return;
      // A warm model returns immediately from ensureReady(). Re-announce the
      // backend for each source so later imports cannot remain Loading.
      if (localPath || backend !== 'luma') this.liveDepth.announceReady();
    } else {
      this.setDepthBadge('Cached Depth · Ready', 'cached');
    }
    await this.depthPlayback.setSource({
      src,
      identity,
      title,
      blob: sourceBlob,
      mediaInfo,
      resumeSession: restoredProfile
    });
    this.showStatus(
      this.depthPlayback.mode === 'hybrid'
        ? 'Video ready. Depth is analyzing ahead and will persist for replay.'
        : 'Video ready with live depth. Click Play.',
      { hideAfter: 3200 }
    );
    } finally {
      this.setComputePressure('source-load', false);
    }
  }

  async restoreDefaultMedia() {
    const generation = ++this.sourceGeneration;
    this.liveDepth.requestImmediate({ resetTemporal: true });
    await this.depthPlayback.clearSource();
    if (generation !== this.sourceGeneration) return;
    if (this.currentObjectUrl) {
      URL.revokeObjectURL(this.currentObjectUrl);
      this.currentObjectUrl = null;
    }
    this.video.pause();
    this.isPlaying = false;
    this.updatePlayButton();
    this.showStatus('Restoring bundled cached-depth demo…');

    const depthData = await DepthData.load(DEFAULT_DEMO.depthUrl);
    if (generation !== this.sourceGeneration) return;
    this.depthData = depthData;
    this.depthMode = 'cached';
    this.updateDepthDiagnostic();
    this.lastSourceMediaInfo = null;
    this.updateGridAvailability();
    this.video.src = DEFAULT_DEMO.videoUrl;
    this.video.load();
    this.setGridResolution(this.currentGridCols);
    this.setDepthBadge('Cached AI Depth', 'cached');
    document.getElementById('clipTitle').textContent = DEFAULT_DEMO.title;
    this.showStatus('Bundled demo restored.', { hideAfter: 2200 });
  }

  updatePlayButton() {
    const playBtn = document.getElementById('playPauseBtn');
    playBtn.textContent = this.isPlaying ? '❚❚' : '▶';
    playBtn.title = this.isPlaying ? 'Pause' : 'Play';
  }

  async togglePlay() {
    this.audio.attach(this.video);
    this.audio.resume();

    if (this.video.paused) {
      if (this.depthMode === 'live') await this.depthPlayback.prepareForPlayback(this.video.currentTime);
      this.video.play().then(() => {
        this.isPlaying = true;
        this.updatePlayButton();
        if (this.depthMode === 'live') this.liveDepth.requestImmediate();
      }).catch(err => {
        console.warn('Play error:', err);
        this.showStatus(`Playback error: ${err.message}`, { error: true, hideAfter: 3500 });
      });
    } else {
      this.video.pause();
      this.isPlaying = false;
      this.updatePlayButton();
    }
  }

  bindUI() {
    const playBtn = document.getElementById('playPauseBtn');
    const seekBar = document.getElementById('seekBar');
    const timeDisplay = document.getElementById('timeDisplay');
    const heightSlider = document.getElementById('heightSlider');
    const heightVal = document.getElementById('heightVal');
    const gapSlider = document.getElementById('gapSlider');
    const gapVal = document.getElementById('gapVal');
    const brightnessSlider = document.getElementById('brightnessSlider');
    const contrastSlider = document.getElementById('contrastSlider');
    const colorModeSelect = document.getElementById('colorModeSelect');
    const gridSelect = document.getElementById('gridSelect');
    const autoOrbitCheck = document.getElementById('autoOrbitCheck');
    const depthModelSelect = document.getElementById('depthModelSelect');
    const liveDepthRate = document.getElementById('liveDepthRate');
    const depthPlaybackMode = document.getElementById('depthPlaybackMode');
    const depthFusionMode = document.getElementById('depthFusionMode');
    const invertDepthCheck = document.getElementById('invertDepthCheck');
    const depthDebugSelect = document.getElementById('depthDebugSelect');
    const tvModeBtn = document.getElementById('tvModeBtn');
    const graphModeBtn = document.getElementById('graphModeBtn');
    const snapshotBtn = document.getElementById('snapshotBtn');
    const recordBtn = document.getElementById('recordBtn');
    const fileInput = document.getElementById('fileInput');
    const toggleSettingsBtn = document.getElementById('toggleSettingsBtn');
    const settingsDrawer = document.getElementById('settingsDrawer');
    const youtubeBtn = document.getElementById('youtubeBtn');
    const sourcePanel = document.getElementById('sourcePanel');
    const sourcePanelClose = document.getElementById('sourcePanelClose');
    const youtubeUrlInput = document.getElementById('youtubeUrlInput');
    const youtubeQualitySelect = document.getElementById('youtubeQualitySelect');
    const youtubeImportBtn = document.getElementById('youtubeImportBtn');
    const restoreDemoBtn = document.getElementById('restoreDemoBtn');

    playBtn.addEventListener('click', () => this.togglePlay());
    this.canvas.addEventListener('click', e => {
      if (e.target === this.canvas && !this.isPlaying && this.video.currentTime === 0) this.togglePlay();
    });

    window.addEventListener('keydown', e => {
      if (e.code === 'Space' && e.target.tagName !== 'INPUT' && e.target.tagName !== 'SELECT' && e.target.tagName !== 'TEXTAREA') {
        e.preventDefault();
        this.togglePlay();
      }
      if (e.code === 'Escape') sourcePanel.classList.add('hidden');
    });

    this.video.addEventListener('loadedmetadata', () => {
      this.setMediaQualityBadge(this.lastSourceMediaInfo);
    });
    this.video.addEventListener('play', () => {
      this.isPlaying = true;
      this.updatePlayButton();
    });
    this.video.addEventListener('pause', () => {
      this.isPlaying = false;
      this.updatePlayButton();
    });
    this.video.addEventListener('timeupdate', () => {
      if (!this.isSeeking && this.video.duration) {
        seekBar.value = (this.video.currentTime / this.video.duration) * 100;
        timeDisplay.textContent = `${this.formatTime(this.video.currentTime)} / ${this.formatTime(this.video.duration)}`;
      }
    });

    this.mediaHealth = new MediaPlaybackHealth(this, seekBar, timeDisplay);
    document.getElementById('foregroundAssist')?.addEventListener('change', e => {
      const enabled = e.target.value === 'anime';
      this.liveDepth.foregroundAssist.setEnabled(enabled, { defer: enabled });
      const activate = async () => {
        if (enabled && this.depthMode === 'live') {
          // Compile one GPU model at a time. The base depth path stays usable
          // while the optional specialist prepares in the background.
          await this.liveDepth.ensureReady({ retry: true });
          await new Promise(resolve => setTimeout(resolve, 40));
          await this.liveDepth.foregroundAssist.ensureReady({ retry: true });
        }
        this.liveDepth.requestImmediate({ resetTemporal: true });
        this.depthPlayback.scheduleRestart();
      };
      activate().catch(error => {
        this.showStatus(`Foreground assistance could not start: ${error.message}`, { error: true, hideAfter: 4000 });
      });
    });

    heightSlider.addEventListener('input', () => {
      this.updateHeightScale();
    });
    gapSlider.addEventListener('input', e => {
      const value = parseFloat(e.target.value);
      this.scene.gap = value;
      this.scene.updateVoxelTransforms();
      gapVal.textContent = `${Math.round(value * 100)}%`;
    });
    brightnessSlider.addEventListener('input', e => { this.brightness = parseFloat(e.target.value); });
    contrastSlider.addEventListener('input', e => { this.contrast = parseFloat(e.target.value); });
    colorModeSelect.addEventListener('change', e => { this.scene.colorMode = e.target.value; });
    gridSelect.addEventListener('change', e => this.setGridResolution(parseInt(e.target.value, 10)));
    autoOrbitCheck.addEventListener('change', e => { this.scene.autoOrbit = e.target.checked; });
    depthModelSelect.addEventListener('change', e => this.setLiveDepthModel(e.target.value));
    depthPlaybackMode.addEventListener('change', e => {
      this.depthPlayback.setMode(e.target.value).catch(error => {
        this.showStatus(`Depth playback mode failed: ${error.message}`, { error: true, hideAfter: 4000 });
      });
    });
    depthFusionMode?.addEventListener('change', e => {
      this.showStatus('Switching depth conversion path…');
      this.depthPlayback.setConversionMode(e.target.value).then(() => {
        this.liveDepth.requestImmediate({ resetTemporal: true });
        this.showStatus('Depth conversion path ready.', { hideAfter: 2200 });
      }).catch(error => {
        this.showStatus(`Depth conversion path failed: ${error.message}`, { error: true, hideAfter: 5000 });
      });
    });
    liveDepthRate.addEventListener('change', e => {
      this.liveDepth.setTargetFps(parseInt(e.target.value, 10));
      this.depthPlayback.scheduleRestart();
    });
    invertDepthCheck.addEventListener('change', e => {
      this.liveDepth.setInvert(e.target.checked);
      this.depthPlayback.scheduleRestart();
    });
    depthDebugSelect.addEventListener('change', e => {
      this.depthDiagnosticStage = e.target.value;
      this.updateDepthDiagnostic();
    });

    tvModeBtn.addEventListener('click', () => {
      this.scene.setTvMode(true);
      tvModeBtn.classList.add('active');
      graphModeBtn.classList.remove('active');
    });
    graphModeBtn.addEventListener('click', () => {
      this.scene.setTvMode(false);
      graphModeBtn.classList.add('active');
      tvModeBtn.classList.remove('active');
    });
    document.querySelectorAll('.preset-btn').forEach(btn => {
      btn.addEventListener('click', () => this.scene.setCameraPreset(btn.dataset.preset));
    });

    snapshotBtn.addEventListener('click', () => {
      const a = document.createElement('a');
      a.href = this.scene.captureSnapshot();
      a.download = `voxelvision-${Date.now()}.png`;
      a.click();
    });
    recordBtn.addEventListener('click', () => this.isRecording ? this.stopRecording() : this.startRecording());
    toggleSettingsBtn.addEventListener('click', () => settingsDrawer.classList.toggle('collapsed'));

    window.addEventListener('dragover', e => e.preventDefault());
    window.addEventListener('drop', e => {
      e.preventDefault();
      if (e.dataTransfer.files.length > 0) this.handleLocalFiles(e.dataTransfer.files);
    });
    fileInput.addEventListener('change', e => {
      if (e.target.files.length > 0) this.handleLocalFiles(e.target.files);
    });

    youtubeBtn.addEventListener('click', () => {
      sourcePanel.classList.toggle('hidden');
      if (!sourcePanel.classList.contains('hidden')) youtubeUrlInput.focus();
      this.refreshYoutubeCapability();
      this.depthPlayback.library.refresh().catch(() => {});
    });
    sourcePanelClose.addEventListener('click', () => sourcePanel.classList.add('hidden'));
    youtubeImportBtn.addEventListener('click', () => this.importYoutube(youtubeUrlInput.value, youtubeQualitySelect.value));
    youtubeUrlInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') this.importYoutube(youtubeUrlInput.value, youtubeQualitySelect.value);
    });
    restoreDemoBtn.addEventListener('click', () => this.restoreDefaultMedia());
  }

  async refreshYoutubeCapability() {
    const status = document.getElementById('youtubeCapability');
    try {
      const response = await fetch(voxelVisionApiUrl('/youtube/status'), { cache: 'no-store' });
      const data = await response.json();
      if (data.available) {
        const mergeState = data.ffmpegAvailable ? 'adaptive quality merge ready' : 'combined streams only';
        status.textContent = `YouTube bridge ready (${data.provider}) · ${mergeState}.`;
        status.dataset.state = data.ffmpegAvailable ? 'ready' : 'working';
      } else {
        status.textContent = 'YouTube bridge not installed. Use VoxelVision.bat → Setup / Update YouTube support.';
        status.dataset.state = 'missing';
      }
    } catch {
      status.textContent = 'Could not check YouTube bridge status.';
      status.dataset.state = 'missing';
    }
  }

  async importYoutube(rawUrl, quality = '1080') {
    const url = rawUrl.trim();
    const button = document.getElementById('youtubeImportBtn');
    const status = document.getElementById('youtubeCapability');
    const qualitySelect = document.getElementById('youtubeQualitySelect');
    const requestedLabel = qualitySelect?.selectedOptions?.[0]?.textContent?.split('·')[0]?.trim() || quality;

    if (!url) {
      status.textContent = 'Paste a YouTube video URL first.';
      status.dataset.state = 'missing';
      return;
    }

    button.disabled = true;
    button.textContent = 'Importing…';
    status.textContent = `Fetching best ${requestedLabel} source with yt-dlp…`;
    status.dataset.state = 'working';
    this.showStatus(`Importing YouTube video at ${requestedLabel}…`);

    try {
      const response = await fetch(voxelVisionApiUrl('/youtube/import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url, quality })
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.error || `HTTP ${response.status}`);

      const actual = this.describeMediaInfo(data.mediaInfo) || data.requestedQualityLabel || requestedLabel;
      status.textContent = `Download complete · ${actual}. Initializing live AI depth…`;
      await this.loadLiveMedia(data.mediaUrl, `YouTube: ${data.title}`, {
        mediaInfo: data.mediaInfo || null,
        sourceIdentity: youtubeSourceIdentity(url, quality)
      });
      status.textContent = `Ready · ${actual} · ${data.strategy === 'adaptive-merge' ? 'adaptive FFmpeg merge' : 'combined stream'} · live AI depth.`;
      status.dataset.state = 'ready';
    } catch (err) {
      console.error('YouTube import failed:', err);
      status.textContent = err.message;
      status.dataset.state = 'missing';
      this.showStatus(`YouTube import failed: ${err.message}`, { error: true });
    } finally {
      button.disabled = false;
      button.textContent = 'Transform Video';
    }
  }

  async handleLocalFiles(files) {
    for (const file of files) {
      if (!file.type.startsWith('video/')) continue;
      const url = URL.createObjectURL(file);
      try {
        await this.loadLiveMedia(url, `Local: ${file.name}`, {
          objectUrl: true,
          sourceBlob: file,
          sourceIdentity: `local:${file.name}|${file.size}|${file.lastModified}|${file.type}`
        });
      } catch (err) {
        URL.revokeObjectURL(url);
        this.showStatus(`Import failed: ${err.message}`, { error: true });
      }
      break;
    }
  }

  startRecording() {
    const stream = this.canvas.captureStream(30);
    if (this.audio.isAttached && this.audio.audioCtx) {
      try {
        const dest = this.audio.audioCtx.createMediaStreamDestination();
        this.audio.sourceNode.connect(dest);
        const audioTrack = dest.stream.getAudioTracks()[0];
        if (audioTrack) stream.addTrack(audioTrack);
      } catch (err) {
        console.warn('Audio capture for recording unavailable:', err);
      }
    }

    const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
    this.recordedChunks = [];
    this.recorder = new MediaRecorder(stream, { mimeType: mime });
    this.recorder.ondataavailable = e => { if (e.data.size > 0) this.recordedChunks.push(e.data); };
    this.recorder.onstop = () => {
      const blob = new Blob(this.recordedChunks, { type: mime });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `voxelvision-recording-${Date.now()}.webm`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      const btn = document.getElementById('recordBtn');
      btn.classList.remove('recording');
      btn.textContent = '⏺ Record';
    };

    this.recorder.start();
    this.isRecording = true;
    const btn = document.getElementById('recordBtn');
    btn.classList.add('recording');
    btn.textContent = '⏹ Stop Rec';
  }

  stopRecording() {
    if (this.recorder && this.isRecording) {
      this.recorder.stop();
      this.isRecording = false;
    }
  }

  formatTime(sec) {
    if (!sec || isNaN(sec)) return '0:00';
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${s < 10 ? '0' : ''}${s}`;
  }

  startLoop() {
    if (this.loopStarted) return;
    this.loopStarted = true;

    const loop = timestamp => {
      requestAnimationFrame(loop);
      const deltaTime = Math.min(0.1, (timestamp - this.lastTime) / 1000);
      this.lastTime = timestamp;

      const audioState = this.audio.update(deltaTime);
      this.scene.updateAudioEffects(audioState, deltaTime);

      if (this.video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA && this.activeCols && this.activeRows) {
        const frameVersion = this.videoFrameVersion;
        const hasFreshVideoFrame = !this.videoFrameCallbackSupported || frameVersion !== this.lastColorFrameVersion;
        if (hasFreshVideoFrame) {
          this.sampleCtx.drawImage(this.video, 0, 0, this.activeCols, this.activeRows);
          const imgData = this.sampleCtx.getImageData(0, 0, this.activeCols, this.activeRows);
          this.scene.updateColors(imgData.data, this.brightness, this.contrast);
          this.latestVideoPixels = imgData.data;
          this.lastColorFrameVersion = frameVersion;
        }

        if (this.depthMode === 'cached' && this.depthData) {
          this.depthPlayback.renderBundledFrame(this.depthData, this.video.currentTime);
        } else if (this.depthMode === 'live' && this.depthPlayback.mode === 'hybrid') {
          const mediaTime = this.videoFrameCallbackSupported
            ? this.videoFrameMetadata.mediaTime
            : this.video.currentTime;
          this.depthPlayback.renderFrame(mediaTime);
        } else if (this.depthMode === 'live') {
          if (this.liveDepthFrameA && this.liveDepthFrameB) {
            const elapsed = timestamp - this.liveDepthBlendStartedAt;
            const linearBlend = Math.min(1, Math.max(0, elapsed / this.liveDepthBlendDuration));
            this.scene.uniforms.uDepthBlend.value = linearBlend * linearBlend * (3 - 2 * linearBlend);
          }

          const generation = this.sourceGeneration;
          const hasFreshDepthFrame = !this.videoFrameCallbackSupported
            || frameVersion !== this.lastDepthFrameVersion
            || this.liveDepth.forceNext;
          const inference = hasFreshDepthFrame
            ? this.liveDepth.maybeUpdate(
                this.video,
                this.activeCols,
                this.activeRows,
                this.latestVideoPixels,
                {
                  frameVersion,
                  mediaTime: this.videoFrameCallbackSupported
                    ? this.videoFrameMetadata.mediaTime
                    : this.video.currentTime,
                  sourceGeneration: generation
                }
              )
            : null;
          if (inference) {
            this.lastDepthFrameVersion = frameVersion;
            inference.then(frame => {
              if (frame && this.depthMode === 'live' && generation === this.sourceGeneration) {
                const sceneCut = this.liveDepth.consumeSceneCut();
                const completedAt = performance.now();
                const resultMeta = this.liveDepth.getLastResultMeta();
                const sourceLag = Math.max(0, this.video.currentTime - Number(resultMeta?.mediaTime || 0));
                const staleThreshold = Math.max(0.38, 1.5 / Math.max(1, this.liveDepth.targetFps));
                const staleFrame = !this.video.paused && sourceLag > staleThreshold;

                if (sceneCut || staleFrame) {
                  // Never add another cross-fade interval to an already old
                  // result. Auto motion mode will also trade detail for speed.
                  this.liveDepthFrameA = frame;
                  this.liveDepthFrameB = frame;
                  this.liveDepthBlendDuration = 1;
                  this.scene.updateDepthBuffers(frame, frame, 1);
                  if (staleFrame) this.liveDepth.requestImmediate();
                } else {
                  this.liveDepthFrameA = this.currentLiveDepthFrame(completedAt) || frame;
                  this.liveDepthFrameB = frame;
                  const completionGap = this.lastDepthCompletedAt > 0
                    ? completedAt - this.lastDepthCompletedAt
                    : 1000 / Math.max(1, this.liveDepth.targetFps);
                  this.liveDepthBlendDuration = Math.min(160, Math.max(55, completionGap * 0.42));
                  this.scene.updateDepthBuffers(this.liveDepthFrameA, this.liveDepthFrameB, 0);
                }
                this.liveDepthBlendStartedAt = completedAt;
                this.lastDepthCompletedAt = completedAt;
                this.depthPlayback.scoreLiveFrame(frame, {
                  mediaTime: Number(resultMeta?.mediaTime) || this.video.currentTime,
                  sceneCut
                });
                this.updateDepthDiagnostic();
              }
            }).catch(err => console.warn('Live depth frame failed:', err));
          }
        }
        if (hasFreshVideoFrame && this.depthDiagnosticStage !== 'off') this.updateDepthDiagnostic();
      }

      this.scene.render(deltaTime);
    };

    requestAnimationFrame(loop);
  }
}

window.addEventListener('DOMContentLoaded', () => {
  window.app = new VoxelVisionApp();
});
