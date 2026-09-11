/**
 * VoxelVision Live Depth Engine
 * High-fidelity live depth inference with validated DA3/DA2 model profiles,
 * WebGPU-first precision, aspect-safe patch-aligned capture, float depth
 * preservation, scene-cut detection and guided temporal stability.
 */

import * as DepthProcessing from './depth-processing.js';
import * as DepthModels from './depth-models.js';
import {
  conversionUsesAi,
  conversionUsesVideoEvidence,
  normalizeDepthConversionMode
} from './depth-conversion-mode.js';
import { DepthWorkerSession } from './depth-worker-session.js';
import { ForegroundMaskAssist } from './foreground-mask-assist.js';

export {
  blendDepthFrames,
  conditionDepthFrame,
  correctBroadDepthBias,
  DEFAULT_DEPTH_CONDITIONING,
  depthFrameToRgba,
  fitAspectDimensions,
  refineDepthWithGuidance,
  repairDepthBorders,
  stabilizeDepthMotionAware,
  stabilizeDepthStatistics,
  stabilizeRangeBounds
} from './depth-processing.js';
export {
  DEFAULT_DEPTH_MODEL,
  DEPTH_MODEL_PROFILES,
  depthModelFallbackOrder,
  fitModelCapture,
  getDepthModelProfile,
  modelTensorDimensions,
  prepareModelDepthSignal,
  rgbaToImageNetTensorData,
  validateDepthTensor
} from './depth-models.js';

// Use the package-root browser ESM entry documented by Transformers.js. The
// dist file bypassed jsDelivr's dependency rewriting and left the browser with
// an unresolvable bare `onnxruntime-web/webgpu` import.
const TRANSFORMERS_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeFloatDepth(values, low, high, { knee = 0.65, ceiling = 0.86 } = {}) {
  return DepthProcessing.normalizeFloatDepth(values, low, high, { knee, ceiling });
}

export function limitGlobalDepthTilt(frame, width, height, { maxSlope = 0.22, strength = 0.6 } = {}) {
  return DepthProcessing.limitGlobalDepthTilt(frame, width, height, { maxSlope, strength });
}

export function repairSuspiciousBorders(frame, width, height) {
  return DepthProcessing.repairSuspiciousBorders(frame, width, height);
}

export function buildLumaGuide(rgba, cells) {
  return DepthProcessing.buildLumaGuide(rgba, cells);
}

export function detectLiveSceneCut(currentDepth, previousDepth, currentGuide = null, previousGuide = null) {
  return DepthProcessing.detectLiveSceneCut(currentDepth, previousDepth, currentGuide, previousGuide);
}

export function stabilizeDepth(current, previous, currentGuide = null, previousGuide = null, width = null, height = null) {
  return DepthProcessing.stabilizeDepth(current, previous, currentGuide, previousGuide, width, height);
}

export class LiveDepthEngine {
  constructor({
    targetFps = 3,
    invert = false,
    onStatus = null,
    onForegroundStatus = null,
    conditioning = null,
    modelProfile = DepthModels.DEFAULT_DEPTH_MODEL,
    conversionMode = 'fused'
  } = {}) {
    this.targetFps = targetFps;
    this.invert = invert;
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.conditioning = conditioning || DepthProcessing.DEFAULT_DEPTH_CONDITIONING;
    this.foregroundAssist = new ForegroundMaskAssist(message => {
      const status = document.getElementById?.('foregroundAssistStatus');
      if (status) status.textContent = message;
      if (typeof onForegroundStatus === 'function') onForegroundStatus(message);
    });
    this.requestedModelKey = DepthModels.getDepthModelProfile(modelProfile).key;
    this.conversionMode = normalizeDepthConversionMode(conversionMode);
    this.activeModelKey = null;
    this.modelFallbackReason = null;

    this.pipeline = null;
    this.RawImage = null;
    this.TransformersTensor = null;
    this.inferenceMode = null;
    this.loadPromise = null;
    this.modelLoadEpoch = 0;
    this.backend = 'idle';
    this.precision = null;
    this.lastInferenceAt = -Infinity;
    this.busy = false;
    this.forceNext = true;
    this.inferenceEpoch = 0;
    this.consecutiveInferenceFailures = 0;
    this.maxConsecutiveInferenceFailures = 3;
    this.activeJob = null;
    this.lastResultMeta = null;
    this.readyStatus = null;

    this.captureCanvas = document.createElement('canvas');
    this.captureCtx = this.captureCanvas.getContext('2d', { willReadFrequently: true });
    this.captureCtx.imageSmoothingEnabled = true;
    this.captureCtx.imageSmoothingQuality = 'high';
    this.sourceWidth = 16;
    this.sourceHeight = 9;
    this.inputDetail = DepthModels.getDepthModelProfile(this.requestedModelKey).maxInputEdge;
    this.captureLayout = DepthModels.fitModelCapture(
      this.sourceWidth,
      this.sourceHeight,
      this.requestedModelKey,
      this.inputDetail
    );
    this.captureWidth = this.captureLayout.canvasWidth;
    this.captureHeight = this.captureLayout.canvasHeight;
    this.#resizeCaptureCanvas();

    this.rangeLow = null;
    this.rangeHigh = null;
    this.previousIndependentDepth = null;
    this.previousStableDepth = null;
    this.previousGuidance = null;
    this.lastFrameWasSceneCut = false;
    this.lastDepthDiagnostics = null;
  }

