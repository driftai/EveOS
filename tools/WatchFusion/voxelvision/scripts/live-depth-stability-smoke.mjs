import assert from 'node:assert/strict';

import {
  blendDepthFrames,
  buildLumaGuide,
  conditionDepthFrame,
  correctBroadDepthBias,
  detectLiveSceneCut,
  fitAspectDimensions,
  limitGlobalDepthTilt,
  LiveDepthEngine,
  normalizeFloatDepth,
  refineDepthWithGuidance,
  repairDepthBorders,
  repairSuspiciousBorders,
  stabilizeDepth,
  stabilizeDepthMotionAware,
  stabilizeDepthStatistics,
  stabilizeRangeBounds
} from '../public/js/live-depth.js';
import { resolveDepthDiagnosticView } from '../public/js/depth-diagnostic-view.js';

const approximately = (actual, expected, epsilon = 1e-6) => Math.abs(actual - expected) <= epsilon;

const waitingDiagnostic = resolveDepthDiagnosticView({ stage: 'final', depthMode: 'live', playbackMode: 'hybrid' });
assert.equal(waitingDiagnostic.visible, true, 'A selected diagnostic must remain visible while its frame is pending');
assert.equal(waitingDiagnostic.ready, false, 'A pending diagnostic must not reuse a stale canvas frame');

const diagnosticFrame = new Float32Array([0.1, 0.2, 0.3, 0.4]);
const playbackDiagnostic = { frame: diagnosticFrame, width: 2, height: 2, origin: 'bundled' };
const bundledFinal = resolveDepthDiagnosticView({ stage: 'final', depthMode: 'cached', playbackDiagnostic });
assert.equal(bundledFinal.ready, true, 'Final Render Depth must accept the bundled authored cache');
assert.equal(bundledFinal.kind, 'playback', 'Hybrid and bundled final diagnostics must reflect rendered playback depth');

const unavailableRaw = resolveDepthDiagnosticView({ stage: 'raw', depthMode: 'cached', playbackDiagnostic });
assert.equal(unavailableRaw.visible, true, 'Unavailable stages must explain themselves instead of hiding the panel');
assert.match(unavailableRaw.message, /imported video/i);

const liveRaw = resolveDepthDiagnosticView({
  stage: 'raw',
  depthMode: 'live',
  playbackMode: 'live',
  liveDiagnostics: { raw: diagnosticFrame, width: 2, height: 2 }
});
assert.equal(liveRaw.ready, true, 'Live diagnostic frames must become renderable when asynchronously published');

for (const [width, height, expectedWidth, expectedHeight] of [
  [1920, 1080, 518, 291],
  [1080, 1920, 291, 518],
  [1024, 1024, 518, 518],
  [3840, 960, 518, 130],
  [960, 3840, 130, 518]
]) {
  const fitted = fitAspectDimensions(width, height, 518);
  assert.deepEqual(fitted, { width: expectedWidth, height: expectedHeight });
  assert.equal(Math.max(fitted.width, fitted.height), 518, 'Every source must retain true max-edge semantics');
  assert.ok(
    Math.abs(fitted.width / fitted.height - width / height) < 0.02,
    'Capture sizing must preserve landscape, portrait, square, and ultrawide aspect ratios'
  );
}

const primaryGuide = buildLumaGuide(new Uint8ClampedArray([
  255, 0, 0, 255,
  0, 255, 0, 255,
  0, 0, 255, 255
]), 3);
assert.deepEqual([...primaryGuide], [76, 150, 29], 'RGB guidance should use perceptual luminance');
assert.equal(buildLumaGuide(new Uint8Array(3), 1), null, 'Incomplete pixels must not create guidance');

const stableDepth = stabilizeDepth(
  new Uint8Array([10]),
  new Uint8Array([0]),
  new Uint8Array([80]),
  new Uint8Array([80])
);
assert.ok(stableDepth[0] > 0 && stableDepth[0] < 10, 'Static byte-depth regions should retain temporal smoothing');

const movingDepth = stabilizeDepth(
  new Uint8Array([10]),
  new Uint8Array([0]),
  new Uint8Array([255]),
  new Uint8Array([0])
);
assert.equal(movingDepth[0], 10, 'Strong visual motion should update without a ghost trail');

const floatStable = stabilizeDepth(
  new Float32Array([0.501]),
  new Float32Array([0.5]),
  new Uint8Array([90]),
  new Uint8Array([90])
);
assert.ok(floatStable instanceof Float32Array, 'Live normalized depth must remain Float32');
assert.ok(floatStable[0] > 0.5 && floatStable[0] < 0.501, 'Float temporal smoothing must preserve sub-byte precision');

