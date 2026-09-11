/**
 * Versioned depth-cache encoding and deterministic cache identities.
 * Live geometry remains Float32; persistent frames use normalized Uint16 so
 * caching cuts RAM/disk traffic in half without returning to 8-bit terraces.
 */

import { descriptorConversionMode, normalizeDepthConversionMode } from './depth-conversion-mode.js';
import { canonicalMediaIdentity } from './youtube-source.js';

export const DEPTH_CACHE_SCHEMA_VERSION = 2;
export const DEPTH_CACHE_PIPELINE_VERSION = 'voxelvision-depth-v7';
export const UINT16_DEPTH_MAX = 65535;

function clamp01(value) {
  return Math.min(1, Math.max(0, Number.isFinite(value) ? value : 0));
}

export function quantizeDepth16(frame) {
  if (!frame || typeof frame.length !== 'number') throw new TypeError('A depth frame is required.');
  const encoded = new Uint16Array(frame.length);
  for (let i = 0; i < frame.length; i++) {
    encoded[i] = Math.round(clamp01(Number(frame[i])) * UINT16_DEPTH_MAX);
  }
  return encoded;
}

export function dequantizeDepth16(encoded) {
  const values = encoded instanceof Uint16Array
    ? encoded
    : new Uint16Array(encoded);
  const frame = new Float32Array(values.length);
  const scale = 1 / UINT16_DEPTH_MAX;
  for (let i = 0; i < values.length; i++) frame[i] = values[i] * scale;
  return frame;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map(key => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(',')}}`;
}

// A cache identity is not a security boundary. Two independent 32-bit FNV-1a
// passes keep the IndexedDB keys short while making accidental collisions very
// unlikely for local media descriptors.
function fnv1a32(text, seed) {
  let hash = seed >>> 0;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function cacheIdForDescriptor(descriptor) {
  const canonical = stableStringify(descriptor);
  const first = fnv1a32(canonical, 0x811c9dc5).toString(16).padStart(8, '0');
  const second = fnv1a32(canonical, 0x9e3779b9).toString(16).padStart(8, '0');
  const schema = Math.max(1, Math.round(Number(descriptor?.schema) || DEPTH_CACHE_SCHEMA_VERSION));
  return `vv${schema}-${first}${second}`;
}

export function createDepthCacheDescriptor({
  sourceIdentity,
  duration,
  width,
  height,
  cols,
  rows,
  fps,
  modelKey,
  backend,
  precision,
  invert,
  conversionMode,
  foregroundAssist
}) {
  return Object.freeze({
    schema: DEPTH_CACHE_SCHEMA_VERSION,
    pipeline: DEPTH_CACHE_PIPELINE_VERSION,
    ...(foregroundAssist === 'anime-v1' ? { foregroundAssist } : {}),
    source: String(sourceIdentity || 'unknown'),
    durationMs: Math.round(Math.max(0, Number(duration) || 0) * 1000),
    sourceWidth: Math.max(1, Math.round(Number(width) || 1)),
    sourceHeight: Math.max(1, Math.round(Number(height) || 1)),
    cols: Math.max(1, Math.round(Number(cols) || 1)),
    rows: Math.max(1, Math.round(Number(rows) || 1)),
    fps: Math.max(1, Math.round(Number(fps) || 1)),
    model: String(modelKey || 'unknown'),
    backend: String(backend || 'unknown'),
    precision: String(precision || 'default'),
    invert: Boolean(invert),
    conversion: normalizeDepthConversionMode(conversionMode)
  });
}

/**
 * Validate a requested exact replay without requiring its backend to be live.
 * v1 descriptors remain resumable and default to their historical fused path.
 */
export function resumableDescriptorForConfig(session, config = {}) {
  const descriptor = session?.descriptor;
  if (!session?.id || !descriptor || descriptor.pipeline !== DEPTH_CACHE_PIPELINE_VERSION) return null;
  const expected = createDepthCacheDescriptor(config);
  const exactKeys = ['sourceWidth', 'sourceHeight', 'cols', 'rows', 'fps', 'model', 'invert'];
  if (!exactKeys.every(key => descriptor[key] === expected[key])) return null;
  if ((descriptor.foregroundAssist || null) !== (expected.foregroundAssist || null)) return null;
  if (canonicalMediaIdentity(descriptor.source) !== canonicalMediaIdentity(expected.source)) return null;
  if (descriptorConversionMode(descriptor, session.generationEnvironment) !== expected.conversion) return null;
  if (Math.abs(Number(descriptor.durationMs || 0) - Number(expected.durationMs || 0)) > 1000) return null;
  return { cacheId: session.id, descriptor };
}

export function frameIndexAtTime(time, fps, frameCount = Infinity) {
  const index = Math.max(0, Math.floor(Math.max(0, Number(time) || 0) * Math.max(1, Number(fps) || 1)));
  return Number.isFinite(frameCount) ? Math.min(Math.max(0, frameCount - 1), index) : index;
}

export function timeForFrameIndex(index, fps, duration = Infinity) {
  const time = Math.max(0, Math.round(Number(index) || 0) / Math.max(1, Number(fps) || 1));
  return Number.isFinite(duration) ? Math.min(Math.max(0, duration - 0.001), time) : time;
}
