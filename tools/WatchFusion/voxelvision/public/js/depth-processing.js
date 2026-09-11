/**
 * Pure depth-frame processing for VoxelVision.
 *
 * The live engine owns model/runtime state. This module owns deterministic
 * numeric transforms so fidelity behavior can be tested without a browser or
 * GPU and reused by future live or cached depth backends.
 */

import { recoverForegroundDetail } from './foreground-detail-recovery.js';

export const DEPTH_CUT_THRESHOLD_01 = 52 / 255;
export const DEFAULT_DEPTH_CONDITIONING = Object.freeze({
  broadBias: Object.freeze({
    allowedSpan: 0.1,
    fullStrengthSpan: 0.44,
    maxStrength: 0.84,
    maxCorrection: 0.44
  }),
  guidance: Object.freeze({
    amount: 0.42,
    depthSigma: 0.16,
    guideSigma: 0.12,
    unsupportedJump: 0.17
  }),
  relief: Object.freeze({
    neutralTargetSpan: 0.7,
    strongBiasTargetSpan: 0.56
  })
});

export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function lerp(a, b, t) {
  return a + (b - a) * t;
}

function smoothstep01(value) {
  const t = clamp(value, 0, 1);
  return t * t * (3 - 2 * t);
}

export function fitAspectDimensions(width, height, maxEdge = 518) {
  const safeWidth = Math.max(1, Number(width) || 1);
  const safeHeight = Math.max(1, Number(height) || 1);
  const edge = Math.max(1, Math.round(Number(maxEdge) || 1));
  const scale = edge / Math.max(safeWidth, safeHeight);
  return {
    width: Math.max(1, Math.round(safeWidth * scale)),
    height: Math.max(1, Math.round(safeHeight * scale))
  };
}

export function isByteDepthFrame(frame) {
  return frame instanceof Uint8Array || frame instanceof Uint8ClampedArray;
}

function depthValue01(frame, value) {
  return isByteDepthFrame(frame) ? value / 255 : value;
}

export function invertDepthFrame(frame) {
  if (!frame) return frame;
  const byteFrame = isByteDepthFrame(frame);
  const out = byteFrame ? new Uint8Array(frame.length) : new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = byteFrame ? 255 - frame[i] : 1 - frame[i];
  return out;
}

export function blendDepthFrames(frameA, frameB, blend) {
  if (!frameA || !frameB || frameA.length !== frameB.length) return frameB || frameA || null;
  const t = smoothstep01(Number(blend) || 0);
  const scaleA = isByteDepthFrame(frameA) ? 1 / 255 : 1;
  const scaleB = isByteDepthFrame(frameB) ? 1 / 255 : 1;
  const out = new Float32Array(frameA.length);
  for (let i = 0; i < out.length; i++) {
    out[i] = lerp(Number(frameA[i]) * scaleA, Number(frameB[i]) * scaleB, t);
  }
  return out;
}

function bilinearSample(data, width, height, channels, x, y) {
  const safeChannels = Math.max(1, channels || 1);
  const x0 = clamp(Math.floor(x), 0, width - 1);
  const y0 = clamp(Math.floor(y), 0, height - 1);
  const x1 = clamp(x0 + 1, 0, width - 1);
  const y1 = clamp(y0 + 1, 0, height - 1);
  const tx = clamp(x - x0, 0, 1);
  const ty = clamp(y - y0, 0, 1);
  const a = Number(data[(y0 * width + x0) * safeChannels] ?? 0);
  const b = Number(data[(y0 * width + x1) * safeChannels] ?? a);
  const c = Number(data[(y1 * width + x0) * safeChannels] ?? a);
  const d = Number(data[(y1 * width + x1) * safeChannels] ?? c);
  return lerp(lerp(a, b, tx), lerp(c, d, tx), ty);
}

export function resampleGrayBilinear(data, srcWidth, srcHeight, channels, dstWidth, dstHeight, invert = false) {
  const out = new Float32Array(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y++) {
    const sy = ((y + 0.5) * srcHeight) / dstHeight - 0.5;
    for (let x = 0; x < dstWidth; x++) {
      const sx = ((x + 0.5) * srcWidth) / dstWidth - 0.5;
      const sampled = clamp(bilinearSample(data, srcWidth, srcHeight, channels, sx, sy) / 255, 0, 1);
      out[y * dstWidth + x] = invert ? 1 - sampled : sampled;
    }
  }
  return out;
}

export function resampleFloatBilinear(data, srcWidth, srcHeight, dstWidth, dstHeight) {
  const out = new Float32Array(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y++) {
    const sy = ((y + 0.5) * srcHeight) / dstHeight - 0.5;
    for (let x = 0; x < dstWidth; x++) {
      const sx = ((x + 0.5) * srcWidth) / dstWidth - 0.5;
      out[y * dstWidth + x] = bilinearSample(data, srcWidth, srcHeight, 1, sx, sy);
    }
  }
  return out;
}

