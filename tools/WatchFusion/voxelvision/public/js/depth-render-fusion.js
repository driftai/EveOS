/**
 * Render-time fusion for cached/model depth and the current decoded image.
 *
 * The model remains the only source of near/far semantics. Video luminance is
 * used as bounded edge evidence so texture cannot independently emboss the
 * voxel surface. This keeps the precomputed VoxelTV-style interpolation path
 * while improving boundary placement and response between analyzed frames.
 */

import {
  blendDepthFrames,
  buildLumaGuide,
  clamp,
  estimateGuideTranslation,
  stabilizeDepthStatistics,
  stabilizeDepthMotionAware
} from './depth-processing.js';
import { recoverForegroundDetail } from './foreground-detail-recovery.js';

const GUIDE_WEIGHTS = new Float32Array(256);
for (let i = 0; i < GUIDE_WEIGHTS.length; i++) GUIDE_WEIGHTS[i] = Math.exp(-((i / 24) ** 2) * 0.5);

function meanGuideDifference(a, b, step = 1) {
  if (!a || !b || a.length !== b.length) return Infinity;
  let total = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += Math.max(1, step)) {
    total += Math.abs(a[i] - b[i]);
    count += 1;
  }
  return count ? total / count : Infinity;
}

function motionCarry(previous, current, width, height, motion, strength, guide, previousGuide) {
  if (!previous || previous.length !== current.length || strength <= 0) return current;
  const out = new Float32Array(current.length);
  const mix = clamp(strength * motion.confidence, 0, 0.14);
  if (mix <= 0.002) return current;

  for (let y = 0; y < height; y++) {
    const py = clamp(Math.round(y + motion.y), 0, height - 1);
    for (let x = 0; x < width; x++) {
      const px = clamp(Math.round(x + motion.x), 0, width - 1);
      const index = y * width + x;
      const prior = py * width + px;
      const localConfidence = clamp(1 - Math.abs(guide[index] - previousGuide[prior]) / 16, 0, 1);
      out[index] = current[index] + (previous[prior] - current[index]) * mix * localConfidence;
    }
  }
  return out;
}

function refineDepthEdges(frame, guide, width, height, amount) {
  const out = new Float32Array(frame.length);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = y * width + x;
      const center = frame[index];
      let total = center;
      let weightSum = 1;
      for (let direction = 0; direction < 4; direction++) {
        if ((direction === 0 && x === 0) || (direction === 1 && x + 1 === width)
          || (direction === 2 && y === 0) || (direction === 3 && y + 1 === height)) continue;
        const neighborIndex = direction === 0
          ? index - 1
          : direction === 1
            ? index + 1
            : direction === 2
              ? index - width
              : index + width;
        const depthDelta = Math.abs(frame[neighborIndex] - center);
        if (depthDelta >= 0.18) continue;
        const guideDelta = Math.abs(guide[neighborIndex] - guide[index]);
        const weight = GUIDE_WEIGHTS[guideDelta] * (1 - depthDelta / 0.18) * 0.68;
        total += frame[neighborIndex] * weight;
        weightSum += weight;
      }
      const filtered = total / weightSum;
      out[index] = clamp(center + (filtered - center) * amount, 0, 1);
    }
  }
  return out;
}

export function fuseDepthWithVideoEvidence(
  frameA,
  frameB,
  blend,
  width,
  height,
  rgba = null,
  options = {}
) {
  const blended = blendDepthFrames(frameA, frameB, blend);
  if (!blended || blended.length !== width * height) return { frame: blended, guide: null, motion: null };
  const guide = options.guide || buildLumaGuide(rgba, blended.length);
  if (!guide) return { frame: blended, guide: null, motion: null };

  // A deliberately weak second edge-aware pass. The expensive model pipeline
  // already conditions new frames; this pass aligns interpolation to the exact
  // decoded frame without generating depth from brightness.
  const recovered = options.recoverForeground === false
    ? { frame: blended, metrics: null }
    : recoverForegroundDetail(blended, width, height, rgba, options.foregroundDetail);
  const edgeAligned = refineDepthEdges(recovered.frame, guide, width, height, options.amount ?? 0.17);

  let motion = null;
  let fused = edgeAligned;
  const previousGuide = options.previousGuide;
  const previousFrame = options.previousFrame;
  if (options.allowMotionCarry && !options.sceneCut && previousGuide && previousFrame) {
    motion = estimateGuideTranslation(guide, previousGuide, width, height);
    const visualChange = meanGuideDifference(guide, previousGuide, Math.ceil(blended.length / 8192));
    // Carry is intentionally tiny and disabled during meaningful local change;
    // it removes stationary shimmer without retaining visibly stale geometry.
    const carry = visualChange < 7 ? (7 - visualChange) / 7 : 0;
    fused = motionCarry(previousFrame, edgeAligned, width, height, motion, carry, guide, previousGuide);
  }

  return { frame: fused, guide, motion, detailRecovery: recovered.metrics };
}

