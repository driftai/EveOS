/**
 * Hybrid depth playback: a hidden decoder analyzes ahead, a bounded Float32
 * ring feeds rendering immediately, and Uint16 frames persist in IndexedDB.
 */
import {
  cacheIdForDescriptor,
  createDepthCacheDescriptor,
  dequantizeDepth16,
  frameIndexAtTime,
  quantizeDepth16,
  resumableDescriptorForConfig,
  timeForFrameIndex
} from './depth-cache-codec.js';
import { DepthCacheStore } from './depth-cache-store.js';
import { DepthCacheTimeline } from './depth-cache-timeline.js';
import { delay, formatMegabytes, waitForVideoEvent } from './depth-ahead-utils.js';
import { ConversionScoreAccumulator, mergeConversionScoreSnapshots, scoreDepthConversion } from './depth-conversion-score.js';
import { DepthFrameRing, memoryBudgetForSystemRam } from './depth-frame-ring.js';
import { buildLumaGuide } from './depth-processing.js';
import { descriptorConversionMode } from './depth-conversion-mode.js';
const HAVE_CURRENT_DATA = 2;

export class DepthAheadController {
  constructor({ engine, onStatus = null, memoryBudgetBytes = null } = {}) {
    if (!engine) throw new TypeError('DepthAheadController requires a live depth engine.');
    this.engine = engine;
    this.onStatus = typeof onStatus === 'function' ? onStatus : () => {};
    this.mode = 'hybrid';
    this.ring = new DepthFrameRing(memoryBudgetBytes || memoryBudgetForSystemRam(null));
    this.store = new DepthCacheStore({ onStatus: state => this.#emit(state.phase, state.message, true) });
    this.timeline = new DepthCacheTimeline(this.store);
    this.video = document.createElement('video');
    this.video.muted = true;
    this.video.playsInline = true;
    this.video.preload = 'auto';
    this.canvas = document.createElement('canvas');
    this.ctx = this.canvas.getContext('2d', { willReadFrequently: true });
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
    this.source = null;
    this.sourceReady = false;
    this.knownPersistent = new Set();
    this.completedIndices = new Set();
    this.priorities = new Set();
    this.playheadIndex = 0;
    this.backgroundCursor = 0;
    this.lastAnalyzedIndex = null;
    this.epoch = 0;
    this.pumpPromise = null;
    this.pumpTimer = null;
    this.failureCount = 0;
    this.lastStatusAt = 0;
    this.lastStatusText = '';
    this.scoreAccumulator = new ConversionScoreAccumulator();
    this.renderScoreAccumulator = new ConversionScoreAccumulator();
    this.previousScoredFrame = null;
    this.previousScoredGuide = null;
    this.playbackSeeking = false;
  }
  setMemoryBudgetForSystemRam(systemMemoryGb) {
    this.ring.setBudgetBytes(memoryBudgetForSystemRam(systemMemoryGb));
    if (this.source) this.#emit('ready', null, true);
  }
  setMode(mode) {
    this.mode = mode === 'live' ? 'live' : 'hybrid';
    return this.mode;
  }
  async loadSource(config) {
    await this.stop({ clearMemory: true });
    if (this.mode !== 'hybrid') return null;
    this.sourceReady = false;

    const generatedDescriptor = createDepthCacheDescriptor(config);
    const resumed = resumableDescriptorForConfig(config.resumeSession, config);
    const descriptor = resumed?.descriptor || generatedDescriptor;
    const cacheId = resumed?.cacheId || cacheIdForDescriptor(descriptor);
    const fps = descriptor.fps;
    const duration = Math.max(0.001, Number(config.duration) || 0.001);
    // A browser can report a remuxed video's duration a few milliseconds
    // differently after reload. An exact resumed profile owns its established
    // timeline, otherwise a completed cache can sprout one phantom missing
    // frame and unnecessarily wake both AI models.
    const resumedFrameCount = resumed ? Number(config.resumeSession?.totalFrames) : 0;
    const frameCount = Math.max(1, Number.isFinite(resumedFrameCount) && resumedFrameCount > 0
      ? Math.round(resumedFrameCount)
      : Math.ceil(duration * fps));
    const epoch = this.epoch;
    this.source = {
      ...config,
      descriptor,
      cacheId,
      fps,
      duration,
      frameCount,
      epoch
    };
    this.canvas.width = descriptor.cols;
    this.canvas.height = descriptor.rows;

    this.video.src = config.src;
    this.video.load();
    if (this.video.readyState < 1) await waitForVideoEvent(this.video, 'loadedmetadata', 15000);
    if (!this.source || epoch !== this.epoch) return null;

    try {
      await this.store.initialize();
      await this.store.saveSource(config.sourceIdentity, {
        title: config.sourceTitle || 'Cached video',
        url: config.sourceBlob ? null : config.src,
        blob: config.sourceBlob || null,
        mediaInfo: config.mediaInfo || null,
        kind: config.sourceBlob ? 'local' : (String(config.sourceIdentity).startsWith('youtube:') ? 'youtube' : 'url')
      });
      const restoredIndices = config.resumeSession?.id === cacheId
        ? config.resumeSession.restoredFrameIndices
        : null;
      this.knownPersistent = await this.store.openVariant(cacheId, descriptor, {
        sourceIdentity: config.sourceIdentity,
        sourceTitle: config.sourceTitle || 'Cached video',
        totalFrames: frameCount,
        sourceDuration: duration,
        mediaInfo: config.mediaInfo || null,
        generationEnvironment: config.generationEnvironment || null,
        analysisState: 'in-progress',
        analysisUpdatedAt: Date.now()
      }, { knownIndices: restoredIndices });
      const session = await this.store.getSession(cacheId);
      this.completedIndices = new Set(this.knownPersistent);
      const timelineDescriptor = {
        ...descriptor,
        conversion: descriptorConversionMode(descriptor, config.generationEnvironment)
      };
      const reuse = this.knownPersistent.size >= frameCount
        ? (this.timeline.clear(), this.timeline.snapshot())
        : await this.timeline.prepare(cacheId, timelineDescriptor, frameCount, this.knownPersistent);
      this.scoreAccumulator = new ConversionScoreAccumulator(session?.qualityAccumulator);
      this.renderScoreAccumulator = new ConversionScoreAccumulator(session?.renderQualityAccumulator);
      for (let index = 0; index < frameCount; index++) {
        if (this.timeline.isAuthoritative(index)) this.completedIndices.add(index);
      }
      await this.store.touchVariant(cacheId, {
        frameCount: this.knownPersistent.size,
        reusableFrames: reuse.reusableFrames,
        donorProfiles: reuse.donorProfiles,
        sharedQualityAccumulator: reuse.quality
      });
    } catch (error) {
      console.warn('Persistent depth cache unavailable; using bounded RAM only:', error);
      this.store.available = false;
      this.knownPersistent = new Set();
      this.completedIndices = new Set();
      this.timeline.clear();
    }

    this.sourceReady = true;
    this.playheadIndex = frameIndexAtTime(config.startTime || 0, fps, frameCount);
    this.backgroundCursor = 0;
    this.#prioritizeWindow(this.playheadIndex);
    this.#emit('ready', null, true);
    this.#schedulePump();
    return this.snapshot();
  }
  async stop({ clearMemory = true } = {}) {
    const endingSource = this.source;
    this.epoch += 1;
    this.source = null;
    this.sourceReady = false;
    this.priorities.clear();
    if (this.pumpTimer != null) window.clearTimeout(this.pumpTimer);
    this.pumpTimer = null;
    this.engine.requestImmediate({ resetTemporal: true });
    if (this.pumpPromise) {
      try { await this.pumpPromise; } catch {}
    }
    if (endingSource && this.store.available) {
      await this.store.touchVariant(endingSource.cacheId, {
        frameCount: this.knownPersistent.size,
        reusableFrames: this.timeline.snapshot().reusableFrames,
        donorProfiles: this.timeline.snapshot().donorProfiles,
        qualityAccumulator: this.scoreAccumulator.snapshot(),
        renderQualityAccumulator: this.renderScoreAccumulator.snapshot(),
        sharedQualityAccumulator: this.timeline.quality,
        analysisState: this.completedIndices.size >= endingSource.frameCount ? 'complete' : 'paused',
        lastCheckpointAt: Date.now()
      }).catch(() => {});
    }
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
    this.knownPersistent = new Set();
    this.completedIndices = new Set();
    this.timeline.clear();
    this.lastAnalyzedIndex = null;
    this.failureCount = 0;
    this.scoreAccumulator = new ConversionScoreAccumulator();
    this.renderScoreAccumulator = new ConversionScoreAccumulator();
    this.previousScoredFrame = null;
    this.previousScoredGuide = null;
    if (clearMemory) this.ring.clear();
  }
  setPlaybackTime(time) {
    if (!this.source || this.mode !== 'hybrid') return;
    const index = frameIndexAtTime(time, this.source.fps, this.source.frameCount);
    if (Math.abs(index - this.playheadIndex) > Math.max(2, this.source.fps * 2)) this.priorities.clear();
    this.playheadIndex = index;
    this.#prioritizeWindow(index);
    this.#schedulePump();
  }
  setPlaybackSeeking(seeking) {
    this.playbackSeeking = Boolean(seeking);
    if (!seeking) this.#schedulePump();
  }
  async prepareForPlayback(time, { timeoutMs = 10000 } = {}) {
    if (!this.source || this.mode !== 'hybrid') return true;
    this.setPlaybackTime(time);
    const wanted = frameIndexAtTime(time, this.source.fps, this.source.frameCount);
    const next = Math.min(this.source.frameCount - 1, wanted + 1);
    const started = performance.now();
    this.#emit('buffering', 'Preparing synchronized depth frames before playback…', true);
    while (performance.now() - started < timeoutMs) {
      if (this.ring.has(wanted) && this.ring.has(next)) {
        this.#emit('ready', null, true);
        return true;
      }
      if (!this.source || this.mode !== 'hybrid') return false;
      this.#schedulePump();
      await delay(40);
    }
    this.#emit('working', 'Playback started while depth analysis continues in the background.', true);
    return false;
  }
  framesAt(time) {
    if (!this.source || this.mode !== 'hybrid') return null;
    const exact = Math.max(0, Math.min(this.source.frameCount - 1, Math.max(0, Number(time) || 0) * this.source.fps));
    const firstIndex = Math.floor(exact);
    const secondIndex = Math.min(this.source.frameCount - 1, firstIndex + 1);
    let first = this.ring.get(firstIndex);
    let second = this.ring.get(secondIndex);
    if (!first) {
      this.setPlaybackTime(time);
      first = second;
      if (!first) return null;
    }
    if (!second) second = first;
    return {
      first: first.frame,
      second: second.frame,
      firstIndex: first.index,
      secondIndex: second.index,
      sceneCut: Boolean(second.sceneCut),
      provisional: first.index === second.index && secondIndex !== firstIndex,
      blend: first.index === second.index ? 1 : exact - firstIndex,
      key: `${first.index}:${first.origin || 'native'}:${second.index}:${second.origin || 'native'}`,
      quality: second.quality || first.quality || null,
      firstGuide: first.guide || null,
      secondGuide: second.guide || first.guide || null,
      origin: second.origin || first.origin || 'native',
      firstOrigin: first.origin || 'native',
      secondOrigin: second.origin || 'native'
    };
  }
  snapshot() {
    const ring = this.ring.snapshot();
    const reuse = this.timeline.snapshot();
    const playable = new Set(this.knownPersistent);
    for (const index of this.timeline.plans.keys()) playable.add(index);
    const analysisQuality = mergeConversionScoreSnapshots(this.scoreAccumulator.snapshot(), reuse.quality);
    const renderQuality = this.renderScoreAccumulator.snapshot();
    const quality = renderQuality.count ? renderQuality : analysisQuality;
    return {
      mode: this.mode,
      active: Boolean(this.source),
      cacheId: this.source?.cacheId || null,
      cachedFrames: playable.size,
      nativeFrames: this.knownPersistent.size,
      reusedFrames: reuse.reusableFrames,
      donorProfiles: reuse.donorProfiles,
      totalFrames: this.source?.frameCount || 0,
      ramFrames: ring.frames,
      ramBytes: ring.bytes,
      ramBudgetBytes: ring.maxBytes,
      persistent: this.store.persistent,
      storageAvailable: this.store.available,
      quotaLimited: this.store.quotaLimited,
      quality,
      qualityBasis: renderQuality.count ? 'final rendered depth + decoded video' : 'analyzed depth maps',
      analysisQuality,
      renderQuality
    };
  }
  recordPlaybackQuality(quality) {
    const snapshot = this.renderScoreAccumulator.add(quality);
    if (this.source && snapshot.count % 12 === 0) {
      this.store.touchVariant(this.source.cacheId, { renderQualityAccumulator: snapshot }).catch(() => {});
    }
    this.#emit('working');
    return snapshot;
  }

  #prioritizeWindow(index) {
    if (!this.source) return;
    const count = Math.min(this.source.frameCount, Math.max(3, this.source.fps * 8));
    for (let offset = 0; offset < count; offset++) {
      this.priorities.add(Math.min(this.source.frameCount - 1, index + offset));
    }
  }

  #schedulePump() {
    if (!this.source || !this.sourceReady || this.mode !== 'hybrid' || this.pumpPromise || this.pumpTimer != null) return;
    this.pumpTimer = window.setTimeout(() => {
      this.pumpTimer = null;
      this.pumpPromise = this.#pump().finally(() => { this.pumpPromise = null; });
    }, 0);
  }