export function resampleFloatBilinearRegion(
  data,
  srcWidth,
  srcHeight,
  regionX,
  regionY,
  regionWidth,
  regionHeight,
  dstWidth,
  dstHeight
) {
  const safeX = clamp(Number(regionX) || 0, 0, Math.max(0, srcWidth - 1));
  const safeY = clamp(Number(regionY) || 0, 0, Math.max(0, srcHeight - 1));
  const safeWidth = clamp(Number(regionWidth) || srcWidth, 1, srcWidth - safeX);
  const safeHeight = clamp(Number(regionHeight) || srcHeight, 1, srcHeight - safeY);
  const out = new Float32Array(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y++) {
    const sy = safeY + ((y + 0.5) * safeHeight) / dstHeight - 0.5;
    for (let x = 0; x < dstWidth; x++) {
      const sx = safeX + ((x + 0.5) * safeWidth) / dstWidth - 0.5;
      out[y * dstWidth + x] = bilinearSample(data, srcWidth, srcHeight, 1, sx, sy);
    }
  }
  return out;
}

export function percentileBounds(values, lowPercent = 0.02, highPercent = 0.98) {
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    if (value < min) min = value;
    if (value > max) max = value;
  }

  if (!Number.isFinite(min) || !Number.isFinite(max) || max - min < 1e-8) {
    return { low: Number.isFinite(min) ? min : 0, high: Number.isFinite(max) ? max : 1 };
  }

  const bins = new Uint32Array(512);
  const scale = (bins.length - 1) / (max - min);
  let count = 0;
  for (let i = 0; i < values.length; i++) {
    const value = values[i];
    if (!Number.isFinite(value)) continue;
    bins[clamp(Math.round((value - min) * scale), 0, bins.length - 1)] += 1;
    count += 1;
  }

  const lowTarget = Math.max(0, Math.floor(count * lowPercent));
  const highTarget = Math.max(lowTarget + 1, Math.floor(count * highPercent));
  let cumulative = 0;
  let lowBin = 0;
  let highBin = bins.length - 1;
  for (let i = 0; i < bins.length; i++) {
    cumulative += bins[i];
    if (cumulative >= lowTarget) {
      lowBin = i;
      break;
    }
  }
  cumulative = 0;
  for (let i = 0; i < bins.length; i++) {
    cumulative += bins[i];
    if (cumulative >= highTarget) {
      highBin = i;
      break;
    }
  }

  const low = min + (lowBin / (bins.length - 1)) * (max - min);
  const high = min + (highBin / (bins.length - 1)) * (max - min);
  return high - low > 1e-8 ? { low, high } : { low: min, high: max };
}

function softKneeCompress(norm01, knee = 0.65, ceiling = 0.86) {
  if (norm01 <= knee) return norm01;
  const excess = (norm01 - knee) / Math.max(1e-6, 1 - knee);
  return knee + (ceiling - knee) * (1 - Math.exp(-excess * 1.65));
}

export function normalizeFloatDepth(values, low, high, { knee = 0.65, ceiling = 0.86 } = {}) {
  const out = new Float32Array(values.length);
  const range = Math.max(1e-8, high - low);
  for (let i = 0; i < values.length; i++) {
    const value = Number.isFinite(values[i]) ? values[i] : low;
    out[i] = softKneeCompress(clamp((value - low) / range, 0, 1), knee, ceiling);
  }
  return out;
}

function meanAbsoluteDifference(a, b) {
  if (!a || !b || a.length !== b.length || !a.length) return 0;
  const stride = Math.max(1, Math.floor(a.length / 4096));
  let sum = 0;
  let count = 0;
  for (let i = 0; i < a.length; i += stride) {
    sum += Math.abs(a[i] - b[i]);
    count += 1;
  }
  return count ? sum / count : 0;
}

/**
 * Smooth percentile bounds without making the sculpture breathe in and out.
 * Newly exposed depth range is accepted quickly, while contraction waits for
 * repeated evidence so a person moving slightly cannot rescale the full panel.
 */
export function stabilizeRangeBounds(
  previousLow,
  previousHigh,
  currentLow,
  currentHigh,
  { expandAlpha = 0.34, contractAlpha = 0.075 } = {}
) {
  if (![previousLow, previousHigh, currentLow, currentHigh].every(Number.isFinite)) {
    return { low: currentLow, high: currentHigh };
  }
  const lowAlpha = currentLow < previousLow ? expandAlpha : contractAlpha;
  const highAlpha = currentHigh > previousHigh ? expandAlpha : contractAlpha;
  const low = lerp(previousLow, currentLow, lowAlpha);
  const high = lerp(previousHigh, currentHigh, highAlpha);
  return high > low + 1e-8 ? { low, high } : { low: currentLow, high: currentHigh };
}

