/** No-reference voxel conversion assessment. Scores plausibility, not accuracy. */

import { buildLumaGuide, clamp, percentileBounds } from './depth-processing.js';

function gradeFor(score) {
  if (score >= 82) return 'Excellent';
  if (score >= 70) return 'Good';
  if (score >= 55) return 'Fair';
  return 'Needs recalibration';
}

function finite01(value) {
  return clamp(Number.isFinite(value) ? value : 0, 0, 1);
}

export function scoreDepthConversion({
  frame,
  width,
  height,
  rgba = null,
  guide = null,
  previousFrame = null,
  previousGuide = null,
  sceneCut = false
}) {
  if (!frame || frame.length !== width * height || width < 3 || height < 3) return null;
  const luma = guide || buildLumaGuide(rgba, frame.length);
  const step = Math.max(1, Math.ceil(Math.sqrt(frame.length / 24000)));
  let edgeSupported = 0;
  let depthEdgeWeight = 0;
  let unsupportedEdges = 0;
  let borderExtreme = 0;
  let borderCount = 0;
  let temporalExcess = 0;
  let temporalCount = 0;
  let plateauPairs = 0;
  let pairCount = 0;

  for (let y = 1; y < height - 1; y += step) {
    for (let x = 1; x < width - 1; x += step) {
      const i = y * width + x;
      const depthGradient = Math.max(
        Math.abs(frame[i + 1] - frame[i - 1]),
        Math.abs(frame[i + width] - frame[i - width])
      );
      const imageGradient = luma ? Math.max(
        Math.abs(luma[i + 1] - luma[i - 1]),
        Math.abs(luma[i + width] - luma[i - width])
      ) / 255 : 0;
      if (depthGradient > 0.025) {
        const weight = Math.min(0.25, depthGradient);
        depthEdgeWeight += weight;
        edgeSupported += weight * clamp(imageGradient / 0.12, 0, 1);
        if (depthGradient > 0.14 && imageGradient < 0.035) unsupportedEdges += 1;
      }
      if (Math.abs(frame[i] - frame[i + 1]) < 1 / 4096) plateauPairs += 1;
      pairCount += 1;

      if (!sceneCut && previousFrame?.length === frame.length) {
        const depthChange = Math.abs(frame[i] - previousFrame[i]);
        const imageChange = luma && previousGuide?.length === luma.length
          ? Math.abs(luma[i] - previousGuide[i]) / 255
          : 0;
        temporalExcess += Math.max(0, depthChange - imageChange * 0.75 - 0.012);
        temporalCount += 1;
      }
    }
  }

  const bounds = percentileBounds(frame, 0.02, 0.98);
  const span = bounds.high - bounds.low;
  const median = (bounds.low + bounds.high) * 0.5;
  for (let x = 0; x < width; x += step) {
    for (const i of [x, (height - 1) * width + x]) {
      borderExtreme += Math.abs(frame[i] - median) > Math.max(0.22, span * 0.48) ? 1 : 0;
      borderCount += 1;
    }
  }
  for (let y = 0; y < height; y += step) {
    for (const i of [y * width, y * width + width - 1]) {
      borderExtreme += Math.abs(frame[i] - median) > Math.max(0.22, span * 0.48) ? 1 : 0;
      borderCount += 1;
    }
  }

  const alignment = luma && depthEdgeWeight > 1e-6 ? finite01(edgeSupported / depthEdgeWeight) : 0.62;
  const edgeIntegrity = finite01(1 - unsupportedEdges / Math.max(1, pairCount * 0.018));
  const temporal = temporalCount ? finite01(1 - (temporalExcess / temporalCount) / 0.055) : 0.68;
  const relief = finite01(1 - Math.abs(span - 0.48) / 0.46);
  const border = finite01(1 - borderExtreme / Math.max(1, borderCount) / 0.34);
  const terraceRatio = plateauPairs / Math.max(1, pairCount);
  const precision = finite01(1 - Math.max(0, terraceRatio - 0.32) / 0.55);
  const overall01 = (
    alignment * 0.23
    + edgeIntegrity * 0.17
    + temporal * 0.25
    + relief * 0.13
    + border * 0.14
    + precision * 0.08
  );
  const score = Math.round(overall01 * 100);
  return {
    score,
    grade: gradeFor(score),
    components: {
      edgeAlignment: Math.round(alignment * 100),
      edgeIntegrity: Math.round(edgeIntegrity * 100),
      temporalStability: Math.round(temporal * 100),
      usefulRelief: Math.round(relief * 100),
      borderIntegrity: Math.round(border * 100),
      precision: Math.round(precision * 100)
    },
    confidence: luma ? (previousFrame ? 1 : 0.78) : 0.45,
    note: 'No-reference estimate; it measures conversion consistency and image/depth agreement, not metric depth accuracy.'
  };
}

