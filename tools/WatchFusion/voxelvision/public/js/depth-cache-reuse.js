/** Lazy reuse plans for depth frames produced from the same source/model. */

import { dequantizeDepth16 } from './depth-cache-codec.js';
import {
  blendDepthFrames,
  resampleFloatBilinear,
  stabilizeDepthStatistics
} from './depth-processing.js';
import { descriptorConversionMode } from './depth-conversion-mode.js';
import { canonicalMediaIdentity } from './youtube-source.js';

const PROFILE_KEYS = ['pipeline', 'sourceWidth', 'sourceHeight', 'model', 'backend', 'precision', 'invert'];

export function descriptorsShareDepthTimeline(target = {}, donor = {}) {
  return PROFILE_KEYS.every(key => target[key] === donor[key])
    && canonicalMediaIdentity(target.source) === canonicalMediaIdentity(donor.source)
    && (target.foregroundAssist || null) === (donor.foregroundAssist || null)
    && descriptorConversionMode(target) === descriptorConversionMode(donor)
    && Math.abs(Number(target.durationMs || 0) - Number(donor.durationMs || 0)) <= 1000;
}

function donorRank(target, session) {
  const descriptor = session.descriptor || {};
  const targetCells = Math.max(1, Number(target.cols) * Number(target.rows));
  const donorCells = Math.max(1, Number(descriptor.cols) * Number(descriptor.rows));
  const nativeDetail = donorCells >= targetCells ? 1 : 0;
  const nativeRate = Number(descriptor.fps) >= Number(target.fps) ? 1 : 0;
  const quality = Number(session.qualityAccumulator?.score) || 0;
  return nativeDetail * 1e9 + nativeRate * 1e8 + donorCells * 100 + Number(descriptor.fps || 0) * 10 + quality;
}

function bracketForTime(indices, time, fps) {
  if (!indices?.length) return null;
  const wanted = Math.max(0, time * fps);
  let low = 0;
  let high = indices.length - 1;
  while (low <= high) {
    const mid = (low + high) >> 1;
    if (indices[mid] < wanted) low = mid + 1;
    else high = mid - 1;
  }
  const after = indices[Math.min(indices.length - 1, low)];
  const before = indices[Math.max(0, low - 1)];
  if (before == null && after == null) return null;
  const firstIndex = before == null ? after : before;
  const secondIndex = after == null ? firstIndex : after;
  const firstTime = firstIndex / fps;
  const secondTime = secondIndex / fps;
  if (Math.abs(time - secondTime) < 1e-6) {
    return { firstIndex: secondIndex, secondIndex, blend: 0, distance: 0, exact: true };
  }
  if (Math.abs(time - firstTime) < 1e-6) {
    return { firstIndex, secondIndex: firstIndex, blend: 0, distance: 0, exact: true };
  }
  if (secondTime - firstTime > 2.25 / fps) {
    const nearest = Math.abs(time - firstTime) <= Math.abs(secondTime - time) ? firstIndex : secondIndex;
    return { firstIndex: nearest, secondIndex: nearest, blend: 0, distance: Math.abs(time - nearest / fps), exact: false };
  }
  const blend = secondTime > firstTime ? (time - firstTime) / (secondTime - firstTime) : 0;
  return {
    firstIndex,
    secondIndex,
    blend: Math.min(1, Math.max(0, blend)),
    distance: Math.min(Math.abs(time - firstTime), Math.abs(secondTime - time)),
    exact: false
  };
}

/**
 * Map every missing target timestamp to the best available compatible cache.
 * The plan stores references only; it never duplicates persistent frame blobs.
 */
export function buildDepthReusePlans({ target, targetFrameCount, sessions, indicesByCacheId, exactIndices = new Set() }) {
  const donors = (sessions || [])
    .filter(session => session?.id && descriptorsShareDepthTimeline(target, session.descriptor || {}))
    .map(session => ({
      session,
      descriptor: session.descriptor || {},
      indices: [...(indicesByCacheId.get(session.id) || [])].map(Number).sort((a, b) => a - b),
      rank: donorRank(target, session)
    }))
    .filter(donor => donor.indices.length)
    .sort((a, b) => b.rank - a.rank);

  const plans = new Map();
  for (let index = 0; index < targetFrameCount; index++) {
    if (exactIndices.has(index)) continue;
    const time = index / Math.max(1, Number(target.fps) || 1);
    for (const donor of donors) {
      const bracket = bracketForTime(donor.indices, time, Math.max(1, Number(donor.descriptor.fps) || 1));
      if (!bracket) continue;
      const maximumGap = Math.max(0.75, 2.25 / Math.max(1, Number(donor.descriptor.fps) || 1));
      if (bracket.distance > maximumGap) continue;
      const authoritative = Number(donor.descriptor.cols) >= Number(target.cols)
        && Number(donor.descriptor.rows) >= Number(target.rows)
        && (bracket.exact || (
          bracket.firstIndex !== bracket.secondIndex && Number(donor.descriptor.fps) >= Number(target.fps)
        ));
      plans.set(index, {
        ...bracket,
        donorId: donor.session.id,
        donorDescriptor: donor.descriptor,
        authoritative,
        quality: donor.session.qualityAccumulator || null
      });
      break;
    }
  }
  return plans;
}

function decodeRecord(record, descriptor, target) {
  if (!record?.data) return null;
  const frame = dequantizeDepth16(record.data);
  if (descriptor.cols === target.cols && descriptor.rows === target.rows) return frame;
  return resampleFloatBilinear(frame, descriptor.cols, descriptor.rows, target.cols, target.rows);
}

function resampleGuide(record, descriptor, target) {
  if (!record?.guide) return null;
  const source = new Uint8Array(record.guide);
  if (descriptor.cols === target.cols && descriptor.rows === target.rows) return source;
  const float = resampleFloatBilinear(source, descriptor.cols, descriptor.rows, target.cols, target.rows);
  const guide = new Uint8Array(float.length);
  for (let index = 0; index < float.length; index++) guide[index] = Math.round(Math.min(255, Math.max(0, float[index])));
  return guide;
}

/** Decode, resize and temporally align a lazy reuse plan at its target grid. */
export function materializeDepthReusePlan(plan, firstRecord, secondRecord, target) {
  const descriptor = plan.donorDescriptor;
  const first = decodeRecord(firstRecord, descriptor, target);
  if (!first) return null;
  const firstGuide = resampleGuide(firstRecord, descriptor, target);
  if (plan.firstIndex === plan.secondIndex || !secondRecord?.data) {
    return {
      frame: first,
      guide: firstGuide,
      sceneCut: Boolean(firstRecord.sceneCut),
      quality: firstRecord.quality || plan.quality || null
    };
  }
  const secondRaw = decodeRecord(secondRecord, descriptor, target);
  const secondGuide = resampleGuide(secondRecord, descriptor, target);
  const sceneCut = Boolean(secondRecord.sceneCut);
  const second = sceneCut
    ? secondRaw
    : stabilizeDepthStatistics(secondRaw, first, secondGuide, firstGuide, {
        maxScaleChange: 0.1,
        maxOffset: 0.045,
        strength: 0.58
      }).frame;
  return {
    frame: blendDepthFrames(first, second, sceneCut ? 0 : plan.blend),
    guide: plan.blend < 0.5 ? firstGuide : secondGuide,
    sceneCut,
    quality: secondRecord.quality || firstRecord.quality || plan.quality || null
  };
}