export class DepthRenderFusion {
  constructor({ mode = 'fused' } = {}) {
    this.mode = mode === 'model' ? 'model' : 'fused';
    this.previousFrame = null;
    this.previousGuide = null;
    this.lastVideoFrameVersion = -1;
    this.alignedPairKey = '';
    this.alignedFirst = null;
    this.alignedSecond = null;
    this.alignedFrames = new Map();
    this.recoveredFirst = null;
    this.recoveredSecond = null;
    this.detailRecovery = null;
  }

  setMode(mode) {
    this.mode = mode === 'model' ? 'model' : 'fused';
    this.reset();
  }

  reset() {
    this.previousFrame = null;
    this.previousGuide = null;
    this.lastVideoFrameVersion = -1;
    this.alignedPairKey = '';
    this.alignedFirst = null;
    this.alignedSecond = null;
    this.alignedFrames.clear();
    this.recoveredFirst = null;
    this.recoveredSecond = null;
    this.detailRecovery = null;
  }

  render({
    first,
    second,
    blend,
    width,
    height,
    rgba,
    sceneCut = false,
    provisional = false,
    firstGuide = null,
    secondGuide = null,
    pairKey = '',
    firstFrameKey = '',
    secondFrameKey = '',
    evidenceAmount = 0.2,
    videoFrameVersion = 0
  }) {
    const smoothBlend = sceneCut ? 0 : clamp(Number(blend) || 0, 0, 1);
    if (videoFrameVersion === this.lastVideoFrameVersion && pairKey === this.alignedPairKey && !sceneCut && this.previousFrame) {
      return { frame: this.previousFrame, reused: true, guide: this.previousGuide, detailRecovery: this.detailRecovery };
    }
    if (pairKey !== this.alignedPairKey) {
      this.alignedPairKey = pairKey;
      if (sceneCut) {
        this.alignedFrames.clear();
        this.previousFrame = null;
        this.previousGuide = null;
      }
      this.alignedFirst = this.alignedFrames.get(firstFrameKey) || first;
      this.alignedSecond = sceneCut
        ? second
        : stabilizeDepthStatistics(second, this.alignedFirst, secondGuide, firstGuide, {
            maxScaleChange: 0.1,
            maxOffset: 0.045,
            strength: 0.66
          }).frame;
      if (firstFrameKey) this.alignedFrames.set(firstFrameKey, this.alignedFirst);
      if (!sceneCut && firstGuide && secondGuide) {
        this.alignedSecond = stabilizeDepthMotionAware(this.alignedSecond, this.alignedFirst,
          width, height, secondGuide, firstGuide).frame;
      }
      if (secondFrameKey) this.alignedFrames.set(secondFrameKey, this.alignedSecond);
      while (this.alignedFrames.size > 24) this.alignedFrames.delete(this.alignedFrames.keys().next().value);
      this.recoveredFirst = null;
      this.recoveredSecond = null;
      this.detailRecovery = null;
      // Foreground recovery already ran on the analyzed source frame. Applying
      // today's RGBA to both cached endpoints attaches masks to the wrong time.
    }
    const stableFirst = this.recoveredFirst || this.alignedFirst || first;
    const stableSecond = this.recoveredSecond || this.alignedSecond || second;
    if (this.mode === 'model') {
      const frame = blendDepthFrames(stableFirst, stableSecond, smoothBlend);
      this.previousFrame = frame;
      this.previousGuide = null;
      this.lastVideoFrameVersion = videoFrameVersion;
      return { frame, reused: false, guide: null };
    }
    const result = fuseDepthWithVideoEvidence(stableFirst, stableSecond, smoothBlend, width, height, rgba, {
      previousFrame: this.previousFrame,
      previousGuide: this.previousGuide,
      sceneCut,
      allowMotionCarry: provisional,
      amount: evidenceAmount,
      recoverForeground: false
    });
    result.detailRecovery = this.detailRecovery;
    this.previousFrame = result.frame;
    this.previousGuide = result.guide;
    this.lastVideoFrameVersion = videoFrameVersion;
    return { ...result, reused: false };
  }
}