  setTargetFps(value) {
    const fps = Number(value);
    if (Number.isFinite(fps)) this.targetFps = clamp(fps, 1, 12);
  }

  setInvert(value) {
    this.invert = Boolean(value);
    this.requestImmediate({ resetTemporal: true });
  }

  setAspect(width, height) {
    if (!width || !height) return;
    this.sourceWidth = width;
    this.sourceHeight = height;
    this.captureLayout = DepthModels.fitModelCapture(width, height, this.requestedModelKey, this.inputDetail);
    this.captureWidth = this.captureLayout.canvasWidth;
    this.captureHeight = this.captureLayout.canvasHeight;
    this.#resizeCaptureCanvas();
    this.requestImmediate({ resetTemporal: true });
  }

  setConversionMode(value) {
    const next = normalizeDepthConversionMode(value);
    if (next === this.conversionMode) return next;
    this.conversionMode = next;
    // An automatic AI failure is retryable when the user explicitly returns
    // from Local Luminance to an AI path. A deliberately selected local path
    // never disposes an already warm model.
    if (conversionUsesAi(next) && this.backend === 'luma' && !this.pipeline) {
      this.modelLoadEpoch += 1;
      this.loadPromise = null;
      this.backend = 'idle';
      this.precision = null;
      this.readyStatus = null;
    }
    this.requestImmediate({ resetTemporal: true });
    return next;
  }

  getEffectiveBackend() {
    return conversionUsesAi(this.conversionMode) ? this.backend : 'luma';
  }

  getEffectivePrecision() {
    return this.getEffectiveBackend() === 'luma' ? 'Float32 Local' : this.precision;
  }

  getEffectiveModelKey() {
    return this.getEffectiveBackend() === 'luma'
      ? 'local-luminance'
      : (this.getActiveModelProfile()?.key || this.requestedModelKey);
  }

  getEffectiveConversionMode() {
    return this.getEffectiveBackend() === 'luma'
      ? 'luma'
      : this.conversionMode;
  }

  setInputDetail(value, { resetTemporal = true } = {}) {
    const profile = this.getActiveModelProfile() || this.getRequestedModelProfile();
    const detail = clamp(Math.round(Number(value) || profile.maxInputEdge), profile.patchSize * 4, profile.maxInputEdge);
    if (detail === this.inputDetail) return false;
    this.inputDetail = detail;
    this.captureLayout = DepthModels.fitModelCapture(
      this.sourceWidth,
      this.sourceHeight,
      profile,
      this.inputDetail
    );
    this.captureWidth = this.captureLayout.canvasWidth;
    this.captureHeight = this.captureLayout.canvasHeight;
    this.#resizeCaptureCanvas();
    this.requestImmediate({ resetTemporal });
    return true;
  }