function sampledQuantiles(values) {
  const stride = Math.max(1, Math.floor(values.length / 8192));
  const sample = [];
  for (let i = 0; i < values.length; i += stride) {
    const value = Number(values[i]);
    if (Number.isFinite(value)) sample.push(value);
  }
  sample.sort((a, b) => a - b);
  const at = q => sample[Math.min(sample.length - 1, Math.max(0, Math.round((sample.length - 1) * q)))] || 0;
  return { low: at(0.1), median: at(0.5), high: at(0.9) };
}

/**
 * Align only the broad median/span of neighboring predictions. Local shape is
 * left intact; this suppresses frame-wide height pumping from relative-depth
 * normalization without pretending that monocular depth is metric depth.
 */
export function stabilizeDepthStatistics(
  current,
  previous,
  currentGuide = null,
  previousGuide = null,
  { maxScaleChange = 0.12, maxOffset = 0.055, strength = 0.64 } = {}
) {
  if (!(current instanceof Float32Array) || !previous || previous.length !== current.length) {
    return { frame: current, metrics: { scale: 1, offset: 0, strength: 0, visualDifference: 0 } };
  }
  const visualDifference = currentGuide && previousGuide && currentGuide.length === previousGuide.length
    ? meanAbsoluteDifference(currentGuide, previousGuide)
    : 0;
  const stillness = 1 - smoothstep01((visualDifference - 3) / 42);
  const appliedStrength = clamp(strength * stillness, 0, 1);
  if (appliedStrength < 1e-4) {
    return { frame: current, metrics: { scale: 1, offset: 0, strength: 0, visualDifference } };
  }

  const now = sampledQuantiles(current);
  const before = sampledQuantiles(previous);
  const nowSpan = Math.max(1e-5, now.high - now.low);
  const previousSpan = Math.max(1e-5, before.high - before.low);
  const targetScale = clamp(previousSpan / nowSpan, 1 - maxScaleChange, 1 + maxScaleChange);
  const scale = lerp(1, targetScale, appliedStrength);
  const offset = clamp((before.median - now.median) * appliedStrength, -maxOffset, maxOffset);
  const out = new Float32Array(current.length);
  for (let i = 0; i < current.length; i++) {
    out[i] = clamp(now.median + (current[i] - now.median) * scale + offset, 0, 1);
  }
  return { frame: out, metrics: { scale, offset, strength: appliedStrength, visualDifference } };
}

/** Estimate a small global camera translation from luma guides. */
export function estimateGuideTranslation(currentGuide, previousGuide, width, height) {
  if (
    !currentGuide || !previousGuide || currentGuide.length !== previousGuide.length
    || currentGuide.length !== width * height || width < 8 || height < 8
  ) {
    return { x: 0, y: 0, confidence: 0, score: Infinity };
  }
  const maxX = clamp(Math.round(width * 0.018), 1, 8);
  const maxY = clamp(Math.round(height * 0.018), 1, 6);
  const sampleStep = Math.max(1, Math.ceil(Math.sqrt((width * height) / 4096)));
  const scoreShift = (dx, dy) => {
    let score = 0;
    let count = 0;
    const x0 = Math.max(maxX, -dx);
    const x1 = Math.min(width - maxX, width - dx);
    const y0 = Math.max(maxY, -dy);
    const y1 = Math.min(height - maxY, height - dy);
    for (let y = y0; y < y1; y += sampleStep) {
      for (let x = x0; x < x1; x += sampleStep) {
        score += Math.abs(currentGuide[y * width + x] - previousGuide[(y + dy) * width + x + dx]);
        count += 1;
      }
    }
    return count ? score / count : Infinity;
  };

  const zeroScore = scoreShift(0, 0);
  let bestScore = zeroScore;
  let bestX = 0;
  let bestY = 0;
  for (let dy = -maxY; dy <= maxY; dy++) {
    for (let dx = -maxX; dx <= maxX; dx++) {
      if (dx === 0 && dy === 0) continue;
      const score = scoreShift(dx, dy);
      if (score < bestScore) {
        bestScore = score;
        bestX = dx;
        bestY = dy;
      }
    }
  }
  const improvement = zeroScore > 1e-5 ? (zeroScore - bestScore) / zeroScore : 0;
  const confidence = bestScore < 48 ? smoothstep01((improvement - 0.025) / 0.18) : 0;
  if (confidence < 0.08) return { x: 0, y: 0, confidence: 0, score: zeroScore };
  return { x: bestX, y: bestY, confidence, score: bestScore };
}

export function buildLumaGuide(rgba, cells) {
  if (!rgba || !Number.isInteger(cells) || cells < 1 || rgba.length < cells * 4) return null;
  const guide = new Uint8Array(cells);
  for (let i = 0; i < cells; i++) {
    const src = i * 4;
    guide[i] = Math.round(rgba[src] * 0.299 + rgba[src + 1] * 0.587 + rgba[src + 2] * 0.114);
  }
  return guide;
}

