/** Scene-aware, non-destructive temporal calibration for persistent depth maps. */

import { clamp, percentileBounds } from './depth-processing.js';
import { ConversionScoreAccumulator, scoreDepthConversion } from './depth-conversion-score.js';

function frameStatistics(frame) {
  const bounds = percentileBounds(frame, 0.1, 0.9);
  return {
    low: bounds.low,
    high: bounds.high,
    median: (bounds.low + bounds.high) * 0.5,
    span: Math.max(0.04, bounds.high - bounds.low)
  };
}

export function planSceneAwareCalibration(samples, { radius = 3 } = {}) {
  return samples.map((sample, index) => {
    let weightedMedian = 0;
    let weightedSpan = 0;
    let weightSum = 0;
    for (let offset = -radius; offset <= radius; offset++) {
      const candidate = samples[index + offset];
      if (!candidate || candidate.segment !== sample.segment) continue;
      const weight = radius + 1 - Math.abs(offset);
      weightedMedian += candidate.median * weight;
      weightedSpan += candidate.span * weight;
      weightSum += weight;
    }
    const targetMedian = weightSum ? weightedMedian / weightSum : sample.median;
    const targetSpan = weightSum ? weightedSpan / weightSum : sample.span;
    return {
      ...sample,
      scale: clamp(targetSpan / Math.max(0.04, sample.span), 0.82, 1.22),
      offset: clamp(targetMedian - sample.median, -0.09, 0.09)
    };
  });
}

export function calibrateDepthFrame(frame, plan) {
  const out = new Float32Array(frame.length);
  const center = plan.median;
  for (let i = 0; i < frame.length; i++) {
    out[i] = clamp(center + (frame[i] - center) * plan.scale + plan.offset, 0, 1);
  }
  return out;
}

function idleYield() {
  return new Promise(resolve => {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(() => resolve(), { timeout: 80 });
    else setTimeout(resolve, 0);
  });
}

export class DepthCacheRecalibrator {
  constructor(store, { onProgress = null } = {}) {
    this.store = store;
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {};
  }

  async run(session) {
    const indices = await this.store.frameIndices(session.id);
    if (!indices.length) throw new Error('This analysis has no cached frames to recalibrate.');
    const samples = [];
    let segment = 0;
    for (let cursor = 0; cursor < indices.length; cursor++) {
      const index = indices[cursor];
      const record = await this.store.getFrame(session.id, index, { base: true });
      if (!record?.data) continue;
      if (record.sceneCut && samples.length) segment += 1;
      const frame = this.store.decodeFrameRecord(record, { base: true });
      samples.push({ index, segment, sceneCut: Boolean(record.sceneCut), ...frameStatistics(frame) });
      if (cursor % 12 === 0) {
        this.onProgress({ phase: 'scan', current: cursor + 1, total: indices.length });
        await idleYield();
      }
    }

    const plans = planSceneAwareCalibration(samples);
    const scores = new ConversionScoreAccumulator();
    let previousFrame = null;
    let previousGuide = null;
    for (let cursor = 0; cursor < plans.length; cursor++) {
      const plan = plans[cursor];
      const record = await this.store.getFrame(session.id, plan.index, { base: true });
      const calibrated = calibrateDepthFrame(this.store.decodeFrameRecord(record, { base: true }), plan);
      const guide = record.guide ? new Uint8Array(record.guide) : null;
      const quality = scoreDepthConversion({
        frame: calibrated,
        width: session.descriptor.cols,
        height: session.descriptor.rows,
        guide,
        previousFrame,
        previousGuide,
        sceneCut: plan.sceneCut
      });
      scores.add(quality);
      await this.store.putCalibration(session.id, plan.index, calibrated, {
        calibration: { version: 1, scale: plan.scale, offset: plan.offset },
        quality
      });
      previousFrame = calibrated;
      previousGuide = guide;
      if (cursor % 8 === 0) {
        this.onProgress({ phase: 'write', current: cursor + 1, total: plans.length });
        await idleYield();
      }
    }
    const result = {
      version: 1,
      frameCount: plans.length,
      completedAt: Date.now(),
      method: 'scene-aware median/span stabilization'
    };
    await this.store.touchVariant(session.id, {
      calibration: result,
      qualityAccumulator: scores.snapshot(),
      // Presented-depth evidence belongs to the old calibration and must be
      // sampled again while the recalibrated diagnostic is actually viewed.
      renderQualityAccumulator: null
    });
    this.onProgress({ phase: 'complete', current: plans.length, total: plans.length });
    return result;
  }
}