export class ConversionScoreAccumulator {
  constructor(snapshot = null) {
    this.count = Math.max(0, Number(snapshot?.count) || 0);
    this.weight = Math.max(0, Number(snapshot?.weight) || 0);
    this.total = Math.max(0, Number(snapshot?.total) || 0);
    this.componentTotals = { ...(snapshot?.componentTotals || {}) };
  }

  add(result) {
    if (!result) return this.snapshot();
    const weight = clamp(Number(result.confidence) || 0.5, 0.2, 1);
    this.count += 1;
    this.weight += weight;
    this.total += result.score * weight;
    for (const [key, value] of Object.entries(result.components || {})) {
      this.componentTotals[key] = (this.componentTotals[key] || 0) + value * weight;
    }
    return this.snapshot();
  }

  snapshot() {
    const score = this.weight ? Math.round(this.total / this.weight) : null;
    const components = {};
    for (const [key, total] of Object.entries(this.componentTotals)) {
      components[key] = this.weight ? Math.round(total / this.weight) : null;
    }
    return {
      count: this.count,
      weight: this.weight,
      total: this.total,
      componentTotals: { ...this.componentTotals },
      score,
      grade: score == null ? 'Waiting for samples' : gradeFor(score),
      confidence: finite01(this.count / 24),
      components
    };
  }
}

export function mergeConversionScoreSnapshots(...snapshots) {
  const merged = { count: 0, weight: 0, total: 0, componentTotals: {} };
  for (const snapshot of snapshots.filter(Boolean)) {
    const count = Math.max(0, Number(snapshot.count) || 0);
    const weight = Math.max(0, Number(snapshot.weight) || (snapshot.score == null ? 0 : Math.max(1, count)));
    merged.count += count;
    merged.weight += weight;
    merged.total += Math.max(0, Number(snapshot.total) || (Number(snapshot.score) || 0) * weight);
    const totals = Object.keys(snapshot.componentTotals || {}).length
      ? snapshot.componentTotals
      : Object.fromEntries(Object.entries(snapshot.components || {}).map(([key, value]) => [key, Number(value) * weight]));
    for (const [key, value] of Object.entries(totals)) {
      merged.componentTotals[key] = (merged.componentTotals[key] || 0) + (Number(value) || 0);
    }
  }
  return new ConversionScoreAccumulator(merged).snapshot();
}

/** Prefer evidence from the depth/color diagnostic actually presented. */
export function conversionScoreForSession(session = {}) {
  const rendered = mergeConversionScoreSnapshots(session.renderQualityAccumulator);
  if (rendered.count) {
    return { quality: rendered, basis: 'final rendered depth + decoded video' };
  }
  const analyzed = mergeConversionScoreSnapshots(session.qualityAccumulator, session.sharedQualityAccumulator);
  return {
    quality: analyzed,
    basis: session.sharedQualityAccumulator?.count ? 'native + shared analyzed maps' : 'native analyzed maps'
  };
}