export function detectLiveSceneCut(currentDepth, previousDepth, currentGuide = null, previousGuide = null) {
  if (!previousDepth || previousDepth.length !== currentDepth?.length) {
    return { isSceneCut: true, depthDifference: 0, normalizedDepthDifference: 0, visualDifference: 0 };
  }
  const depthDifference = meanAbsoluteDifference(currentDepth, previousDepth);
  const depthScale = isByteDepthFrame(currentDepth) || isByteDepthFrame(previousDepth) ? 255 : 1;
  const normalizedDepthDifference = depthDifference / depthScale;
  const visualDifference = currentGuide && previousGuide && currentGuide.length === previousGuide.length
    ? meanAbsoluteDifference(currentGuide, previousGuide)
    : 0;
  return {
    isSceneCut: normalizedDepthDifference > DEPTH_CUT_THRESHOLD_01 || visualDifference > 58,
    depthDifference,
    normalizedDepthDifference,
    visualDifference
  };
}

export function stabilizeDepthMotionAware(
  current,
  previous,
  width,
  height,
  currentGuide = null,
  previousGuide = null,
  options = {}
) {
  if (!previous || previous.length !== current.length) {
    return { frame: current, motion: { x: 0, y: 0, confidence: 0, score: Infinity } };
  }
  const byteFrame = isByteDepthFrame(current);
  const out = byteFrame ? new Uint8Array(current.length) : new Float32Array(current.length);
  const hasGuidance = currentGuide
    && previousGuide
    && currentGuide.length === current.length
    && previousGuide.length === current.length;
  const hasDimensions = Number.isInteger(width) && Number.isInteger(height) && width * height === current.length;
  const motion = hasGuidance && hasDimensions
    ? estimateGuideTranslation(currentGuide, previousGuide, width, height)
    : { x: 0, y: 0, confidence: 0, score: Infinity };

  for (let i = 0; i < current.length; i++) {
    const now = current[i];
    const x = hasDimensions ? i % width : 0;
    const y = hasDimensions ? Math.floor(i / width) : 0;
    const previousX = hasDimensions ? clamp(x + motion.x * motion.confidence, 0, width - 1) : 0;
    const previousY = hasDimensions ? clamp(y + motion.y * motion.confidence, 0, height - 1) : 0;
    const previousIndex = hasDimensions
      ? clamp(Math.round(previousY) * width + Math.round(previousX), 0, previous.length - 1)
      : i;
    const prev = hasDimensions
      ? bilinearSample(previous, width, height, 1, previousX, previousY)
      : previous[i];
    const diff01 = Math.abs(depthValue01(current, now) - depthValue01(previous, prev));
    let currentWeight = diff01 < 10 / 255 ? 0.4 : diff01 < 28 / 255 ? 0.64 : 0.9;
    if (hasGuidance) {
      // Screen-stationary detail must not follow the global camera estimate.
      // Require a matching neighborhood so coincidentally equal flat pixels
      // cannot preserve a moving object's old silhouette.
      let stationary = Math.abs(currentGuide[i] - previousGuide[i]) <= 3;
      if (stationary && hasDimensions) {
        for (const offset of [-width, -1, 1, width]) {
          const j = i + offset;
          if (j >= 0 && j < current.length && Math.abs(currentGuide[j] - previousGuide[j]) > 6) stationary = false;
        }
      }
      if (stationary && hasDimensions && !byteFrame) {
        // Stable appearance is evidence for correspondence, not proof that an
        // earlier height was correct. Let persistent new model evidence converge.
        const difference = Math.abs(now - previous[i]);
        const confirmedForeground = options.trustedForeground?.[i] >= 96;
        const weight = now > previous[i]
          ? (confirmedForeground ? 0.22 : 0.035)
          : difference < 0.12 ? 0.08 : difference < 0.3 ? 0.22 : 0.55;
        out[i] = previous[i] + (now - previous[i]) * weight;
        continue;
      }
      const visualMotion = Math.abs(currentGuide[i] - previousGuide[previousIndex]);
      if (visualMotion > 44) currentWeight = Math.max(currentWeight, 0.96);
      else if (visualMotion > 20) currentWeight = Math.max(currentWeight, 0.86);
      else if (visualMotion > 8) currentWeight = Math.max(currentWeight, 0.72);
    }
    const value = prev + (now - prev) * currentWeight;
    out[i] = byteFrame ? Math.round(value) : value;
  }
  return { frame: out, motion };
}

export function stabilizeDepth(current, previous, currentGuide = null, previousGuide = null, width = null, height = null) {
  return stabilizeDepthMotionAware(current, previous, width, height, currentGuide, previousGuide).frame;
}

