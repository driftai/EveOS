import assert from 'node:assert/strict';

import { calibrateDepthFrame, planSceneAwareCalibration } from '../public/js/depth-cache-recalibrator.js';
import { scoreDepthConversion } from '../public/js/depth-conversion-score.js';
import { DepthRenderFusion, fuseDepthWithVideoEvidence } from '../public/js/depth-render-fusion.js';
import { RenderedDepthScorer } from '../public/js/depth-render-score.js';

const width = 32;
const height = 24;
const cells = width * height;
const rgba = new Uint8ClampedArray(cells * 4);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const value = x < width / 2 ? 28 : 225;
    const offset = (y * width + x) * 4;
    rgba[offset] = value;
    rgba[offset + 1] = value;
    rgba[offset + 2] = value;
    rgba[offset + 3] = 255;
  }
}

const flat = new Float32Array(cells).fill(0.42);
const flatFusion = fuseDepthWithVideoEvidence(flat, flat, 0.5, width, height, rgba);
assert.ok(flatFusion.frame.every(value => Math.abs(value - 0.42) < 1e-6), 'video texture must not invent depth on a flat model surface');

const aligned = new Float32Array(cells);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) aligned[y * width + x] = x < width / 2 ? 0.25 : 0.76;
}
const alignedFusion = fuseDepthWithVideoEvidence(aligned, aligned, 0, width, height, rgba);
const row = Math.floor(height / 2) * width;
assert.ok(
  alignedFusion.frame[row + width / 2] - alignedFusion.frame[row + width / 2 - 1] > 0.45,
  'image-supported model boundaries should survive render fusion'
);

for (const [aspectWidth, aspectHeight] of [[48, 27], [27, 48], [64, 16], [31, 31]]) {
  const aspectCells = aspectWidth * aspectHeight;
  const aspectFrame = new Float32Array(aspectCells).fill(0.5);
  const aspectPixels = new Uint8ClampedArray(aspectCells * 4).fill(96);
  const result = fuseDepthWithVideoEvidence(
    aspectFrame,
    aspectFrame,
    0.25,
    aspectWidth,
    aspectHeight,
    aspectPixels
  );
  assert.equal(result.frame.length, aspectCells, `fusion must preserve ${aspectWidth}:${aspectHeight} grids`);
  assert.ok(result.frame.every(Number.isFinite), 'all aspect-ratio output cells must remain finite');
}

const goodScore = scoreDepthConversion({
  frame: alignedFusion.frame,
  width,
  height,
  rgba,
  previousFrame: alignedFusion.frame,
  previousGuide: flatFusion.guide
});
const bad = new Float32Array(cells);
const badPrevious = new Float32Array(cells);
for (let y = 0; y < height; y++) {
  for (let x = 0; x < width; x++) {
    const index = y * width + x;
    bad[index] = y > height - 4 ? 1 : ((x + y) % 2 ? 0.15 : 0.85);
    badPrevious[index] = 1 - bad[index];
  }
}
const badScore = scoreDepthConversion({ frame: bad, width, height, rgba, previousFrame: badPrevious, previousGuide: flatFusion.guide });
assert.ok(goodScore.score > badScore.score + 15, 'stable aligned depth should outscore flickering unsupported geometry');

const presentedScorer = new RenderedDepthScorer({ maxSamplesPerSecond: 12 });
const firstPresented = presentedScorer.sample({
  frame: alignedFusion.frame, width, height, rgba, frameVersion: 1, mediaTime: 0
});
const duplicatePresented = presentedScorer.sample({
  frame: alignedFusion.frame, width, height, rgba, frameVersion: 1, mediaTime: 0
});
const secondPresented = presentedScorer.sample({
  frame: alignedFusion.frame, width, height, rgba, frameVersion: 2, mediaTime: 0.1
});
assert.ok(firstPresented && secondPresented, 'presented diagnostic frames must be scored against decoded color');
assert.equal(duplicatePresented, null, 'render-loop repeats must not inflate diagnostic sample counts');
assert.equal(secondPresented.components.temporalStability, 100, 'unchanged presented depth and color should score as stable');

const shifted = Float32Array.from(aligned, value => Math.min(1, value + 0.08));
const shiftedAgain = Float32Array.from(aligned, value => Math.min(1, value + 0.16));
const chained = new DepthRenderFusion({ mode: 'model' });
const endFirstPair = chained.render({
  first: aligned, second: shifted, blend: 1, width, height,
  firstGuide: flatFusion.guide, secondGuide: flatFusion.guide,
  pairKey: '0:1', firstFrameKey: '0', secondFrameKey: '1', videoFrameVersion: 1
}).frame;
const startSecondPair = chained.render({
  first: shifted, second: shiftedAgain, blend: 0, width, height,
  firstGuide: flatFusion.guide, secondGuide: flatFusion.guide,
  pairKey: '1:2', firstFrameKey: '1', secondFrameKey: '2', videoFrameVersion: 2
}).frame;
assert.ok(Math.abs(endFirstPair[0] - startSecondPair[0]) < 1e-6, 'aligned frame endpoints must not snap when the playback pair advances');

const colorIndependent = new DepthRenderFusion({ mode: 'fused' });
const candidate = new Float32Array(aligned);
const presented = colorIndependent.render({ first: candidate, second: candidate, blend: 0,
  width, height, rgba, pairKey: 'same', firstFrameKey: 'same', secondFrameKey: 'same', videoFrameVersion: 1 }).frame;
assert.ok(presented.every((v, i) => Math.abs(v - candidate[i]) < 0.04), 'cached geometry must not be relifted by unrelated presentation-time colors');
const replacement = new Float32Array(cells).fill(0.31);
const refreshed = colorIndependent.render({ first: replacement, second: replacement, blend: 0,
  width, height, rgba, pairKey: 'new', firstFrameKey: 'new', secondFrameKey: 'new', videoFrameVersion: 1 }).frame;
assert.ok(refreshed.every(v => Math.abs(v - 0.31) < 1e-6), 'new cache endpoints must refresh even when the video is paused');

const plans = planSceneAwareCalibration([
  { index: 0, segment: 0, median: 0.42, span: 0.4 },
  { index: 1, segment: 0, median: 0.58, span: 0.62 },
  { index: 2, segment: 0, median: 0.44, span: 0.42 },
  { index: 3, segment: 1, median: 0.82, span: 0.2, sceneCut: true }
]);
assert.ok(plans[1].offset < 0, 'a raised frame in one shot should calibrate toward its neighbors');
assert.equal(plans[3].offset, 0, 'scene calibration must not pull a new shot toward the prior shot');
const calibrated = calibrateDepthFrame(new Float32Array([0.2, 0.58, 0.9]), plans[1]);
assert.ok(calibrated[1] < 0.58, 'calibration should reduce frame-wide height pumping');

console.log('Depth fusion/score smoke passed: bounded video guidance, quality ranking and scene-safe calibration.');