const precise = normalizeFloatDepth(
  new Float32Array([0, 0.001, 0.002, 1]),
  0,
  1,
  { knee: 1, ceiling: 1 }
);
assert.ok(precise instanceof Float32Array, 'Normalization must not quantize live depth to Uint8');
assert.ok(precise[2] > precise[1] && precise[1] > precise[0], 'Sub-1/255 depth differences must survive normalization');

const blended = blendDepthFrames(new Uint8Array([0, 255]), new Float32Array([1, 0]), 0.5);
assert.ok(blended instanceof Float32Array, 'Live handoffs must preserve normalized float precision');
assert.ok(blended[0] > 0 && blended[0] < 1 && blended[1] > 0 && blended[1] < 1, 'Byte and float frames must blend on one normalized scale');

const contracted = stabilizeRangeBounds(0, 1, 0.2, 0.8);
assert.ok(contracted.low < 0.05 && contracted.high > 0.95, 'Range contraction must be slow enough to prevent panel-wide pumping');
const expanded = stabilizeRangeBounds(0.2, 0.8, 0, 1);
assert.ok(expanded.low < 0.15 && expanded.high > 0.85, 'Newly exposed range must be accepted faster than contraction');

const pumped = new Float32Array([0.3, 0.5, 0.7, 0.9]);
const anchored = stabilizeDepthStatistics(pumped, new Float32Array([0.2, 0.4, 0.6, 0.8]));
assert.ok(anchored.metrics.offset < 0, 'A frame-wide height jump should be anchored toward the prior surface');
assert.ok(anchored.frame[3] - anchored.frame[0] > 0.5, 'Statistical anchoring must preserve local depth relief');

const motionWidth = 12;
const motionHeight = 10;
const previousMotionGuide = new Uint8Array(motionWidth * motionHeight);
const currentMotionGuide = new Uint8Array(motionWidth * motionHeight);
const previousMotionDepth = new Float32Array(motionWidth * motionHeight).fill(0.2);
const currentMotionDepth = new Float32Array(motionWidth * motionHeight).fill(0.2);
for (let y = 1; y < motionHeight - 1; y++) {
  for (let x = 2; x <= 3; x++) {
    previousMotionGuide[y * motionWidth + x] = 240;
    previousMotionDepth[y * motionWidth + x] = 0.8;
  }
  for (let x = 3; x <= 4; x++) {
    currentMotionGuide[y * motionWidth + x] = 240;
    currentMotionDepth[y * motionWidth + x] = 0.8;
  }
}
const motionStabilized = stabilizeDepthMotionAware(
  currentMotionDepth,
  previousMotionDepth,
  motionWidth,
  motionHeight,
  currentMotionGuide,
  previousMotionGuide
);
assert.ok(motionStabilized.motion.x < 0, 'Temporal stabilization should follow a translated scene instead of leaving a ghost');
assert.ok(motionStabilized.frame[2 * motionWidth + 4] > 0.7, 'A moved foreground edge must update at its current position');

const tilted = new Float32Array(16 * 8);
for (let y = 0; y < 8; y++) {
  for (let x = 0; x < 16; x++) tilted[y * 16 + x] = 0.1 + (0.8 * x) / 15;
}
const tiltLimited = limitGlobalDepthTilt(tilted, 16, 8);
const originalSlope = tilted[15] - tilted[0];
const limitedSlope = tiltLimited[15] - tiltLimited[0];
assert.ok(limitedSlope < originalSlope, 'Excessive whole-panel tilt should be reduced');
assert.ok(limitedSlope > 0.2, 'Tilt correction must preserve meaningful scene perspective');

const adaptiveBias = correctBroadDepthBias(tilted, 16, 8);
assert.ok(adaptiveBias.metrics.xStrength > 0, 'An implausible broad axis bias should be detected');
assert.ok(adaptiveBias.frame[15] - adaptiveBias.frame[0] > 0.15, 'Adaptive bias correction must not flatten all perspective');

const bordered = new Float32Array(16 * 16).fill(0.4);
for (let y = 14; y < 16; y++) {
  for (let x = 0; x < 16; x++) bordered[y * 16 + x] = 0.95;
}
const repairedBorder = repairSuspiciousBorders(bordered, 16, 16);
assert.ok(repairedBorder[15 * 16] < 0.95, 'A uniform extreme bottom wall should taper toward credible interior depth');
assert.ok(approximately(repairedBorder[8 * 16 + 8], 0.4), 'Border repair must not flatten the interior scene');