function sampledMedian(values, stride = 1) {
  const sampled = [];
  for (let i = 0; i < values.length; i += Math.max(1, stride)) {
    if (Number.isFinite(values[i])) sampled.push(values[i]);
  }
  if (!sampled.length) return 0;
  sampled.sort((a, b) => a - b);
  const middle = Math.floor(sampled.length / 2);
  return sampled.length % 2 ? sampled[middle] : (sampled[middle - 1] + sampled[middle]) * 0.5;
}

function buildAxisProfile(frame, width, height, axis) {
  const length = axis === 'x' ? width : height;
  const crossLength = axis === 'x' ? height : width;
  const crossStride = Math.max(1, Math.floor(crossLength / 96));
  const samples = new Float32Array(Math.ceil(crossLength / crossStride));
  const profile = new Float32Array(length);

  for (let position = 0; position < length; position++) {
    let count = 0;
    for (let cross = 0; cross < crossLength; cross += crossStride) {
      samples[count++] = axis === 'x'
        ? frame[cross * width + position]
        : frame[position * width + cross];
    }
    profile[position] = sampledMedian(samples.subarray(0, count));
  }
  return profile;
}

function smoothProfile(profile, radius) {
  if (radius < 1 || profile.length < 3) return profile;
  const prefix = new Float64Array(profile.length + 1);
  for (let i = 0; i < profile.length; i++) prefix[i + 1] = prefix[i] + profile[i];
  const out = new Float32Array(profile.length);
  for (let i = 0; i < profile.length; i++) {
    const start = Math.max(0, i - radius);
    const end = Math.min(profile.length, i + radius + 1);
    out[i] = (prefix[end] - prefix[start]) / (end - start);
  }
  return out;
}

function profileStats(profile) {
  const sorted = Array.from(profile).sort((a, b) => a - b);
  const at = q => sorted[Math.min(sorted.length - 1, Math.max(0, Math.floor((sorted.length - 1) * q)))] || 0;
  const low = at(0.1);
  const median = at(0.5);
  const high = at(0.9);
  return { low, median, high, span: high - low };
}

function profileCorrelation(a, b) {
  if (!a || !b || a.length !== b.length || a.length < 2) return 0;
  let meanA = 0;
  let meanB = 0;
  for (let i = 0; i < a.length; i++) {
    meanA += a[i];
    meanB += b[i];
  }
  meanA /= a.length;
  meanB /= b.length;
  let covariance = 0;
  let varianceA = 0;
  let varianceB = 0;
  for (let i = 0; i < a.length; i++) {
    const da = a[i] - meanA;
    const db = b[i] - meanB;
    covariance += da * db;
    varianceA += da * da;
    varianceB += db * db;
  }
  const denominator = Math.sqrt(varianceA * varianceB);
  return denominator > 1e-8 ? covariance / denominator : 0;
}

function guideAsFloat(guidance) {
  if (!guidance) return null;
  const out = new Float32Array(guidance.length);
  for (let i = 0; i < guidance.length; i++) out[i] = guidance[i] / 255;
  return out;
}

export function correctBroadDepthBias(
  frame,
  width,
  height,
  guidance = null,
  { allowedSpan = 0.14, fullStrengthSpan = 0.52, maxStrength = 0.78, maxCorrection = 0.38 } = {}
) {
  if (!(frame instanceof Float32Array) || frame.length !== width * height || width < 4 || height < 4) {
    return { frame, metrics: { xSpan: 0, ySpan: 0, xStrength: 0, yStrength: 0 } };
  }

  const xProfile = smoothProfile(buildAxisProfile(frame, width, height, 'x'), Math.max(1, Math.round(width * 0.06)));
  const yProfile = smoothProfile(buildAxisProfile(frame, width, height, 'y'), Math.max(1, Math.round(height * 0.06)));
  const xStats = profileStats(xProfile);
  const yStats = profileStats(yProfile);

  let xCorrelation = 0;
  let yCorrelation = 0;
  if (guidance?.length === frame.length) {
    const guide = guideAsFloat(guidance);
    const guideX = smoothProfile(buildAxisProfile(guide, width, height, 'x'), Math.max(1, Math.round(width * 0.06)));
    const guideY = smoothProfile(buildAxisProfile(guide, width, height, 'y'), Math.max(1, Math.round(height * 0.06)));
    xCorrelation = Math.abs(profileCorrelation(xProfile, guideX));
    yCorrelation = Math.abs(profileCorrelation(yProfile, guideY));
  }

  const axisStrength = (span, correlation) => {
    const activation = smoothstep01((span - allowedSpan) / Math.max(1e-6, fullStrengthSpan - allowedSpan));
    const visualPreservation = correlation > 0.72 ? 0.58 : correlation > 0.5 ? 0.78 : 1;
    return maxStrength * activation * visualPreservation;
  };
  const xStrength = axisStrength(xStats.span, xCorrelation);
  const yStrength = axisStrength(yStats.span, yCorrelation);
  if (xStrength < 1e-5 && yStrength < 1e-5) {
    return {
      frame,
      metrics: { xSpan: xStats.span, ySpan: yStats.span, xStrength, yStrength, xCorrelation, yCorrelation }
    };
  }

  const out = new Float32Array(frame.length);
  for (let y = 0; y < height; y++) {
    const yCorrection = (yProfile[y] - yStats.median) * yStrength;
    const row = y * width;
    for (let x = 0; x < width; x++) {
      const xCorrection = (xProfile[x] - xStats.median) * xStrength;
      const correction = clamp(xCorrection + yCorrection, -maxCorrection, maxCorrection);
      out[row + x] = clamp(frame[row + x] - correction, 0, 1);
    }
  }
  return {
    frame: out,
    metrics: { xSpan: xStats.span, ySpan: yStats.span, xStrength, yStrength, xCorrelation, yCorrelation }
  };
}

