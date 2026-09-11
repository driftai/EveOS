import assert from 'node:assert/strict';

import { AdaptiveFpsGovernor } from '../public/js/adaptive-fps-governor.js';

let now = 0;
const governor = new AdaptiveFpsGovernor({
  maxFps: 12,
  requestedFps: 12,
  initialFps: 12,
  clock: () => now,
  upshiftCooldownMs: 0
});

let state;
for (let i = 0; i < 6; i++) {
  now += 850;
  state = governor.record(820, now);
}
assert.equal(state.runtimeCeiling, 1, 'Sustained overload should rapidly retract impossible FPS tiers');
assert.equal(state.activeFps, 1, 'The active depth rate should follow a measured downshift');

const recovered = [];
for (let i = 0; i < 90; i++) {
  now += 95;
  state = governor.record(70, now);
  if (state.direction === 'up') recovered.push(state.activeFps);
}
assert.ok(recovered.length >= 2, 'Sustained headroom should recover through multiple FPS tiers');
assert.ok(state.activeFps >= 8, 'A later easy scene should recover most of a 12 FPS request');
assert.ok(state.activeFps <= 12, 'Recovery must never exceed the requested machine tier');

governor.setRequested(4);
state = governor.snapshot();
assert.equal(state.requestedFps, 4, 'The governor should preserve an explicit user request');
assert.ok(state.activeFps <= 4, 'Lowering the request should apply immediately');

governor.reset({ preserveActive: true });
state = governor.snapshot();
assert.equal(state.runtimeCeiling, 12, 'A source/detail/backend reset should clear stale runtime limits');
assert.ok(state.activeFps <= 4, 'A reset must not erase the user-requested target');

governor.setRequested(12, { allowImmediateUpshift: true });
for (let i = 0; i < 5; i++) state = governor.record(6200, now += 6200);
assert.equal(state.activeFps, 1, 'Very slow valid model frames must still retract the target to 1 FPS');
governor.reset({ preserveActive: false });
state = governor.snapshot();
assert.equal(state.activeFps, 12, 'A new source or model backend must get a fresh chance at the requested tier');

console.log('Adaptive FPS governor smoke tests passed.');