const segmented = new Float32Array(80 * 40).fill(0.4);
for (let y = 38; y < 40; y++) {
  for (let x = 24; x < 48; x++) segmented[y * 80 + x] = 0.96;
}
const segmentedRepair = repairDepthBorders(segmented, 80, 40);
assert.ok(segmentedRepair.metrics.repairedSegments > 0, 'Localized border walls should be detected by segment');
assert.ok(segmentedRepair.frame[39 * 80 + 30] < 0.96, 'Only the suspicious edge segment should taper');
assert.ok(approximately(segmentedRepair.frame[39 * 80 + 4], 0.4), 'Credible neighboring border content must remain untouched');

for (const [width, height] of [[64, 36], [36, 64], [48, 48], [96, 24]]) {
  const cells = width * height;
  const frame = new Float32Array(cells);
  const guide = new Uint8Array(cells);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const idx = y * width + x;
      frame[idx] = 0.15 + 0.55 * (x / Math.max(1, width - 1)) + 0.08 * Math.sin(y * 0.31);
      guide[idx] = x < width / 2 ? 45 : 205;
    }
  }
  const conditioned = conditionDepthFrame(frame, width, height, guide);
  assert.equal(conditioned.frame.length, cells, 'Conditioning must retain every aspect-specific cell');
  assert.ok(conditioned.frame instanceof Float32Array, 'Conditioning must retain float precision');
  assert.ok(conditioned.frame.every(Number.isFinite), 'Conditioning must never emit invalid geometry');
  assert.ok(conditioned.frame.every((value, index) => Math.abs(value - frame[index]) <= 0.120001),
    'stacked non-semantic corrections must obey one total geometry displacement budget');
}

let falsePeak = new Float32Array(64).fill(0.95);
const credibleSurface = new Float32Array(64).fill(0.35);
const unchangedLogo = new Uint8Array(64).fill(120);
for (let i = 0; i < 12; i++) falsePeak = stabilizeDepthMotionAware(credibleSurface, falsePeak, 8, 8, unchangedLogo, unchangedLogo).frame;
assert.ok(falsePeak[20] < 0.43, 'unchanged image evidence must not lock an initially wrong near-maximum height');

const guidedEdge = new Float32Array(20 * 10);
const edgeGuide = new Uint8Array(20 * 10);
for (let y = 0; y < 10; y++) {
  for (let x = 0; x < 20; x++) {
    guidedEdge[y * 20 + x] = x < 10 ? 0.2 : 0.8;
    edgeGuide[y * 20 + x] = x < 10 ? 20 : 230;
  }
}
const refinedEdge = refineDepthWithGuidance(guidedEdge, 20, 10, edgeGuide);
assert.ok(refinedEdge[5 * 20 + 9] < 0.3 && refinedEdge[5 * 20 + 10] > 0.7, 'Color guidance must preserve supported object boundaries');

const initialFrame = detectLiveSceneCut(new Float32Array([0.1]), null);
assert.equal(initialFrame.isSceneCut, true, 'The first live-depth frame must not blend from stale state');

const flashCut = detectLiveSceneCut(
  new Float32Array(16).fill(0.4),
  new Float32Array(16).fill(0.4),
  new Uint8Array(16).fill(255),
  new Uint8Array(16).fill(0)
);
assert.equal(flashCut.isSceneCut, true, 'A visual cut should be caught even when predicted depth barely changes');
assert.equal(flashCut.visualDifference, 255);

const continuousFrame = detectLiveSceneCut(
  new Float32Array([0.40, 0.41, 0.42, 0.43]),
  new Float32Array([0.395, 0.405, 0.415, 0.425]),
  new Uint8Array([90, 92, 94, 96]),
  new Uint8Array([88, 90, 92, 94])
);
assert.equal(continuousFrame.isSceneCut, false, 'Small neighboring-frame changes should remain smooth');

const captureWidth = 518;
const captureHeight = Math.round(captureWidth * 9 / 16);
const capturePixels = new Uint8ClampedArray(captureWidth * captureHeight * 4).fill(128);
const mockContext = {
  imageSmoothingEnabled: false,
  imageSmoothingQuality: 'low',
  clearRect() {},
  drawImage() {},
  getImageData() {
    return { data: capturePixels };
  }
};

globalThis.document = {
  createElement() {
    return {
      width: 0,
      height: 0,
      getContext() {
        return mockContext;
      }
    };
  }
};
globalThis.HTMLMediaElement = { HAVE_CURRENT_DATA: 2 };

const video = { readyState: 2 };
const rgba2x2 = new Uint8ClampedArray(16).fill(96);
const prediction = {
  predicted_depth: {
    dims: [2, 2],
    data: new Float32Array([0.1, 0.2, 0.3, 0.4])
  }
};