// Compatibility facade for v1.3.1 callers and tests.
export function limitGlobalDepthTilt(frame, width, height, options = {}) {
  const maxSlope = Number(options.maxSlope);
  const strength = Number(options.strength);
  return correctBroadDepthBias(frame, width, height, null, {
    allowedSpan: Number.isFinite(maxSlope) ? maxSlope : 0.14,
    maxStrength: Number.isFinite(strength) ? clamp(strength, 0, 1) : 0.78
  }).frame;
}

function regionStats(frame, width, x0, x1, y0, y1, scale = 1) {
  let sum = 0;
  let sumSq = 0;
  let count = 0;
  for (let y = y0; y < y1; y++) {
    const row = y * width;
    for (let x = x0; x < x1; x++) {
      const value = frame[row + x] * scale;
      sum += value;
      sumSq += value * value;
      count += 1;
    }
  }
  const mean = count ? sum / count : 0;
  return { mean, std: Math.sqrt(count ? Math.max(0, sumSq / count - mean * mean) : 0) };
}

function repairBorderSide(frame, width, height, side, guidance, globalBounds) {
  const horizontal = side === 'top' || side === 'bottom';
  const edgeLength = horizontal ? width : height;
  const shortEdge = Math.min(width, height);
  const thickness = clamp(Math.round(shortEdge * 0.025), 2, 10);
  const segmentLength = clamp(Math.round(edgeLength / 10), thickness * 4, 72);
  const globalSpan = Math.max(0.08, globalBounds.high - globalBounds.low);
  const baseDelta = Math.max(0.1, globalSpan * 0.2);
  let out = frame;
  let repairedSegments = 0;

  for (let start = 0; start < edgeLength; start += segmentLength) {
    const end = Math.min(edgeLength, start + segmentLength);
    let borderRect;
    let interiorRect;
    if (side === 'top') {
      borderRect = [start, end, 0, thickness];
      interiorRect = [start, end, thickness, Math.min(height, thickness * 2)];
    } else if (side === 'bottom') {
      borderRect = [start, end, height - thickness, height];
      interiorRect = [start, end, Math.max(0, height - thickness * 2), height - thickness];
    } else if (side === 'left') {
      borderRect = [0, thickness, start, end];
      interiorRect = [thickness, Math.min(width, thickness * 2), start, end];
    } else {
      borderRect = [width - thickness, width, start, end];
      interiorRect = [Math.max(0, width - thickness * 2), width - thickness, start, end];
    }

    const border = regionStats(frame, width, ...borderRect);
    const interior = regionStats(frame, width, ...interiorRect);
    const delta = border.mean - interior.mean;
    const extremeMargin = globalSpan * 0.12;
    const extreme = border.mean <= globalBounds.low + extremeMargin
      || border.mean >= globalBounds.high - extremeMargin;
    const uniform = border.std < Math.max(0.018, Math.min(0.055, interior.std * 0.72 + 0.012));

    let visualSupport = false;
    if (guidance?.length === frame.length) {
      const borderGuide = regionStats(guidance, width, ...borderRect, 1 / 255);
      const interiorGuide = regionStats(guidance, width, ...interiorRect, 1 / 255);
      visualSupport = Math.abs(borderGuide.mean - interiorGuide.mean) > 0.16 && borderGuide.std > 0.035;
    }
    const requiredDelta = baseDelta * (visualSupport ? 1.45 : 1);
    if (!extreme || !uniform || Math.abs(delta) < requiredDelta) continue;

    if (out === frame) out = new Float32Array(frame);
    const strength = clamp(0.38 + (Math.abs(delta) - requiredDelta) / Math.max(0.08, globalSpan * 0.45), 0.38, visualSupport ? 0.68 : 0.9);
    for (let position = start; position < end; position++) {
      for (let offset = 0; offset < thickness; offset++) {
        let x;
        let y;
        let referenceX;
        let referenceY;
        if (side === 'top') {
          x = position; y = offset; referenceX = x; referenceY = thickness;
        } else if (side === 'bottom') {
          x = position; y = height - 1 - offset; referenceX = x; referenceY = height - thickness - 1;
        } else if (side === 'left') {
          x = offset; y = position; referenceX = thickness; referenceY = y;
        } else {
          x = width - 1 - offset; y = position; referenceX = width - thickness - 1; referenceY = y;
        }
        const edgeWeight = smoothstep01((thickness - offset) / thickness);
        const idx = y * width + x;
        const reference = frame[referenceY * width + referenceX];
        out[idx] = lerp(frame[idx], reference, strength * edgeWeight);
      }
    }
    repairedSegments += 1;
  }
  return { frame: out, repairedSegments };
}

