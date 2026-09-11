import assert from 'node:assert/strict';

import {
  DEFAULT_DEPTH_MODEL,
  depthModelFallbackOrder,
  fitModelCapture,
  getDepthModelProfile,
  modelTensorDimensions,
  prepareModelDepthSignal,
  rgbaToImageNetTensorData,
  validateDepthTensor
} from '../public/js/depth-models.js';
import { resampleFloatBilinearRegion } from '../public/js/depth-processing.js';

assert.equal(DEFAULT_DEPTH_MODEL, 'enhanced');
assert.deepEqual(
  depthModelFallbackOrder('enhanced').map(profile => profile.key),
  ['enhanced', 'balanced'],
  'Enhanced depth must retain a deterministic compatible fallback'
);
assert.equal(getDepthModelProfile('balanced').loader, 'worker-model', 'Both AI models must stay off the render thread');
assert.deepEqual(
  getDepthModelProfile('enhanced').webGpuFp16CpuNodes,
  ['/backbone/Resize'],
  'DA3 FP16 must route only its incompatible cubic Resize away from WebGPU'
);
assert.deepEqual(
  depthModelFallbackOrder('balanced').map(profile => profile.key),
  ['balanced'],
  'Explicit balanced mode must not unexpectedly load another model first'
);

for (const [width, height] of [
  [1920, 1080],
  [1080, 1920],
  [1024, 1024],
  [3840, 960],
  [960, 3840],
  [10000, 100],
  [100, 10000]
]) {
  const layout = fitModelCapture(width, height, 'enhanced');
  assert.equal(layout.canvasWidth % 14, 0, 'Model canvas width must align to the ViT patch size');
  assert.equal(layout.canvasHeight % 14, 0, 'Model canvas height must align to the ViT patch size');
  assert.ok(layout.contentX >= 0 && layout.contentY >= 0, 'Content must remain inside the model canvas');
  assert.ok(layout.contentX + layout.contentWidth <= layout.canvasWidth);
  assert.ok(layout.contentY + layout.contentHeight <= layout.canvasHeight);
  assert.ok(
    Math.abs(layout.contentWidth / layout.contentHeight - width / height) / (width / height) < 0.11,
    'Landscape, portrait, square and extreme content must retain source aspect without stretching'
  );
}

const reducedCapture = fitModelCapture(1920, 1080, 'balanced', 128);
assert.ok(reducedCapture.canvasWidth <= 140, 'Motion priority must be able to lower real model input cost');
assert.equal(reducedCapture.canvasWidth % 14, 0, 'Reduced model inputs must remain patch aligned');
assert.ok(Math.abs(reducedCapture.contentWidth / reducedCapture.contentHeight - 16 / 9) < 0.03);

const da3Signal = prepareModelDepthSignal(new Float32Array([1, 2, 4]), 'enhanced');
assert.ok(da3Signal[0] > da3Signal[1] && da3Signal[1] > da3Signal[2], 'DA3 direct depth must become near-is-high');

const da2Signal = prepareModelDepthSignal(new Float32Array([1, 2, 10]), 'balanced');
assert.ok(da2Signal[1] - da2Signal[0] > 0.25, 'DA2 logarithmic transfer must expand distant structure');
assert.ok(da2Signal[2] > da2Signal[1], 'DA2 inverse-depth ordering must remain near-is-high');

const tensorData = rgbaToImageNetTensorData(
  new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 255]),
  2,
  1
);
assert.equal(tensorData.length, 6);
assert.ok(tensorData[0] > tensorData[1], 'Tensor layout must store the red plane contiguously');
assert.deepEqual(modelTensorDimensions('enhanced', 126, 98), [1, 1, 3, 98, 126]);
assert.deepEqual(modelTensorDimensions('balanced', 126, 98), [1, 3, 98, 126]);

const smooth = new Float32Array(8 * 4);
for (let y = 0; y < 4; y++) {
  for (let x = 0; x < 8; x++) smooth[y * 8 + x] = x / 7 + y * 0.02;
}
const validated = validateDepthTensor({ dims: [1, 1, 4, 8], data: smooth });
assert.deepEqual([validated.width, validated.height], [8, 4]);
assert.throws(
  () => validateDepthTensor({ dims: [2, 2], data: new Float32Array(4).fill(1) }),
  /constant field/,
  'A compiled model that emits no geometry must not be announced ready'
);

const padded = new Float32Array([
  99, 99, 99, 99, 99, 99,
  99, 1, 2, 3, 4, 99,
  99, 5, 6, 7, 8, 99,
  99, 99, 99, 99, 99, 99
]);
const cropped = resampleFloatBilinearRegion(padded, 6, 4, 1, 1, 4, 2, 4, 2);
assert.deepEqual([...cropped], [1, 2, 3, 4, 5, 6, 7, 8], 'Model padding must be cropped before voxel placement');

assert.equal(getDepthModelProfile('missing').key, 'enhanced', 'Unknown saved model keys must fail safely');

console.log('Depth-model profile, orientation, aspect and validation smoke tests passed.');
