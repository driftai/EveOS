/** Portable, privacy-conscious conversion feedback reports. */

import { conversionScoreForSession } from './depth-conversion-score.js';
import { descriptorConversionMode } from './depth-conversion-mode.js';
import { youtubeUrlFromIdentity } from './youtube-source.js';

export const VOXELVISION_VERSION = '1.9.7';
export const FEEDBACK_SCHEMA_VERSION = 1;

const KNOWN_ISSUES = new Set([
  'uneven-depth',
  'terraced-heights',
  'border-wall',
  'depth-flicker',
  'stale-lag',
  'weak-object-separation',
  'missed-foreground-detail'
]);

function finite(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function dimensions(width, height) {
  const normalizedWidth = Math.max(0, Math.round(finite(width, 0)));
  const normalizedHeight = Math.max(0, Math.round(finite(height, 0)));
  return normalizedWidth && normalizedHeight ? `${normalizedWidth}x${normalizedHeight}` : null;
}

function compact(object) {
  return Object.fromEntries(Object.entries(object).filter(([, value]) => value !== null && value !== undefined && value !== ''));
}

function cacheSummary(frameCount, totalFrames, reusedFrames = 0) {
  const available = Math.min(totalFrames || Infinity, frameCount + reusedFrames);
  if (!totalFrames) return `${frameCount} frames`;
  const shared = reusedFrames ? `; ${frameCount} native + ${reusedFrames} shared` : '';
  return `${available}/${totalFrames} (${Math.round(available / totalFrames * 100)}%${shared})`;
}

function reportSourceUrl(session) {
  const identity = String(session?.sourceIdentity || session?.descriptor?.source || '');
  const candidate = identity.startsWith('youtube:') ? youtubeUrlFromIdentity(identity) : session?.sourceUrl;
  return /^https?:\/\//i.test(String(candidate || '')) ? String(candidate) : null;
}

function calibrationSummary(calibration) {
  if (!calibration) return 'none';
  const method = calibration.method || 'applied';
  const frameCount = Math.max(0, finite(calibration.frameCount, 0));
  return frameCount ? `${method} (${frameCount} frames)` : method;
}

export function normalizeConversionFeedback(input = {}) {
  const rawRating = finite(input.rating10);
  const rating10 = rawRating == null ? null : Math.min(10, Math.max(1, Math.round(rawRating)));
  const issueTags = [...new Set(Array.isArray(input.issueTags) ? input.issueTags : [])]
    .filter(tag => KNOWN_ISSUES.has(tag));
  return {
    schema: FEEDBACK_SCHEMA_VERSION,
    rating10,
    issueTags,
    notes: String(input.notes || '').trim().slice(0, 4000),
    playbackTimeSeconds: Math.max(0, finite(input.playbackTimeSeconds, 0)),
    updatedAt: finite(input.updatedAt)
  };
}

export function createConversionFeedbackReport(session, {
  feedback = session?.feedback
} = {}) {
  if (!session?.id) throw new TypeError('A cached conversion session is required.');
  const descriptor = session.descriptor || {};
  const scored = conversionScoreForSession(session);
  const quality = scored.quality;
  const components = quality.components || {};
  const environment = session.generationEnvironment || {};
  const modelInput = environment.modelInput || {};
  const tuning = environment.tuning || {};
  const frameCount = Math.max(0, finite(session.frameCount, 0));
  const reusedFrames = Math.max(0, finite(session.reusableFrames, 0));
  const totalFrames = Math.max(0, finite(session.totalFrames, 0));
  const user = normalizeConversionFeedback(feedback);
  const hasUserFeedback = user.rating10 != null || user.issueTags.length > 0 || Boolean(user.notes);
  const payload = {
    generation: compact({
      title: session.sourceTitle || null,
      url: reportSourceUrl(session),
      pipeline: descriptor.pipeline || null,
      model: descriptor.model || null,
      foregroundAssist: descriptor.foregroundAssist || null,
      backend: descriptor.backend || null,
      precision: descriptor.precision || null,
      sourceFrame: dimensions(descriptor.sourceWidth, descriptor.sourceHeight),
      modelInput: dimensions(modelInput.width, modelInput.height)
        || (finite(modelInput.detail) ? `${Math.round(modelInput.detail)} max-edge` : null),
      voxelGrid: dimensions(descriptor.cols, descriptor.rows),
      depthFps: descriptor.fps || null,
      inverted: Boolean(descriptor.invert),
      tuning: tuning.mode || null,
      conversion: descriptorConversionMode(descriptor, environment),
      cache: cacheSummary(frameCount, totalFrames, reusedFrames),
      recalibration: calibrationSummary(session.calibration)
    })
  };
  if (quality.score != null) {
    payload.toolScore = compact({
      overall: quality.score,
      samples: quality.count,
      sampleBasis: scored.basis,
      edges: components.edgeAlignment,
      edgeIntegrity: components.edgeIntegrity,
      temporal: components.temporalStability,
      relief: components.usefulRelief,
      borders: components.borderIntegrity,
      precision: components.precision
    });
  }
  if (hasUserFeedback) {
    payload.userFeedback = compact({
      score: user.rating10,
      issues: user.issueTags.length ? user.issueTags : null,
      atSeconds: user.playbackTimeSeconds,
      notes: user.notes
    });
  }
  return {
    payload,
    text: `VoxelVision Video Generation Report v${VOXELVISION_VERSION}\n${JSON.stringify(payload, null, 2)}`
  };
}
