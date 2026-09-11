import assert from 'node:assert/strict';

import { quantizeDepth16 } from '../public/js/depth-cache-codec.js';
import {
  buildDepthReusePlans,
  descriptorsShareDepthTimeline,
  materializeDepthReusePlan
} from '../public/js/depth-cache-reuse.js';
import { groupDepthCacheSessions } from '../public/js/depth-cache-library.js';

const base = {
  pipeline: 'voxelvision-depth-v7', source: 'video:test', durationMs: 2000,
  sourceWidth: 1920, sourceHeight: 1080, model: 'enhanced', backend: 'webgpu',
  precision: 'FP16 Hybrid', invert: false, conversion: 'fused'
};
const donorDescriptor = { ...base, cols: 512, rows: 288, fps: 4 };
const target = { ...base, cols: 384, rows: 216, fps: 8 };
assert.equal(descriptorsShareDepthTimeline(target, donorDescriptor), true);
assert.equal(descriptorsShareDepthTimeline(target, { ...donorDescriptor, foregroundAssist: 'anime-v1' }), false,
  'assisted and unassisted frames must not silently satisfy each other');
assert.equal(descriptorsShareDepthTimeline(target, { ...donorDescriptor, model: 'balanced' }), false);
assert.equal(descriptorsShareDepthTimeline(
  { ...target, source: 'youtube:video:AbCdEf12345|quality:1080' },
  { ...donorDescriptor, source: 'youtube:https://youtu.be/AbCdEf12345?si=old|quality:1080' }
), true, 'tracking-token variants of one YouTube video must share their depth timeline');
assert.equal(descriptorsShareDepthTimeline(target, { ...donorDescriptor, conversion: 'model' }), false);
assert.equal(descriptorsShareDepthTimeline(target, { ...donorDescriptor, conversion: 'luma', backend: 'luma' }), false);

const donor = { id: 'donor', sourceIdentity: base.source, descriptor: donorDescriptor, qualityAccumulator: { score: 78, count: 9 } };
const indices = new Map([['donor', [0, 1, 2, 3, 4, 5, 6, 7]]]);
const plans = buildDepthReusePlans({ target, targetFrameCount: 16, sessions: [donor], indicesByCacheId: indices });
assert.equal(plans.size, 16, 'a 4 FPS cache should make the full 8 FPS target timeline immediately playable');
assert.equal(plans.get(2).authoritative, true, 'an exact high-detail timestamp must not be inferred again');
assert.equal(plans.get(1).authoritative, false, 'an interpolated timestamp remains eligible for later native refinement');

const cells = donorDescriptor.cols * donorDescriptor.rows;
const record = value => ({
  data: quantizeDepth16(new Float32Array(cells).fill(value)).buffer,
  guide: new Uint8Array(cells).fill(100).buffer,
  quality: { score: 76 }
});
const projected = materializeDepthReusePlan(plans.get(1), record(0.2), record(0.8), target);
assert.equal(projected.frame.length, target.cols * target.rows);
assert.ok(projected.frame.every(Number.isFinite));
assert.ok(projected.frame[0] > 0.2 && projected.frame[0] < 0.8, 'missing timestamps should interpolate from cached neighbors');

const groups = groupDepthCacheSessions([
  { ...donor, id: 'a', frameCount: 4, reusableFrames: 4, totalFrames: 16, lastAccess: 1 },
  { ...donor, id: 'b', descriptor: target, frameCount: 8, reusableFrames: 8, totalFrames: 16, lastAccess: 2 },
  { ...donor, id: 'old', descriptor: { ...donorDescriptor, pipeline: 'old', fps: 12 }, frameCount: 16, totalFrames: 16 }
]);
assert.equal(groups.length, 1, 'quality variants from one source should occupy one library card');
assert.equal(groups[0].sessions.length, 3);
assert.equal(groups[0].best.id, 'b');

console.log('Depth cache reuse smoke passed.');
