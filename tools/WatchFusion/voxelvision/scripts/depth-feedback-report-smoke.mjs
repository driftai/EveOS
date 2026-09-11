import assert from 'node:assert/strict';

import {
  createConversionFeedbackReport,
  normalizeConversionFeedback,
  VOXELVISION_VERSION
} from '../public/js/depth-feedback-report.js';

const feedback = normalizeConversionFeedback({
  rating10: 7.4,
  issueTags: ['depth-flicker', 'border-wall', 'unknown', 'depth-flicker'],
  notes: `  Bottom edge rises too far.  `,
  playbackTimeSeconds: 42.125,
  updatedAt: 1000
});
assert.equal(normalizeConversionFeedback({}).rating10, null, 'an absent user score must remain unrated');
assert.equal(normalizeConversionFeedback({}).updatedAt, null, 'unsaved feedback must not gain a timestamp');
assert.deepEqual(feedback.issueTags, ['depth-flicker', 'border-wall']);
assert.equal(feedback.rating10, 7);
assert.equal(feedback.notes, 'Bottom edge rises too far.');

const session = {
  id: 'vv1-test',
  sourceIdentity: 'youtube:https://www.youtube.com/watch?v=test123|quality:1080',
  sourceTitle: 'Test clip',
  sourceDuration: 60,
  frameCount: 180,
  totalFrames: 240,
  createdAt: 1000,
  descriptor: {
    schema: 1,
    pipeline: 'voxelvision-depth-v7',
    sourceWidth: 1920,
    sourceHeight: 1080,
    cols: 512,
    rows: 288,
    fps: 4,
    model: 'enhanced',
    backend: 'webgpu',
    precision: 'FP16 Hybrid',
    invert: false,
    conversion: 'fused'
  },
  qualityAccumulator: {
    score: 71,
    grade: 'Good',
    confidence: 1,
    count: 180,
    components: { temporalStability: 62, edgeAlignment: 79 }
  },
  generationEnvironment: {
    machine: { gpu: 'Must not be copied', systemMemoryGb: 63.7 },
    tuning: { mode: 'manual', requestedDetail: 512, activeDetail: 512 },
    modelInput: { detail: 518, width: 518, height: 294 },
    fusion: 'fused'
  },
  feedback
};
const report = createConversionFeedbackReport(session);
assert.match(report.text, new RegExp(`^VoxelVision Video Generation Report v${VOXELVISION_VERSION}`));
assert.deepEqual(Object.keys(report.payload), ['generation', 'toolScore', 'userFeedback']);
assert.equal(report.payload.generation.sourceFrame, '1920x1080');
assert.equal(report.payload.generation.title, 'Test clip');
assert.equal(report.payload.generation.url, 'https://www.youtube.com/watch?v=test123');
assert.equal(report.payload.generation.modelInput, '518x294');
assert.equal(report.payload.generation.voxelGrid, '512x288');
assert.equal(report.payload.generation.cache, '180/240 (75%)');
assert.equal(report.payload.generation.conversion, 'fused');
assert.equal(report.payload.toolScore.overall, 71);
assert.equal(report.payload.toolScore.samples, 180);
assert.equal(report.payload.userFeedback.score, 7);
assert.equal(report.payload.userFeedback.atSeconds, 42.125);
assert.match(report.text, /Bottom edge rises too far/);
assert.doesNotMatch(report.text, /Must not be copied|systemMemoryGb|currentRuntime|generatedAt|cacheId|sourceIdentity/);
assert.ok(report.text.length < 1400, `report should stay compact, got ${report.text.length} characters`);

const reused = createConversionFeedbackReport({
  ...session,
  frameCount: 60,
  reusableFrames: 180,
  qualityAccumulator: { score: 70, count: 60, components: { temporalStability: 60 } },
  sharedQualityAccumulator: { score: 80, count: 120, components: { temporalStability: 75 } }
});
assert.equal(reused.payload.generation.cache, '240/240 (100%; 60 native + 180 shared)');
assert.equal(reused.payload.toolScore.samples, 180, 'score samples must count analyzed maps, not interpolated playback frames');
assert.equal(reused.payload.toolScore.sampleBasis, 'native + shared analyzed maps');

const rendered = createConversionFeedbackReport({
  ...session,
  renderQualityAccumulator: {
    score: 84,
    count: 24,
    components: { temporalStability: 91, edgeAlignment: 82 }
  }
});
assert.equal(rendered.payload.toolScore.overall, 84, 'the final presented diagnostic must take scoring precedence');
assert.equal(rendered.payload.toolScore.samples, 24);
assert.equal(rendered.payload.toolScore.sampleBasis, 'final rendered depth + decoded video');

console.log('Depth feedback report smoke passed: source identity, generation settings, scores, review and compact size.');
