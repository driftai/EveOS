/** Samples the depth actually presented by diagnostics against decoded color. */

import { scoreDepthConversion } from './depth-conversion-score.js';
import { buildLumaGuide } from './depth-processing.js';

export class RenderedDepthScorer {
  constructor({ maxSamplesPerSecond = 12 } = {}) {
    this.minimumInterval = 1 / Math.max(1, Number(maxSamplesPerSecond) || 12);
    this.reset();
  }

  reset() {
    this.lastFrameVersion = -1;
    this.lastMediaTime = null;
    this.previousFrame = null;
    this.previousGuide = null;
  }

  sample({
    frame,
    width,
    height,
    rgba = null,
    guide = null,
    frameVersion = 0,
    mediaTime = 0,
    sceneCut = false
  }) {
    if (!frame || frame.length !== width * height) return null;
    const version = Number(frameVersion) || 0;
    const time = Math.max(0, Number(mediaTime) || 0);
    if (version === this.lastFrameVersion) return null;

    const movedBackward = this.lastMediaTime != null && time + 0.001 < this.lastMediaTime;
    const largeGap = this.lastMediaTime != null && time - this.lastMediaTime > 1;
    const discontinuity = sceneCut || movedBackward || largeGap;
    if (!discontinuity && this.lastMediaTime != null && time - this.lastMediaTime < this.minimumInterval) {
      return null;
    }

    const colorGuide = guide || buildLumaGuide(rgba, frame.length);
    const result = scoreDepthConversion({
      frame,
      width,
      height,
      guide: colorGuide,
      previousFrame: discontinuity ? null : this.previousFrame,
      previousGuide: discontinuity ? null : this.previousGuide,
      sceneCut: discontinuity
    });
    if (!result) return null;
    this.lastFrameVersion = version;
    this.lastMediaTime = time;
    this.previousFrame = frame;
    this.previousGuide = colorGuide;
    return result;
  }
}