export function repairDepthBorders(frame, width, height, guidance = null) {
  if (!(frame instanceof Float32Array) || frame.length !== width * height || width < 8 || height < 8) {
    return { frame, metrics: { repairedSegments: 0, sides: {} } };
  }
  const globalBounds = percentileBounds(frame, 0.04, 0.96);
  let repaired = frame;
  const sides = {};
  let repairedSegments = 0;
  for (const side of ['top', 'bottom', 'left', 'right']) {
    const result = repairBorderSide(repaired, width, height, side, guidance, globalBounds);
    repaired = result.frame;
    sides[side] = result.repairedSegments;
    repairedSegments += result.repairedSegments;
  }
  return { frame: repaired, metrics: { repairedSegments, sides } };
}

export function repairSuspiciousBorders(frame, width, height, guidance = null) {
  return repairDepthBorders(frame, width, height, guidance).frame;
}

const filterKernelCache = new Map();

function gaussianLut(size, sigma) {
  const key = `${size}:${sigma}`;
  if (filterKernelCache.has(key)) return filterKernelCache.get(key);
  const lut = new Float32Array(size + 1);
  for (let i = 0; i <= size; i++) {
    const value = i / size;
    lut[i] = Math.exp(-(value * value) / (2 * sigma * sigma));
  }
  filterKernelCache.set(key, lut);
  return lut;
}

export function refineDepthWithGuidance(
  frame,
  width,
  height,
  guidance = null,
  { amount = 0.42, depthSigma = 0.16, guideSigma = 0.12, unsupportedJump = 0.17 } = {}
) {
  if (!(frame instanceof Float32Array) || frame.length !== width * height || width < 3 || height < 3) return frame;
  const depthLut = gaussianLut(1024, depthSigma);
  const guideLut = gaussianLut(255, guideSigma);
  const hasGuide = guidance?.length === frame.length;
  const out = new Float32Array(frame.length);

  for (let y = 0; y < height; y++) {
    const y0 = Math.max(0, y - 1);
    const y1 = Math.min(height - 1, y + 1);
    for (let x = 0; x < width; x++) {
      const x0 = Math.max(0, x - 1);
      const x1 = Math.min(width - 1, x + 1);
      const idx = y * width + x;
      const center = frame[idx];
      const centerGuide = hasGuide ? guidance[idx] : 0;
      let weighted = 0;
      let weightSum = 0;
      let maxGuideDelta = 0;

      for (let ny = y0; ny <= y1; ny++) {
        const row = ny * width;
        for (let nx = x0; nx <= x1; nx++) {
          const neighborIdx = row + nx;
          const neighbor = frame[neighborIdx];
          const depthIndex = Math.round(clamp(Math.abs(neighbor - center), 0, 1) * 1024);
          const guideDelta = hasGuide ? Math.abs(guidance[neighborIdx] - centerGuide) : 0;
          if (guideDelta > maxGuideDelta) maxGuideDelta = guideDelta;
          const spatial = nx === x && ny === y ? 1 : (nx === x || ny === y ? 0.72 : 0.52);
          const weight = spatial * depthLut[depthIndex] * (hasGuide ? guideLut[guideDelta] : 1);
          weighted += neighbor * weight;
          weightSum += weight;
        }
      }

      let filtered = weightSum > 0 ? weighted / weightSum : center;
      if (Math.abs(center - filtered) > unsupportedJump && maxGuideDelta < 24) {
        filtered = center - Math.sign(center - filtered) * unsupportedJump;
      }
      out[idx] = clamp(lerp(center, filtered, amount), 0, 1);
    }
  }
  return out;
}

function compressReliefSpan(
  frame,
  broadMetrics,
  { neutralTargetSpan = 0.7, strongBiasTargetSpan = 0.56 } = {}
) {
  const bounds = percentileBounds(frame, 0.02, 0.98);
  const span = Math.max(1e-6, bounds.high - bounds.low);
  const correctionStrength = Math.max(broadMetrics.xStrength || 0, broadMetrics.yStrength || 0);
  const targetSpan = lerp(
    neutralTargetSpan,
    strongBiasTargetSpan,
    clamp(correctionStrength / DEFAULT_DEPTH_CONDITIONING.broadBias.maxStrength, 0, 1)
  );
  if (span <= targetSpan) return { frame, inputSpan: span, outputSpan: span, targetSpan };
  const center = sampledMedian(frame, Math.max(1, Math.floor(frame.length / 8192)));
  const scale = targetSpan / span;
  const out = new Float32Array(frame.length);
  for (let i = 0; i < frame.length; i++) out[i] = clamp(center + (frame[i] - center) * scale, 0, 1);
  return { frame: out, inputSpan: span, outputSpan: targetSpan, targetSpan };
}