  #resizeCaptureCanvas() {
    this.captureCanvas.width = this.captureWidth;
    this.captureCanvas.height = this.captureHeight;
    this.captureCtx.imageSmoothingEnabled = true;
    this.captureCtx.imageSmoothingQuality = 'high';
  }

  resetTemporalState() {
    this.foregroundAssist?.reset();
    this.rangeLow = null;
    this.rangeHigh = null;
    this.previousIndependentDepth = null;
    this.previousStableDepth = null;
    this.previousGuidance = null;
    this.lastFrameWasSceneCut = true;
    this.lastDepthDiagnostics = null;
  }

  requestImmediate({ resetTemporal = false } = {}) {
    if (resetTemporal) {
      this.inferenceEpoch += 1;
      this.resetTemporalState();
    }
    this.forceNext = true;
    this.lastInferenceAt = -Infinity;
  }

  consumeSceneCut() {
    const value = this.lastFrameWasSceneCut;
    this.lastFrameWasSceneCut = false;
    return value;
  }

  getDiagnosticFrame(stage = 'final') {
    return this.lastDepthDiagnostics?.[stage] || null;
  }

  getDiagnostics() {
    return this.lastDepthDiagnostics;
  }

  getLastResultMeta() {
    return this.lastResultMeta;
  }

  announceReady() {
    if (!conversionUsesAi(this.conversionMode)) {
      const status = {
        phase: 'local',
        message: 'Local luminance depth ready - no AI model is required.'
      };
      this.onStatus(status);
      return status;
    }
    if (this.readyStatus) this.onStatus({ ...this.readyStatus });
    return this.readyStatus;
  }

  getRequestedModelProfile() {
    return DepthModels.getDepthModelProfile(this.requestedModelKey);
  }

  getActiveModelProfile() {
    return this.activeModelKey ? DepthModels.getDepthModelProfile(this.activeModelKey) : null;
  }

  async setModelProfile(key, { load = true } = {}) {
    const next = DepthModels.getDepthModelProfile(key);
    if (next.key === this.requestedModelKey && (this.pipeline || this.loadPromise)) {
      return load ? this.ensureReady() : this.backend;
    }

    this.requestImmediate({ resetTemporal: true });
    const activeJob = this.activeJob;
    if (activeJob) {
      try { await activeJob; } catch {}
    }

    const previousPipeline = this.pipeline;
    this.pipeline = null;
    this.modelLoadEpoch += 1;
    this.loadPromise = null;
    this.backend = 'idle';
    this.precision = null;
    this.inferenceMode = null;
    this.activeModelKey = null;
    this.modelFallbackReason = null;
    this.readyStatus = null;
    this.requestedModelKey = next.key;
    this.inputDetail = Math.min(this.inputDetail, next.maxInputEdge);
    this.captureLayout = DepthModels.fitModelCapture(this.sourceWidth, this.sourceHeight, next, this.inputDetail);
    this.captureWidth = this.captureLayout.canvasWidth;
    this.captureHeight = this.captureLayout.canvasHeight;
    this.#resizeCaptureCanvas();
    await this.#disposePipeline(previousPipeline);
    return load ? this.ensureReady() : this.backend;
  }

  async ensureReady({ retry = false } = {}) {
    if (!conversionUsesAi(this.conversionMode)) return 'luma';
    if (retry && this.backend === 'luma' && !this.pipeline) {
      this.modelLoadEpoch += 1;
      this.backend = 'idle';
      this.precision = null;
      this.inferenceMode = null;
      this.activeModelKey = null;
      this.modelFallbackReason = null;
      this.readyStatus = null;
      this.loadPromise = null;
    }
    if (this.pipeline || this.backend === 'luma') return this.backend;
    if (this.loadPromise) return this.loadPromise;

    const loadEpoch = ++this.modelLoadEpoch;
    const loading = this.#loadModel(loadEpoch);
    this.loadPromise = loading;
    try {
      return await loading;
    } finally {
      if (this.loadPromise === loading) this.loadPromise = null;
    }
  }

  async #loadModel(loadEpoch) {
    try {
      this.onStatus({ phase: 'module', message: 'Loading high-fidelity live AI depth runtime…' });
      let module = await import(TRANSFORMERS_MODULE_URL);
      this.#configureRuntimeModule(module);

      const preferWebGpu = Boolean(navigator.gpu);
      let hasFp16 = false;
      if (preferWebGpu) {
        try {
          const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
          hasFp16 = Boolean(adapter?.features?.has('shader-f16'));
        } catch {}
      }

      const failures = [];
      let runtimeAttempt = 0;
      for (const profile of DepthModels.depthModelFallbackOrder(this.requestedModelKey)) {
        if (profile.key !== this.requestedModelKey) {
          this.onStatus({
            phase: 'model',
            message: `${this.getRequestedModelProfile().name} was unavailable; validating ${profile.name} fallback…`
          });
        }
        for (const candidate of this.#candidateConfigurations(profile, preferWebGpu, hasFp16)) {
          let loaded = null;
          try {
            if (runtimeAttempt > 0) {
              module = await import(`${TRANSFORMERS_MODULE_URL}?voxelvision-runtime=${loadEpoch}-${runtimeAttempt}`);
              this.#configureRuntimeModule(module);
            }
            const progress_callback = progress => {
              if (!progress || typeof progress !== 'object') return;
              const pct = Number.isFinite(progress.progress) ? ` ${Math.round(progress.progress)}%` : '';
              if (progress.status === 'progress' || progress.status === 'download') {
                this.onStatus({ phase: 'model', message: `Downloading ${profile.name}…${pct}` });
              }
            };
            this.onStatus({
              phase: 'model',
              message: `Starting ${profile.name} on ${candidate.backendLabel} ${candidate.label}…`
            });
            loaded = await this.#createModelCandidate(module, profile, candidate, progress_callback);
            await this.#validateModelCandidate(module, profile, loaded, candidate);
            if (loadEpoch !== this.modelLoadEpoch) {
              await this.#disposePipeline(loaded);
              return this.backend;
            }
            this.pipeline = loaded;
            this.RawImage = module.RawImage;
            this.TransformersTensor = module.Tensor;
            this.inferenceMode = profile.loader;
            this.activeModelKey = profile.key;
            this.backend = candidate.backend;
            this.precision = candidate.label;
            this.modelFallbackReason = profile.key === this.requestedModelKey
              ? null
              : failures.at(-1)?.message || 'Enhanced model unavailable';
            this.consecutiveInferenceFailures = 0;
            const fallbackNote = this.modelFallbackReason ? ' (automatic compatible fallback)' : '';
            this.readyStatus = {
              phase: 'ready',
              message: `${profile.name} ready — ${candidate.backendLabel} ${candidate.label}${fallbackNote}.`,
              requestedModel: this.requestedModelKey,
              activeModel: profile.key,
              fallbackReason: this.modelFallbackReason
            };
            this.onStatus({ ...this.readyStatus });
            return this.backend;
          } catch (error) {
            failures.push(error);
            runtimeAttempt += 1;
            console.warn(`VoxelVision ${profile.name} ${candidate.backendLabel} ${candidate.label} init failed:`, error);
            await this.#disposePipeline(loaded);
          }
        }
      }
      throw failures.at(-1) || new Error('No compatible live depth model configuration succeeded.');
    } catch (error) {
      if (loadEpoch !== this.modelLoadEpoch) return this.backend;
      console.warn('VoxelVision live AI depth unavailable; using luminance fallback.', error);
      this.#activateLumaFallback(error, 'AI depth unavailable — using local luminance depth fallback.');
      return this.backend;
    }
  }

  #configureRuntimeModule(module) {
    if (!module?.env) return;
    module.env.allowLocalModels = false;
    module.env.useBrowserCache = true;
    if (module.env.backends?.onnx?.wasm) module.env.backends.onnx.wasm.numThreads = 1;
  }

  #candidateConfigurations(profile, preferWebGpu, hasFp16) {
    const candidates = [];
    if (preferWebGpu && hasFp16) {
      const forceCpuNodeNames = profile.webGpuFp16CpuNodes || [];
      candidates.push({
        backend: 'webgpu',
        backendLabel: 'WebGPU',
        dtype: 'fp16',
        label: forceCpuNodeNames.length ? 'FP16 Hybrid' : 'FP16',
        sessionOptions: forceCpuNodeNames.length
          ? { executionProviders: [{ name: 'webgpu', forceCpuNodeNames: [...forceCpuNodeNames] }] }
          : null
      });
    }
    // DA3's FP16 export contains a cubic Resize which currently generates an
    // invalid ResizeBiCubic WGSL shader on some Chrome/D3D NVIDIA paths. The
    // model's Q8 export retains the DA3 architecture with float activations and
    // has been validated on that WebGPU path, so keep it on the GPU before a
    // much slower WASM or DA2 model fallback.
    if (profile.loader === 'worker-model' && profile.key === 'enhanced' && preferWebGpu) {
      candidates.push({
        backend: 'webgpu',
        backendLabel: 'WebGPU',
        dtype: 'q8',
        label: 'Q8 Compatibility'
      });
    }
    if (profile.loader === 'pipeline' && preferWebGpu) {
      if (hasFp16) candidates.push({ backend: 'webgpu', backendLabel: 'WebGPU', dtype: 'q4f16', label: 'Q4F16' });
      candidates.push({ backend: 'webgpu', backendLabel: 'WebGPU', dtype: 'q4', label: 'Q4' });
    }
    if (profile.loader === 'worker-model' && profile.key === 'balanced' && preferWebGpu) {
      if (hasFp16) candidates.push({ backend: 'webgpu', backendLabel: 'WebGPU', dtype: 'q4f16', label: 'Q4F16' });
      candidates.push({ backend: 'webgpu', backendLabel: 'WebGPU', dtype: 'q4', label: 'Q4' });
    }
    candidates.push({
      backend: 'wasm',
      backendLabel: 'WASM',
      dtype: profile.loader === 'worker-model' ? 'q8' : 'q4',
      label: profile.loader === 'worker-model' ? 'Q8' : 'Q4'
    });
    return candidates;
  }

  async #createModelCandidate(module, profile, candidate, progress_callback) {
    if (profile.loader === 'worker-model') {
      return DepthWorkerSession.create({
        modelId: profile.id,
        backend: candidate.backend,
        dtype: candidate.dtype,
        rank5: profile.rank5,
        sessionOptions: candidate.sessionOptions,
        onProgress: progress_callback
      });
    }
    return module.pipeline('depth-estimation', profile.id, {
      device: candidate.backend,
      dtype: candidate.dtype,
      progress_callback
    });
  }

  async #validateModelCandidate(module, profile, candidate, runtime) {
    const width = 126;
    const height = 98;
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    const image = context.createImageData(width, height);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const index = (y * width + x) * 4;
        image.data[index] = Math.round((x / Math.max(1, width - 1)) * 255);
        image.data[index + 1] = Math.round((y / Math.max(1, height - 1)) * 255);
        image.data[index + 2] = ((x + y) % 32) * 8;
        image.data[index + 3] = 255;
      }
    }
    context.putImageData(image, 0, 0);
    const output = await this.#withTimeout(
      this.#runCandidate(module, profile, candidate, canvas, context),
      runtime.backend === 'wasm' ? 90000 : 30000,
      `${profile.name} warm-up`
    );
    DepthModels.validateDepthTensor(this.#extractDepthTensor(output));
  }

  async #runCandidate(module, profile, candidate, canvas, context = null) {
    if (profile.loader === 'worker-model') {
      const width = canvas.width;
      const height = canvas.height;
      const rgba = (context || canvas.getContext('2d', { willReadFrequently: true }))
        .getImageData(0, 0, width, height).data;
      return candidate.run(rgba, width, height);
    }
    return candidate(module.RawImage.fromCanvas(canvas));
  }

  #extractDepthTensor(result) {
    const output = Array.isArray(result) ? result[0] : result;
    return output?.predicted_depth || output?.depth || output?.logits || null;
  }

  #withTimeout(promise, timeoutMs, label) {
    return new Promise((resolve, reject) => {
      const timer = globalThis.setTimeout(() => reject(new Error(`${label} timed out.`)), timeoutMs);
      Promise.resolve(promise).then(
        value => { globalThis.clearTimeout(timer); resolve(value); },
        error => { globalThis.clearTimeout(timer); reject(error); }
      );
    });
  }

  async #disposePipeline(pipeline = this.pipeline) {
    if (typeof pipeline?.dispose !== 'function') return;
    try {
      await pipeline.dispose();
    } catch (error) {
      console.warn('VoxelVision could not fully dispose a depth pipeline.', error);
    }
  }

  #activateLumaFallback(error, message) {
    const failedPipeline = this.pipeline;
    this.pipeline = null;
    this.backend = 'luma';
    this.precision = null;
    this.inferenceMode = null;
    this.activeModelKey = null;
    this.consecutiveInferenceFailures = 0;
    this.resetTemporalState();
    this.readyStatus = { phase: 'fallback', message, error };

    this.#disposePipeline(failedPipeline);

    this.onStatus({ ...this.readyStatus });
  }

  maybeUpdate(video, cols, rows, guidancePixels = null, metadata = null) {
    if (!video || video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) return null;
    if (this.busy) {
      // Collapse any backlog into one latest-frame request. The next inference
      // captures the video again instead of processing a queued obsolete copy.
      this.forceNext = true;
      return null;
    }

    const now = performance.now();
    const intervalMs = 1000 / Math.max(1, this.targetFps);
    if (!this.forceNext && now - this.lastInferenceAt < intervalMs) return null;

    this.forceNext = false;
    this.lastInferenceAt = now;
    this.busy = true;
    const inferenceEpoch = this.inferenceEpoch;
    const submittedAt = performance.now();
    const submittedMeta = {
      frameVersion: Number(metadata?.frameVersion) || null,
      mediaTime: Number.isFinite(Number(metadata?.mediaTime)) ? Number(metadata.mediaTime) : Number(video.currentTime) || 0,
      sourceGeneration: Number(metadata?.sourceGeneration) || 0,
      submittedAt,
      inputWidth: this.captureWidth,
      inputHeight: this.captureHeight
    };

    const job = this.#infer(video, cols, rows, guidancePixels, inferenceEpoch)
      .then(frame => {
        if (inferenceEpoch !== this.inferenceEpoch || !frame) return null;
        const completedAt = performance.now();
        this.lastResultMeta = {
          ...submittedMeta,
          conversionMode: this.getEffectiveConversionMode(),
          backend: this.getEffectiveBackend(),
          completedAt,
          durationMs: completedAt - submittedAt
        };
        return frame;
      })
      .finally(() => {
        this.busy = false;
        if (this.activeJob === job) this.activeJob = null;
      });
    this.activeJob = job;
    return job;
  }

  #processRawDepth(tensor, cols, rows, guidancePixels = null, semanticMask = null) {
    const shape = DepthModels.tensorSpatialShape(tensor);
    if (!shape || !tensor?.data) return null;

    DepthModels.validateDepthTensor(tensor, { roughnessLimit: Infinity });
    const layout = this.captureLayout;
    const scaleX = shape.width / Math.max(1, layout.canvasWidth);
    const scaleY = shape.height / Math.max(1, layout.canvasHeight);
    const rawGrid = DepthProcessing.resampleFloatBilinearRegion(
      tensor.data,
      shape.width,
      shape.height,
      layout.contentX * scaleX,
      layout.contentY * scaleY,
      layout.contentWidth * scaleX,
      layout.contentHeight * scaleY,
      cols,
      rows
    );
    const activeProfile = this.getActiveModelProfile() || this.getRequestedModelProfile();
    const depthSignal = DepthModels.prepareModelDepthSignal(rawGrid, activeProfile);
    const currentBounds = DepthProcessing.percentileBounds(depthSignal, 0.03, 0.97);
    const independent = DepthProcessing.normalizeFloatDepth(
      depthSignal,
      currentBounds.low,
      currentBounds.high,
      { knee: 0.65, ceiling: 0.88 }
    );
    const guidance = DepthProcessing.buildLumaGuide(guidancePixels, cols * rows);
    const usesVideoEvidence = conversionUsesVideoEvidence(this.conversionMode);
    const conditioningGuide = usesVideoEvidence ? guidance : null;
    const sceneChange = DepthProcessing.detectLiveSceneCut(
      independent,
      this.previousIndependentDepth,
      guidance,
      this.previousGuidance
    );
    const isSceneCut = sceneChange.isSceneCut;
    this.lastFrameWasSceneCut = isSceneCut;

    if (this.rangeLow == null || this.rangeHigh == null || isSceneCut) {
      this.rangeLow = currentBounds.low;
      this.rangeHigh = currentBounds.high;
    } else {
      const stabilizedBounds = DepthProcessing.stabilizeRangeBounds(
        this.rangeLow,
        this.rangeHigh,
        currentBounds.low,
        currentBounds.high
      );
      this.rangeLow = stabilizedBounds.low;
      this.rangeHigh = stabilizedBounds.high;
    }

    const normalized = DepthProcessing.normalizeFloatDepth(
      depthSignal,
      this.rangeLow,
      this.rangeHigh,
      { knee: 0.65, ceiling: 0.88 }
    );
    const conditioned = DepthProcessing.conditionDepthFrame(normalized, cols, rows, conditioningGuide, {
      ...this.conditioning,
      colorGuidance: usesVideoEvidence ? guidancePixels : null,
      foregroundDetail: { ...this.conditioning.foregroundDetail, semanticMask }
    });
    const statistics = !isSceneCut
      ? DepthProcessing.stabilizeDepthStatistics(
          conditioned.frame,
          this.previousStableDepth,
          guidance,
          this.previousGuidance
        )
      : { frame: conditioned.frame, metrics: { scale: 1, offset: 0, strength: 0, visualDifference: 0 } };
    let refined = statistics.frame;
    let motion = { x: 0, y: 0, confidence: 0, score: Infinity };

    if (!isSceneCut) {
      const temporal = DepthProcessing.stabilizeDepthMotionAware(
        refined,
        this.previousStableDepth,
        cols,
        rows,
        guidance,
        this.previousGuidance,
        { trustedForeground: conditioned.metrics.foregroundDetail?.pixels ? semanticMask : null }
      );
      refined = temporal.frame;
      motion = temporal.motion;
    }

    this.previousIndependentDepth = independent;
    this.previousStableDepth = refined;
    this.previousGuidance = guidance;

    const finalFrame = this.invert ? DepthProcessing.invertDepthFrame(refined) : refined;
    this.lastDepthDiagnostics = {
      width: cols,
      height: rows,
      raw: rawGrid,
      normalized,
      corrected: conditioned.corrected,
      stabilized: refined,
      final: finalFrame,
      metrics: {
        ...conditioned.metrics,
        sceneChange,
        temporal: { statistics: statistics.metrics, motion },
        range: { low: this.rangeLow, high: this.rangeHigh },
        model: {
          requested: this.requestedModelKey,
          active: activeProfile.key,
          name: activeProfile.name,
          outputDirection: activeProfile.outputDirection,
          toneMap: activeProfile.toneMap,
          fallback: Boolean(this.modelFallbackReason)
        },
        conversion: this.getEffectiveConversionMode()
      }
    };
    return finalFrame;
  }

  #drawVideoFrame(video) {
    const ctx = this.captureCtx;
    const layout = this.captureLayout;
    const { contentX: x, contentY: y, contentWidth: width, contentHeight: height } = layout;
    ctx.clearRect(0, 0, this.captureWidth, this.captureHeight);
    ctx.drawImage(video, x, y, width, height);

    const right = this.captureWidth - x - width;
    const bottom = this.captureHeight - y - height;
    if (y > 0) ctx.drawImage(this.captureCanvas, x, y, width, 1, x, 0, width, y);
    if (bottom > 0) ctx.drawImage(this.captureCanvas, x, y + height - 1, width, 1, x, y + height, width, bottom);
    if (x > 0) ctx.drawImage(this.captureCanvas, x, y, 1, height, 0, y, x, height);
    if (right > 0) ctx.drawImage(this.captureCanvas, x + width - 1, y, 1, height, x + width, y, right, height);
    if (x > 0 && y > 0) ctx.drawImage(this.captureCanvas, x, y, 1, 1, 0, 0, x, y);
    if (right > 0 && y > 0) ctx.drawImage(this.captureCanvas, x + width - 1, y, 1, 1, x + width, 0, right, y);
    if (x > 0 && bottom > 0) ctx.drawImage(this.captureCanvas, x, y + height - 1, 1, 1, 0, y + height, x, bottom);
    if (right > 0 && bottom > 0) {
      ctx.drawImage(this.captureCanvas, x + width - 1, y + height - 1, 1, 1, x + width, y + height, right, bottom);
    }
  }

  async #infer(video, cols, rows, guidancePixels, inferenceEpoch) {
    this.#drawVideoFrame(video);
    const backend = await this.ensureReady();
    if (inferenceEpoch !== this.inferenceEpoch) return null;

    if (!conversionUsesAi(this.conversionMode) || backend === 'luma' || !this.pipeline) {
      return this.#luminanceDepth(cols, rows, guidancePixels);
    }

    try {
      const activeProfile = this.getActiveModelProfile();
      if (!activeProfile) throw new Error('No active depth model profile.');
      const maskJob = conversionUsesVideoEvidence(this.conversionMode)
        ? this.foregroundAssist.forFrame(guidancePixels, cols, rows, Number(video.currentTime) || 0, video).catch(() => null)
        : Promise.resolve(null);
      const result = await this.#withTimeout(
        this.#runCandidate(
          { RawImage: this.RawImage, Tensor: this.TransformersTensor },
          activeProfile,
          this.pipeline,
          this.captureCanvas,
          this.captureCtx
        ),
        backend === 'wasm' ? 60000 : 15000,
        `${activeProfile.name} inference`
      );
      if (inferenceEpoch !== this.inferenceEpoch) return null;
      const output = Array.isArray(result) ? result[0] : result;

      const semanticMask = await maskJob;
      if (inferenceEpoch !== this.inferenceEpoch) return null;
      const rawProcessed = this.#processRawDepth(
        output?.predicted_depth || output?.logits,
        cols,
        rows,
        guidancePixels,
        semanticMask
      );
      if (rawProcessed) {
        this.consecutiveInferenceFailures = 0;
        return rawProcessed;
      }

      const depth = output?.depth;
      if (!depth?.data || !depth.width || !depth.height) {
        throw new Error('Depth pipeline returned no usable depth map.');
      }

      const previewFrame = DepthProcessing.resampleGrayBilinear(
        depth.data,
        depth.width,
        depth.height,
        depth.channels || 1,
        cols,
        rows,
        this.invert
      );
      this.consecutiveInferenceFailures = 0;
      this.lastFrameWasSceneCut = false;
      this.lastDepthDiagnostics = {
        width: cols,
        height: rows,
        raw: previewFrame,
        normalized: previewFrame,
        corrected: previewFrame,
        stabilized: previewFrame,
        final: previewFrame
      };
      return previewFrame;
    } catch (error) {
      if (inferenceEpoch !== this.inferenceEpoch) return null;

      this.consecutiveInferenceFailures += 1;
      const failureCount = this.consecutiveInferenceFailures;
      console.warn(
        `Live AI depth frame failed (${failureCount}/${this.maxConsecutiveInferenceFailures}); preserving the last stable frame.`,
        error
      );

      if (failureCount < this.maxConsecutiveInferenceFailures) return null;

      this.#activateLumaFallback(
        error,
        'AI depth became unstable — switched to the local luminance fallback.'
      );
      const fallbackFrame = this.#luminanceDepth(cols, rows, guidancePixels);
      this.lastFrameWasSceneCut = true;
      return fallbackFrame;
    }
  }

  #luminanceDepth(cols, rows, guidancePixels = null) {
    const layout = this.captureLayout;
    const image = this.captureCtx.getImageData(
      layout.contentX,
      layout.contentY,
      layout.contentWidth,
      layout.contentHeight
    );
    const lumaRaw = new Float32Array(layout.contentWidth * layout.contentHeight);

    for (let i = 0; i < lumaRaw.length; i++) {
      const src = i * 4;
      lumaRaw[i] = image.data[src] * 0.299 + image.data[src + 1] * 0.587 + image.data[src + 2] * 0.114;
    }

    const rawGrid = DepthProcessing.resampleFloatBilinear(
      lumaRaw,
      layout.contentWidth,
      layout.contentHeight,
      cols,
      rows
    );
    const bounds = DepthProcessing.percentileBounds(rawGrid, 0.05, 0.95);
    const independent = DepthProcessing.normalizeFloatDepth(
      rawGrid,
      bounds.low,
      bounds.high,
      { knee: 0.52, ceiling: 0.75 }
    );
    const guidance = new Uint8Array(rawGrid.length);
    for (let i = 0; i < rawGrid.length; i++) guidance[i] = Math.round(clamp(rawGrid[i], 0, 255));
    const sceneChange = DepthProcessing.detectLiveSceneCut(
      independent,
      this.previousIndependentDepth,
      guidance,
      this.previousGuidance
    );
    const isSceneCut = sceneChange.isSceneCut;
    this.lastFrameWasSceneCut = isSceneCut;

    if (this.rangeLow == null || this.rangeHigh == null || isSceneCut) {
      this.rangeLow = bounds.low;
      this.rangeHigh = bounds.high;
    } else {
      const stabilizedBounds = DepthProcessing.stabilizeRangeBounds(
        this.rangeLow,
        this.rangeHigh,
        bounds.low,
        bounds.high
      );
      this.rangeLow = stabilizedBounds.low;
      this.rangeHigh = stabilizedBounds.high;
    }

    const normalized = DepthProcessing.normalizeFloatDepth(
      rawGrid,
      this.rangeLow,
      this.rangeHigh,
      { knee: 0.52, ceiling: 0.75 }
    );
    const conditioned = DepthProcessing.conditionDepthFrame(normalized, cols, rows, guidance, {
      ...this.conditioning,
      colorGuidance: guidancePixels
    });
    let stabilized = DepthProcessing.smoothFloatDepth(conditioned.frame, cols, rows, 1.4, 28 / 255);
    const statistics = !isSceneCut
      ? DepthProcessing.stabilizeDepthStatistics(stabilized, this.previousStableDepth, guidance, this.previousGuidance)
      : { frame: stabilized, metrics: { scale: 1, offset: 0, strength: 0, visualDifference: 0 } };
    stabilized = statistics.frame;
    let motion = { x: 0, y: 0, confidence: 0, score: Infinity };
    if (!isSceneCut) {
      const temporal = DepthProcessing.stabilizeDepthMotionAware(
        stabilized,
        this.previousStableDepth,
        cols,
        rows,
        guidance,
        this.previousGuidance
      );
      stabilized = temporal.frame;
      motion = temporal.motion;
    }
    this.previousIndependentDepth = independent;
    this.previousStableDepth = stabilized;
    this.previousGuidance = guidance;

    const finalFrame = this.invert ? DepthProcessing.invertDepthFrame(stabilized) : stabilized;
    this.lastDepthDiagnostics = {
      width: cols,
      height: rows,
      raw: rawGrid,
      normalized,
      corrected: conditioned.corrected,
      stabilized,
      final: finalFrame,
      metrics: {
        ...conditioned.metrics,
        sceneChange,
        temporal: { statistics: statistics.metrics, motion },
        range: { low: this.rangeLow, high: this.rangeHigh },
        conversion: 'luma'
      }
    };
    return finalFrame;
  }
}
