import assert from 'node:assert/strict';

import {
  restoredProfileState,
  selectBestResumableProfile,
  sortDepthProfilesByQuality
} from '../public/js/depth-profile-resume.js';

const source = 'local:test.mp4|42|123|video/mp4';
const descriptor = (cols, rows, fps, extras = {}) => ({
  pipeline: 'voxelvision-depth-v7',
  source,
  model: 'enhanced',
  backend: 'webgpu',
  precision: 'FP16 Hybrid',
  cols,
  rows,
  fps,
  ...extras
});
const sessions = [
  { id: 'balanced', descriptor: descriptor(512, 288, 12, { model: 'balanced' }), frameCount: 100 },
  { id: 'detail', descriptor: descriptor(512, 288, 4), frameCount: 100 },
  { id: 'best', descriptor: descriptor(512, 288, 8), frameCount: 3, analysisState: 'in-progress' },
  { id: 'old-interrupted', descriptor: descriptor(384, 216, 12), frameCount: 0 },
  { id: 'wrong-source', descriptor: { ...descriptor(512, 288, 12), source: 'other' }, frameCount: 100 },
  { id: 'wrong-pipeline', descriptor: descriptor(512, 288, 12, { pipeline: 'old' }), frameCount: 100 },
  { id: 'luma', descriptor: descriptor(512, 288, 12, { backend: 'luma', precision: 'Float32' }), frameCount: 100 }
];

const selected = selectBestResumableProfile(sessions, source, { pipeline: 'voxelvision-depth-v7' });
assert.equal(selected.id, 'best', 'best model/backend/precision and spatiotemporal profile should resume');
assert.equal(
  selectBestResumableProfile(sessions, source, { pipeline: 'voxelvision-depth-v7', preferredSessionId: 'detail' }).id,
  'detail',
  'explicit cache-library replay must restore that exact profile'
);
assert.ok(
  sortDepthProfilesByQuality(sessions.filter(item => item.descriptor.source === source))[0].id === 'wrong-pipeline',
  'quality ordering should remain deterministic independently of compatibility filtering'
);
assert.ok(
  selectBestResumableProfile([sessions[3]], source, { pipeline: 'voxelvision-depth-v7' }),
  'an old interrupted profile must remain discoverable when its metadata checkpoint says zero frames'
);
const legacyYoutube = {
  id: 'youtube-legacy',
  descriptor: descriptor(512, 288, 4, {
    source: 'youtube:https://youtu.be/AbCdEf12345?si=old-token|quality:1080'
  })
};
assert.equal(selectBestResumableProfile(
  [legacyYoutube],
  'youtube:video:AbCdEf12345|quality:1080',
  { pipeline: 'voxelvision-depth-v7' }
)?.id, 'youtube-legacy', 'canonical video IDs must recover caches created from older share URLs');

const portrait = restoredProfileState({
  descriptor: descriptor(288, 512, 4),
  generationEnvironment: { tuning: { mode: 'motion-priority', requestedDetail: 512, requestedFps: 8 } }
});
assert.equal(portrait.activeDetail, 512, 'profile detail is the max edge for portrait and landscape videos');
assert.equal(portrait.activeFps, 4);
assert.equal(portrait.requestedFps, 8);
assert.equal(portrait.mode, 'motion-priority');
assert.equal(portrait.conversionMode, 'fused', 'legacy profiles must restore their historical fused mode');
assert.equal(restoredProfileState({
  descriptor: descriptor(512, 288, 4, { conversion: 'luma', backend: 'luma' })
}).conversionMode, 'luma');

console.log('Depth profile resume smoke passed.');
