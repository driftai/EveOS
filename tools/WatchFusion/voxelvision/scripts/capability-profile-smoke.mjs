import assert from 'node:assert/strict';
import {
  classifyMachineProfile,
  gridForLiveDetail,
  LUMA_FALLBACK_LIMITS
} from '../public/js/capability-profile.js';

const wasmLaptop = classifyMachineProfile({
  hardwareConcurrency: 4,
  deviceMemoryGb: 4,
  webgpu: false,
  gpuLabel: 'Intel UHD Graphics'
});
assert.equal(wasmLaptop.id, 'safe');
assert.equal(wasmLaptop.maxGridCols, 128);
assert.equal(wasmLaptop.maxDepthFps, 3);

const integratedWebGpu = classifyMachineProfile({
  hardwareConcurrency: 8,
  deviceMemoryGb: 8,
  webgpu: true,
  gpuLabel: 'Intel Iris Xe Graphics'
});
assert.equal(integratedWebGpu.id, 'balanced');
assert.equal(integratedWebGpu.maxGridCols, 256);

const hiddenGpuStrongCpu = classifyMachineProfile({
  hardwareConcurrency: 20,
  deviceMemoryGb: 8,
  webgpu: true,
  gpuLabel: ''
});
assert.equal(hiddenGpuStrongCpu.id, 'performance');
assert.equal(hiddenGpuStrongCpu.maxGridCols, 384);
assert.equal(hiddenGpuStrongCpu.maxDepthFps, 8);

const rtx4050Class = classifyMachineProfile({
  hardwareConcurrency: 20,
  deviceMemoryGb: 8,
  webgpu: true,
  gpuLabel: 'NVIDIA GeForce RTX 4050 Laptop GPU',
  maxBufferSize: 1024 * 1024 * 1024
});
assert.equal(rtx4050Class.id, 'extreme');
assert.equal(rtx4050Class.maxGridCols, 512);
assert.equal(rtx4050Class.recommendedGridCols, 256);
assert.equal(rtx4050Class.maxDepthFps, 12);
assert.equal(rtx4050Class.maxLiveVoxels, 512 * 512);
assert.ok(rtx4050Class.depthFpsSteps.includes(1));
assert.equal(LUMA_FALLBACK_LIMITS.maxGridCols, 256);
assert.equal(LUMA_FALLBACK_LIMITS.maxDepthFps, 4);
assert.equal(LUMA_FALLBACK_LIMITS.depthCeiling, 0.75);

assert.deepEqual(gridForLiveDetail(512, 16, 9, 512, 512 * 512), { cols: 512, rows: 288 });
assert.deepEqual(gridForLiveDetail(512, 4, 3, 512, 512 * 512), { cols: 512, rows: 384 });
assert.deepEqual(gridForLiveDetail(512, 9, 16, 512, 512 * 512), { cols: 288, rows: 512 });
assert.deepEqual(gridForLiveDetail(512, 1, 1, 512, 512 * 512), { cols: 512, rows: 512 });

console.log('VoxelVision capability profile smoke passed.');