const cancellationEngine = new LiveDepthEngine();
cancellationEngine.backend = 'webgpu';
cancellationEngine.activeModelKey = 'balanced';
cancellationEngine.RawImage = { fromCanvas: canvas => canvas };
let finishStaleInference;
cancellationEngine.pipeline = {
  run: () => new Promise(resolve => {
    finishStaleInference = resolve;
  })
};
const staleJob = cancellationEngine.maybeUpdate(video, 2, 2, rgba2x2);
while (typeof finishStaleInference !== 'function') {
  await new Promise(resolve => setImmediate(resolve));
}
assert.equal(cancellationEngine.maybeUpdate(video, 2, 2, rgba2x2), null, 'Busy inference must not queue an obsolete frame copy');
assert.equal(cancellationEngine.forceNext, true, 'A newer decoded frame should schedule one latest-frame follow-up');
cancellationEngine.requestImmediate({ resetTemporal: true });
finishStaleInference(prediction);
assert.equal(await staleJob, null, 'A reset must discard an in-flight depth result');
assert.equal(cancellationEngine.previousStableDepth, null, 'A stale result must not mutate temporal history');

const precisionEngine = new LiveDepthEngine();
precisionEngine.backend = 'webgpu';
precisionEngine.activeModelKey = 'balanced';
precisionEngine.captureLayout = {
  canvasWidth: 2,
  canvasHeight: 2,
  contentX: 0,
  contentY: 0,
  contentWidth: 2,
  contentHeight: 2
};
precisionEngine.RawImage = { fromCanvas: canvas => canvas };
precisionEngine.pipeline = { run: async () => prediction };
const precisionFrame = await precisionEngine.maybeUpdate(video, 2, 2, rgba2x2, {
  frameVersion: 9,
  mediaTime: 12.5,
  sourceGeneration: 3
});
assert.ok(precisionFrame instanceof Float32Array, 'A real AI result must reach the renderer as Float32 depth');
assert.equal(precisionEngine.getLastResultMeta().mediaTime, 12.5, 'Completed depth must retain its decoded-video timestamp');
const diagnostics = precisionEngine.getDiagnostics();
assert.deepEqual([diagnostics.width, diagnostics.height], [2, 2], 'Diagnostics should describe their exact depth grid');
assert.ok(approximately(diagnostics.raw[0], 0.1), 'Raw diagnostics must expose model values before normalization');
assert.notEqual(diagnostics.raw, diagnostics.normalized, 'Raw and normalized diagnostics must be distinct pipeline stages');

const readyAnnouncements = [];
const warmEngine = new LiveDepthEngine({ onStatus: state => readyAnnouncements.push(state) });
warmEngine.readyStatus = { phase: 'ready', message: 'Warm model ready.' };
warmEngine.announceReady();
assert.equal(readyAnnouncements.at(-1)?.phase, 'ready', 'A reused model must re-announce readiness for the next video source');

const statuses = [];
let failedCalls = 0;
let disposeCalls = 0;
const breakerEngine = new LiveDepthEngine({ onStatus: state => statuses.push(state) });
breakerEngine.backend = 'webgpu';
breakerEngine.activeModelKey = 'balanced';
breakerEngine.RawImage = { fromCanvas: canvas => canvas };
breakerEngine.pipeline = {
  async run() {
    failedCalls += 1;
    throw new Error('intentional smoke failure');
  },
  async dispose() {
    disposeCalls += 1;
  }
};

const originalWarn = console.warn;
console.warn = () => {};
try {
  for (let attempt = 1; attempt <= 3; attempt++) {
    breakerEngine.requestImmediate();
    const frame = await breakerEngine.maybeUpdate(video, 2, 2, rgba2x2);
    if (attempt < 3) assert.equal(frame, null, `Failure ${attempt} should preserve the previous surface`);
    else {
      assert.equal(frame.length, 4, 'The breaker should return one correctly sized fallback frame');
      assert.ok(frame instanceof Float32Array, 'Fallback depth should also preserve float geometry precision');
    }
  }
} finally {
  console.warn = originalWarn;
}

assert.equal(failedCalls, 3, 'The breaker should trip after exactly three consecutive failures');
assert.equal(breakerEngine.backend, 'luma', 'Three failures should retire the unstable AI backend');
assert.equal(disposeCalls, 1, 'The failed pipeline should be disposed once');
assert.equal(statuses.at(-1)?.phase, 'fallback', 'The UI should receive the fallback state');

console.log('Live-depth stability and fidelity smoke tests passed.');
