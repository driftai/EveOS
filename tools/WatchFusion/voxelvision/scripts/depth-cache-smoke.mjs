import assert from 'node:assert/strict';

import {
  cacheIdForDescriptor,
  createDepthCacheDescriptor,
  dequantizeDepth16,
  frameIndexAtTime,
  quantizeDepth16,
  resumableDescriptorForConfig,
  stableStringify,
  timeForFrameIndex
} from '../public/js/depth-cache-codec.js';
import { DepthFrameRing, memoryBudgetForSystemRam } from '../public/js/depth-frame-ring.js';

const source = new Float32Array([0, 0.00001, 0.125432, 0.5, 0.99999, 1, -2, 3, Number.NaN]);
const encoded = quantizeDepth16(source);
const decoded = dequantizeDepth16(encoded);
for (let i = 0; i < 6; i++) {
  assert.ok(Math.abs(decoded[i] - source[i]) <= 1 / 65535, `16-bit round trip drifted at ${i}`);
}
assert.equal(decoded[6], 0);
assert.equal(decoded[7], 1);
assert.equal(decoded[8], 0);

assert.equal(stableStringify({ z: 1, a: { y: 2, x: 3 } }), stableStringify({ a: { x: 3, y: 2 }, z: 1 }));
const descriptor = createDepthCacheDescriptor({
  sourceIdentity: 'video:test',
  duration: 12.3456,
  width: 1920,
  height: 1080,
  cols: 512,
  rows: 288,
  fps: 4,
  modelKey: 'enhanced',
  backend: 'webgpu',
  precision: 'FP16 hybrid',
  invert: false,
  conversionMode: 'fused'
});
assert.equal(descriptor.schema, 2);
assert.equal(descriptor.conversion, 'fused');
assert.equal(cacheIdForDescriptor(descriptor), cacheIdForDescriptor({ ...descriptor }));
assert.notEqual(cacheIdForDescriptor(descriptor), cacheIdForDescriptor({ ...descriptor, cols: 384 }));
assert.notEqual(cacheIdForDescriptor(descriptor), cacheIdForDescriptor({ ...descriptor, conversion: 'model' }));
const resumed = resumableDescriptorForConfig({ id: 'vv1-legacy', descriptor: { ...descriptor, schema: 1 } }, {
  sourceIdentity: 'video:test', duration: 12.3456, width: 1920, height: 1080,
  cols: 512, rows: 288, fps: 4, modelKey: 'enhanced', backend: 'idle',
  precision: 'default', invert: false, conversionMode: 'fused'
});
assert.equal(resumed.cacheId, 'vv1-legacy', 'cached replay must not require a currently initialized backend');
assert.equal(resumableDescriptorForConfig({ id: 'wrong', descriptor }, {
  sourceIdentity: 'video:test', duration: 12.3456, width: 1920, height: 1080,
  cols: 512, rows: 288, fps: 4, modelKey: 'enhanced', invert: false, conversionMode: 'luma'
}), null, 'different conversion paths must not resume the same exact cache');
assert.equal(frameIndexAtTime(2.74, 4, 100), 10);
assert.equal(timeForFrameIndex(10, 4, 100), 2.5);

const ring = new DepthFrameRing(1024 * 1024);
ring.set(1, new Float32Array(180000));
ring.set(2, new Float32Array(180000));
assert.equal(ring.has(1), false, 'least-recently-used frame should be evicted');
assert.equal(ring.has(2), true);
assert.ok(ring.snapshot().bytes <= ring.snapshot().maxBytes);
const sixtyFourGbBudget = memoryBudgetForSystemRam(64);
assert.ok(sixtyFourGbBudget >= 500 * 1024 * 1024 && sixtyFourGbBudget <= 520 * 1024 * 1024);

const metadataRing = new DepthFrameRing(1024 * 1024);
metadataRing.set(0, new Float32Array(100), { guide: new Uint8Array(100) });
assert.equal(metadataRing.snapshot().bytes, 500, 'RAM budgeting must count stored video guides as well as Float32 depth');

console.log('Depth cache smoke passed: 16-bit fidelity, conversion-safe resume, timing and bounded depth/guide RAM.');
