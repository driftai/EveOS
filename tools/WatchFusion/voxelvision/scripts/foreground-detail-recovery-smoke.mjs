import assert from 'node:assert/strict';

import { recoverForegroundDetail } from '../public/js/foreground-detail-recovery.js';
import { recoverMaskedDepthGaps } from '../public/js/semantic-depth-recovery.js';

function fixture(width, height) {
  const cells = width * height;
  const depth = new Float32Array(cells).fill(0.15);
  const rgba = new Uint8ClampedArray(cells * 4);
  const paint = (x0, y0, x1, y1, color, value = null) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0; x < x1; x++) {
        const index = y * width + x;
        rgba.set([...color, 255], index * 4);
        if (value != null) depth[index] = value;
      }
    }
  };
  paint(0, 0, width, height, [30, 65, 155]);
  const faceX0 = Math.floor(width * 0.43);
  const faceX1 = Math.ceil(width * 0.58);
  const faceY0 = Math.floor(height * 0.42);
  const faceY1 = Math.ceil(height * 0.72);
  paint(faceX0, faceY0, faceX1, faceY1, [225, 170, 135], 0.72);
  const hairX0 = Math.floor(width * 0.34);
  const hairX1 = Math.ceil(width * 0.67);
  const hairY0 = Math.floor(height * 0.18);
  paint(hairX0, hairY0, hairX1, faceY0, [55, 24, 70], 0.16);
  return { depth, rgba, hairCenter: Math.floor((hairY0 + faceY0 - 1) / 2) * width + Math.floor((hairX0 + hairX1) / 2) };
}

for (const [width, height] of [[32, 24], [24, 32], [48, 18]]) {
  const { depth, rgba, hairCenter } = fixture(width, height);
  const recovered = recoverForegroundDetail(depth, width, height, rgba);
  assert.ok(recovered.metrics.regions >= 1, `a compact missed foreground region should be found at ${width}:${height}`);
  assert.ok(recovered.frame[hairCenter] > 0.5, 'missed hair should inherit bounded foreground depth evidence');
  assert.ok(Math.abs(recovered.frame[0] - 0.15) < 1e-6, 'frame-connected background must remain untouched');
  const repeated = recoverForegroundDetail(recovered.frame, width, height, rgba);
  assert.ok(Math.abs(repeated.frame[hairCenter] - recovered.frame[hairCenter]) < 1e-6, 'foreground repair should be idempotent');
}

const flat = new Float32Array(256).fill(0.4);
const blurred = fixture(64, 48);
for (let y = 20; y <= 21; y++) {
  for (let x = 27; x < 38; x++) blurred.depth[y * 64 + x] = 0.24 + (y - 20) * 0.2;
}
assert.ok(recoverForegroundDetail(blurred.depth, 64, 48, blurred.rgba).frame[blurred.hairCenter] > 0.5,
  'soft depth boundaries must not prevent supported foreground recovery');
const lit = fixture(64, 48);
for (let y = 9; y < 15; y++) {
  for (let x = 22; x < 43; x++) {
    const i = (y * 64 + x) * 4;
    for (let channel = 0; channel < 3; channel++) lit.rgba[i + channel] += 60;
  }
}
const litResult = recoverForegroundDetail(lit.depth, 64, 48, lit.rgba);
assert.ok(litResult.frame[12 * 64 + 30] > 0.5, 'a bounded illumination change must retain hair region membership');
const flatPixels = new Uint8ClampedArray(1024).fill(80);
assert.equal(recoverForegroundDetail(flat, 16, 16, flatPixels).frame, flat, 'color must not invent depth without model foreground evidence');

for (const [w, h] of [[64, 48], [48, 64], [96, 36]]) {
  const example = fixture(w, h);
  const mask = new Uint8Array(w * h);
  for (let i = 0; i < mask.length; i++) if (example.depth[i] > 0.155) mask[i] = 255;
  for (const brightness of [90, 120, 210]) {
    const colors = new Uint8ClampedArray(example.rgba);
    for (let i = 0; i < mask.length; i++) if (mask[i] && example.depth[i] < 0.2) {
      colors[i * 4] += brightness; colors[i * 4 + 1] += brightness * 0.8; colors[i * 4 + 2] += brightness * 0.6;
    }
    const result = recoverForegroundDetail(example.depth, w, h, colors, { semanticMask: mask });
    assert.ok(result.frame[example.hairCenter] > 0.56, 'independent mask evidence must retain foreground through clipped/hue-shifted lighting');
    assert.equal(result.frame[0], example.depth[0], 'unrelated background must stay unchanged');
    assert.ok(result.frame.every(Number.isFinite));
  }
}
assert.equal(recoverMaskedDepthGaps(flat, 16, 16, new Uint8Array(256).fill(255)).frame, flat,
  'a silhouette with no depth anchors must not create geometry');

console.log('Foreground detail recovery smoke passed.');
