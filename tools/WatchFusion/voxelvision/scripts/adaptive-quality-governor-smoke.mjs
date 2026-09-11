import assert from 'node:assert/strict';

import {
  AdaptiveQualityGovernor,
  QUALITY_TUNING_MODES
} from '../public/js/adaptive-quality-governor.js';

let now = 0;
const manual = new AdaptiveQualityGovernor({
  mode: QUALITY_TUNING_MODES.MANUAL,
  requestedDetail: 512,
  requestedFps: 12,
  clock: () => now,
  changeCooldownMs: 0
});
for (let i = 0; i < 20; i++) manual.record(1200, now += 1200);
assert.equal(manual.snapshot().activeDetail, 512, 'Manual mode must never override selected detail');
assert.equal(manual.snapshot().activeFps, 12, 'Manual mode must never override selected FPS');

const detailPriority = new AdaptiveQualityGovernor({
  mode: QUALITY_TUNING_MODES.DETAIL,
  requestedDetail: 512,
  requestedFps: 12,
  clock: () => now,
  changeCooldownMs: 0
});
for (let i = 0; i < 8; i++) detailPriority.record(500, now += 500);
assert.equal(detailPriority.snapshot().activeDetail, 512, 'Detail priority must preserve the requested grid');
assert.ok(detailPriority.snapshot().activeFps < 12, 'Detail priority should lower an unsustainable FPS request');

const motionPriority = new AdaptiveQualityGovernor({
  mode: QUALITY_TUNING_MODES.MOTION,
  requestedDetail: 512,
  requestedFps: 6,
  clock: () => now,
  changeCooldownMs: 0
});
const primed = motionPriority.prime(310, 512, now);
assert.ok(primed.activeDetail <= 256, 'motion Auto should immediately reuse the last measurement instead of relearning tier by tier');
assert.equal(primed.activeFps, 6, 'priming should protect the requested motion rate when a lower detail can sustain it');
motionPriority.reset({ restoreRequested: true });
for (let i = 0; i < 12; i++) motionPriority.record(420, now += 420);
assert.ok(motionPriority.snapshot().activeDetail < 512, 'Motion priority must trade detail before FPS');
assert.equal(motionPriority.snapshot().activeFps, 6, 'Motion priority should retain FPS while lower detail tiers remain');

for (let i = 0; i < 45; i++) motionPriority.record(420, now += 420);
assert.equal(motionPriority.snapshot().activeDetail, 48, 'Sustained overload should reach the minimum supported detail');
assert.ok(motionPriority.snapshot().activeFps < 6, 'Only minimum-detail overload may reduce motion-priority FPS');

for (let i = 0; i < 240; i++) motionPriority.record(18, now += 18);
const recovered = motionPriority.snapshot();
assert.equal(recovered.activeFps, 6, 'Sustained headroom should recover the selected FPS');
assert.ok(recovered.activeDetail > 48, 'Sustained headroom should recover detail one tier at a time');
assert.ok(recovered.activeDetail <= 512, 'Recovery must never exceed the selected detail');

motionPriority.setMode(QUALITY_TUNING_MODES.MANUAL);
assert.equal(motionPriority.snapshot().activeDetail, 512, 'Switching to manual restores the selected detail immediately');
assert.equal(motionPriority.snapshot().activeFps, 6, 'Switching to manual restores the selected FPS immediately');

const restoredProfile = motionPriority.restoreProfile({
  mode: QUALITY_TUNING_MODES.MOTION,
  requestedDetail: 512,
  requestedFps: 8,
  activeDetail: 384,
  activeFps: 4
}, now);
assert.equal(restoredProfile.requestedDetail, 512, 'resume should retain the original Auto detail target');
assert.equal(restoredProfile.requestedFps, 8, 'resume should retain the original Auto FPS target');
assert.equal(restoredProfile.activeDetail, 384, 'resume should open the exact cached grid before adapting');
assert.equal(restoredProfile.activeFps, 4, 'resume should open the exact cached FPS before adapting');
assert.equal(restoredProfile.sampleCount, 0, 'stale performance evidence must not cross a reload boundary');

console.log('Adaptive quality-mode governor smoke tests passed.');