export function conditionDepthFrame(frame, width, height, guidance = null, options = {}) {
  const broad = correctBroadDepthBias(
    frame,
    width,
    height,
    guidance,
    options.broadBias || DEFAULT_DEPTH_CONDITIONING.broadBias
  );
  const borders = repairDepthBorders(broad.frame, width, height, guidance);
  const compressed = compressReliefSpan(
    borders.frame,
    broad.metrics,
    options.relief || DEFAULT_DEPTH_CONDITIONING.relief
  );
  const refined = refineDepthWithGuidance(
    compressed.frame,
    width,
    height,
    guidance,
    options.guidance || DEFAULT_DEPTH_CONDITIONING.guidance
  );
  // Independently bounded corrections can still add up to a fabricated ridge.
  // Budget the combined non-semantic displacement against the model signal.
  const evidenceBounded = new Float32Array(refined.length);
  const correctionBudget = options.correctionBudget ?? 0.12;
  let budgetedPixels = 0;
  for (let i = 0; i < refined.length; i++) {
    const delta = refined[i] - frame[i];
    evidenceBounded[i] = frame[i] + clamp(delta, -correctionBudget, correctionBudget);
    if (Math.abs(delta) > correctionBudget) budgetedPixels++;
  }
  const foreground = recoverForegroundDetail(
    evidenceBounded,
    width,
    height,
    options.colorGuidance,
    options.foregroundDetail
  );
  // Color-only region growth is still a heuristic, so it shares the same
  // displacement budget. Only independent mask + depth-anchor evidence can
  // justify the larger correction needed for a missed foreground component.
  let final = foreground.frame;
  if (!options.foregroundDetail?.semanticMask) {
    final = Float32Array.from(final, (value, i) => frame[i] + clamp(value - frame[i], -correctionBudget, correctionBudget));
  }
  return {
    frame: final,
    corrected: compressed.frame,
    metrics: {
      correctionBudget: { maximum: correctionBudget, limitedPixels: budgetedPixels },
      broadBias: broad.metrics,
      borders: borders.metrics,
      relief: {
        inputSpan: compressed.inputSpan,
        outputSpan: compressed.outputSpan,
        targetSpan: compressed.targetSpan
      },
      foregroundDetail: foreground.metrics
    }
  };
}

export function smoothFloatDepth(frame, width, height, sigmaSpace = 1.2, sigmaRange = 0.11) {
  if (!(frame instanceof Float32Array) || width < 3 || height < 3) return frame;
  const range = gaussianLut(1024, sigmaRange);
  const out = new Float32Array(frame.length);
  const cornerWeight = Math.exp(-2 / (2 * sigmaSpace * sigmaSpace));
  const edgeWeight = Math.exp(-1 / (2 * sigmaSpace * sigmaSpace));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      const center = frame[idx];
      let sum = 0;
      let total = 0;
      for (let ny = Math.max(0, y - 1); ny <= Math.min(height - 1, y + 1); ny++) {
        for (let nx = Math.max(0, x - 1); nx <= Math.min(width - 1, x + 1); nx++) {
          const value = frame[ny * width + nx];
          const diagonal = nx !== x && ny !== y;
          const spatial = nx === x && ny === y ? 1 : diagonal ? cornerWeight : edgeWeight;
          const rangeWeight = range[Math.round(clamp(Math.abs(value - center), 0, 1) * 1024)];
          const weight = spatial * rangeWeight;
          sum += value * weight;
          total += weight;
        }
      }
      out[idx] = total > 0 ? sum / total : center;
    }
  }
  return out;
}

export function depthFrameToRgba(frame, { normalize = false } = {}) {
  if (!frame) return null;
  const rgba = new Uint8ClampedArray(frame.length * 4);
  let low = 0;
  let high = isByteDepthFrame(frame) ? 255 : 1;
  if (normalize) {
    const bounds = percentileBounds(frame, 0.02, 0.98);
    low = bounds.low;
    high = bounds.high;
  }
  const range = Math.max(1e-8, high - low);
  for (let i = 0; i < frame.length; i++) {
    const value = clamp((Number(frame[i]) - low) / range, 0, 1);
    const byte = Math.round(value * 255);
    const dst = i * 4;
    rgba[dst] = byte;
    rgba[dst + 1] = byte;
    rgba[dst + 2] = byte;
    rgba[dst + 3] = 255;
  }
  return rgba;
}
