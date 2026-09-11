/** Deterministic selection of the best resumable depth profile for one source. */

import { descriptorConversionMode } from './depth-conversion-mode.js';
import { canonicalMediaIdentity } from './youtube-source.js';

function profileDetail(descriptor = {}) {
  return Math.max(1, Number(descriptor.cols) || 1, Number(descriptor.rows) || 1);
}

function modelRank(model) {
  if (model === 'enhanced') return 3;
  if (model === 'balanced') return 2;
  return 1;
}

function backendRank(backend) {
  if (backend === 'webgpu') return 3;
  if (backend === 'wasm') return 2;
  return backend === 'luma' ? 0 : 1;
}

function precisionRank(precision) {
  const label = String(precision || '').toLowerCase();
  if (label.includes('fp32')) return 3;
  if (label.includes('fp16')) return 2;
  return 1;
}

function compareProfiles(first, second) {
  const a = first.descriptor || {};
  const b = second.descriptor || {};
  const aDetail = profileDetail(a);
  const bDetail = profileDetail(b);
  const tuples = [
    [backendRank(a.backend), backendRank(b.backend)],
    [modelRank(a.model), modelRank(b.model)],
    [precisionRank(a.precision), precisionRank(b.precision)],
    [aDetail * aDetail * Math.max(1, Number(a.fps) || 1), bDetail * bDetail * Math.max(1, Number(b.fps) || 1)],
    [aDetail, bDetail],
    [Number(a.fps) || 0, Number(b.fps) || 0],
    [Number(first.qualityAccumulator?.score) || 0, Number(second.qualityAccumulator?.score) || 0],
    [Number(first.lastAccess) || 0, Number(second.lastAccess) || 0]
  ];
  for (const [left, right] of tuples) if (left !== right) return right - left;
  return String(first.id).localeCompare(String(second.id));
}

export function sortDepthProfilesByQuality(sessions = []) {
  return [...sessions].sort(compareProfiles);
}

export function resumableProfilesForSource(sessions, sourceIdentity, pipeline = null) {
  return (sessions || []).filter(session => {
    const descriptor = session.descriptor || {};
    const identity = session.sourceIdentity || descriptor.source;
    // Older sessions may have committed 1-11 frame transactions immediately
    // before their intentionally infrequent metadata checkpoint. Their mere
    // presence is therefore enough to make them resumable.
    return canonicalMediaIdentity(identity) === canonicalMediaIdentity(sourceIdentity)
      && (!pipeline || descriptor.pipeline === pipeline);
  }).sort(compareProfiles);
}

export function selectBestResumableProfile(sessions, sourceIdentity, {
  pipeline = null,
  preferredSessionId = null
} = {}) {
  const profiles = resumableProfilesForSource(sessions, sourceIdentity, pipeline);
  if (preferredSessionId) return profiles.find(session => session.id === preferredSessionId) || null;
  return profiles[0] || null;
}

export function restoredProfileState(session) {
  const descriptor = session?.descriptor || {};
  const tuning = session?.generationEnvironment?.tuning || {};
  return {
    mode: ['manual', 'detail-priority', 'motion-priority'].includes(tuning.mode) ? tuning.mode : 'manual',
    requestedDetail: Number(tuning.requestedDetail) || profileDetail(descriptor),
    requestedFps: Number(tuning.requestedFps) || Number(descriptor.fps) || 3,
    activeDetail: profileDetail(descriptor),
    activeFps: Number(tuning.activeFps) || Number(descriptor.fps) || 3,
    model: descriptor.model || 'enhanced',
    invert: Boolean(descriptor.invert),
    conversionMode: descriptorConversionMode(descriptor, session?.generationEnvironment)
  };
}