  #nextTask() {
    for (const index of this.priorities) {
      this.priorities.delete(index);
      if (!this.ring.has(index)) return { index, analyze: false };
    }
    while (this.source && this.backgroundCursor < this.source.frameCount) {
      const index = this.backgroundCursor++;
      if (!this.completedIndices.has(index)) return { index, analyze: true };
    }
    return null;
  }

  async #pump() {
    const epoch = this.epoch;
    while (this.source && this.sourceReady && this.mode === 'hybrid' && epoch === this.epoch) {
      // Let the visible decoder finish a scrub before starting another hidden seek.
      if (this.playbackSeeking) { await delay(40); continue; }
      const task = this.#nextTask();
      if (task == null) {
        await this.store.touchVariant(this.source.cacheId, {
          frameCount: this.knownPersistent.size,
          reusableFrames: this.timeline.snapshot().reusableFrames,
          qualityAccumulator: this.scoreAccumulator.snapshot(),
          renderQualityAccumulator: this.renderScoreAccumulator.snapshot(),
          sharedQualityAccumulator: this.timeline.quality,
          analysisState: 'complete',
          completedAt: Date.now()
        }).catch(() => {});
        this.#emit('complete', 'Depth analysis cache complete for this quality profile.', true);
        return;
      }
      try {
        await this.#ensureFrame(task.index, epoch, task.analyze);
        this.failureCount = 0;
        this.#emit('working');
      } catch (error) {
        if (epoch !== this.epoch) return;
        if (error?.code === 'DEPTH_CACHE_PATH_MISMATCH') {
          await this.store.touchVariant(this.source.cacheId, {
            analysisState: 'paused',
            lastCheckpointAt: Date.now()
          }).catch(() => {});
          this.#emit('paused', error.message, true);
          return;
        }
        this.failureCount += 1;
        console.warn(`Depth lookahead frame ${task.index} failed:`, error);
        if (this.failureCount >= 3) {
          this.#emit('error', `Depth lookahead paused after repeated errors: ${error.message}`, true);
          return;
        }
        this.priorities.add(task.index);
      }
      await delay(0);
    }
  }

  async #ensureFrame(index, epoch, analyze = false) {
    if (!this.source || epoch !== this.epoch || (!analyze && this.ring.has(index))) return;
    if (this.knownPersistent.has(index)) {
      const record = await this.store.getFrame(this.source.cacheId, index);
      if (!this.source || epoch !== this.epoch) return;
      if (record?.data) {
        const guide = record.guide ? new Uint8Array(record.guide) : null;
        this.ring.set(index, dequantizeDepth16(record.data), {
          sceneCut: Boolean(record.sceneCut),
          mediaTime: Number(record.mediaTime) || timeForFrameIndex(index, this.source.fps),
          guide,
          quality: record.quality || null,
          origin: 'native'
        });
        this.completedIndices.add(index);
        return;
      }
      this.knownPersistent.delete(index);
    }

    if (!analyze && this.timeline.has(index)) {
      const reused = await this.timeline.load(index, this.source.descriptor);
      if (!this.source || epoch !== this.epoch) return;
      if (reused?.frame) {
        this.ring.set(index, reused.frame, {
          sceneCut: reused.sceneCut,
          mediaTime: timeForFrameIndex(index, this.source.fps, this.source.duration),
          guide: reused.guide,
          quality: reused.quality,
          origin: 'shared',
          authoritative: reused.plan.authoritative
        });
        return;
      }
    }

    if (this.source.descriptor.foregroundAssist === 'anime-v1') {
      // Give the primary model sole use of the GPU during compilation. Starting
      // both WebGPU model workers together makes cached playback visibly stall.
      const backend = await this.engine.ensureReady();
      if (!this.source || epoch !== this.epoch) return;
      if (backend === 'luma') {
        const error = new Error('Mask-assisted analysis paused because its AI depth model is unavailable. Existing cached frames remain playable.');
        error.code = 'DEPTH_CACHE_PATH_MISMATCH';
        throw error;
      }
      await delay(40);
      const ready = await this.engine.foregroundAssist.ensureReady();
      if (!this.source || epoch !== this.epoch) return;
      if (!ready || !this.engine.foregroundAssist.ready) {
        const error = new Error('Optional anime mask model is unavailable. Existing cache remains playable; turn assistance off to continue base analysis.');
        error.code = 'DEPTH_CACHE_PATH_MISMATCH';
        throw error;
      }
    }
    await this.#seek(timeForFrameIndex(index, this.source.fps, this.source.duration), epoch);
    if (!this.source || epoch !== this.epoch) return;
    this.ctx.drawImage(this.video, 0, 0, this.canvas.width, this.canvas.height);
    const guidance = this.ctx.getImageData(0, 0, this.canvas.width, this.canvas.height).data;
    const guide = buildLumaGuide(guidance, this.canvas.width * this.canvas.height);
    const discontinuity = this.lastAnalyzedIndex == null || index !== this.lastAnalyzedIndex + 1;
    this.engine.requestImmediate({ resetTemporal: discontinuity });
    let job = this.engine.maybeUpdate(this.video, this.canvas.width, this.canvas.height, guidance, {
      frameVersion: index + 1,
      mediaTime: timeForFrameIndex(index, this.source.fps, this.source.duration),
      sourceGeneration: Number(this.source.sourceGeneration) || 0
    });
    if (!job && this.engine.activeJob) {
      try { await this.engine.activeJob; } catch {}
      if (!this.source || epoch !== this.epoch) return;
      this.engine.requestImmediate({ resetTemporal: discontinuity });
      job = this.engine.maybeUpdate(this.video, this.canvas.width, this.canvas.height, guidance, {
        frameVersion: index + 1,
        mediaTime: timeForFrameIndex(index, this.source.fps, this.source.duration),
        sourceGeneration: Number(this.source.sourceGeneration) || 0
      });
    }
    if (!job) throw new Error('Depth engine did not accept the lookahead frame.');
    const frame = await job;
    if (!frame || !this.source || epoch !== this.epoch) return;
    this.#assertAnalysisPathCompatible();

    const sceneCut = this.engine.consumeSceneCut();
    const mediaTime = timeForFrameIndex(index, this.source.fps, this.source.duration);
    const quality = scoreDepthConversion({
      frame,
      width: this.canvas.width,
      height: this.canvas.height,
      guide,
      previousFrame: discontinuity ? null : this.previousScoredFrame,
      previousGuide: discontinuity ? null : this.previousScoredGuide,
      sceneCut
    });
    this.scoreAccumulator.add(quality);
    this.ring.set(index, frame, { sceneCut, mediaTime, guide, quality, origin: 'native' });
    this.timeline.plans.delete(index);
    this.completedIndices.add(index);
    const stored = await this.store.putFrame(this.source.cacheId, index, quantizeDepth16(frame), {
      sceneCut,
      mediaTime,
      guide,
      quality
    });
    if (stored) {
      this.knownPersistent.add(index);
      if (this.knownPersistent.size % 12 === 0) {
        this.store.touchVariant(this.source.cacheId, {
          frameCount: this.knownPersistent.size,
          reusableFrames: this.timeline.snapshot().reusableFrames,
          qualityAccumulator: this.scoreAccumulator.snapshot(),
          analysisState: 'in-progress',
          lastCheckpointAt: Date.now()
        }).catch(() => {});
      }
    }
    this.lastAnalyzedIndex = index;
    this.previousScoredFrame = frame;
    this.previousScoredGuide = guide;
  }

  async #seek(time, epoch) {
    if (!this.source || epoch !== this.epoch) return;
    if (this.video.readyState < HAVE_CURRENT_DATA || Math.abs(this.video.currentTime - time) > 0.002) {
      const waiting = waitForVideoEvent(this.video, 'seeked', 12000);
      this.video.currentTime = time;
      await waiting;
    }
    // seeked already establishes the decoded seek target. Registering a frame
    // callback afterwards can miss that presentation on a paused decoder and
    // impose a 500 ms timeout on every cached map.
  }

  #assertAnalysisPathCompatible() {
    const descriptor = this.source?.descriptor || {};
    if (descriptor.foregroundAssist === 'anime-v1' && !this.engine.foregroundAssist.ready) {
      const error = new Error('Mask-assisted analysis paused because its auxiliary worker is unavailable. Existing cached frames remain playable.');
      error.code = 'DEPTH_CACHE_PATH_MISMATCH';
      throw error;
    }
    const expectedMode = descriptorConversionMode(descriptor, this.source?.generationEnvironment);
    const actualMode = this.engine.getEffectiveConversionMode?.() || expectedMode;
    const expectedBackend = String(descriptor.backend || '');
    const actualBackend = String(this.engine.getEffectiveBackend?.() || this.engine.backend || '');
    const expectedModel = String(descriptor.model || '');
    const actualModel = String(this.engine.getEffectiveModelKey?.() || expectedModel);
    const expectedPrecision = String(descriptor.precision || '');
    const actualPrecision = String(this.engine.getEffectivePrecision?.() || this.engine.precision || '');
    if (expectedMode === actualMode && expectedBackend === actualBackend
      && expectedModel === actualModel && expectedPrecision === actualPrecision) return;
    const error = new Error('The restored cache remains playable, but analysis paused because its original depth path is unavailable. Choose Local Luminance to build a separate local cache.');
    error.code = 'DEPTH_CACHE_PATH_MISMATCH';
    throw error;
  }

  #emit(phase = 'working', message = null, force = false) {
    const now = performance.now();
    if (!force && now - this.lastStatusAt < 500) return;
    const state = this.snapshot();
    const percent = state.totalFrames ? Math.floor((state.cachedFrames / state.totalFrames) * 100) : 0;
    const storage = !state.storageAvailable
      ? 'RAM only'
      : state.quotaLimited
        ? 'storage full · RAM active'
        : state.persistent
          ? 'protected browser storage'
          : 'browser storage';
    const sources = state.reusedFrames ? ` · ${state.nativeFrames} native + ${state.reusedFrames} shared` : '';
    const text = message || `Hybrid depth ${percent}% playable · ${state.cachedFrames}/${state.totalFrames} frames${sources} · RAM ${formatMegabytes(state.ramBytes)}/${formatMegabytes(state.ramBudgetBytes)} · ${storage}`;
    if (!force && text === this.lastStatusText) return;
    this.lastStatusAt = now;
    this.lastStatusText = text;
    this.onStatus({ ...state, phase, message: text });
  }
}
