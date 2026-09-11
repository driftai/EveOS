/**
 * VoxelVision Depth Engine
 * Handles Depth Anything binary payloads, multi-res grid scaling,
 * and keyframe interpolation across scene cuts.
 */

function buildIntervals(baseDim, targetDim) {
  const intervals = [];
  for (let i = 0; i < targetDim; i++) {
    const start = Math.floor((i * baseDim) / targetDim);
    const end = Math.max(start + 1, Math.floor(((i + 1) * baseDim) / targetDim));
    intervals.push([start, Math.min(end, baseDim)]);
  }
  return intervals;
}

export class DepthData {
  static async load(jsonUrl) {
    const res = await fetch(jsonUrl);
    if (!res.ok) throw new Error(`HTTP ${res.status} loading depth metadata: ${jsonUrl}`);
    const meta = await res.json();

    const binUrl = new URL(meta.data, new URL(jsonUrl, window.location.href)).href;
    const binRes = await fetch(binUrl);
    if (!binRes.ok) throw new Error(`HTTP ${binRes.status} loading depth binary: ${binUrl}`);

    const compressed = new Uint8Array(await binRes.arrayBuffer());
    let decompressed;

    // Check gzip magic bytes (0x1F, 0x8B)
    if (compressed[0] === 31 && compressed[1] === 139) {
      if (typeof DecompressionStream !== 'undefined') {
        const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'));
        decompressed = new Uint8Array(await new Response(stream).arrayBuffer());
      } else {
        throw new Error('Browser lacks native DecompressionStream support.');
      }
    } else {
      decompressed = compressed;
    }

    return new DepthData(meta, decompressed);
  }

  constructor(meta, binaryData) {
    this.meta = meta;
    this.baseCols = meta.grid.cols;
    this.baseRows = meta.grid.rows;
    this.rate = meta.keyframeRate || 4;
    this.frameCount = meta.frameCount || 0;
    this.crop = meta.crop || null;
    this.sceneChanges = new Set(meta.sceneChanges || []);

    const expectedBytes = this.frameCount * this.baseCols * this.baseRows;
    if (binaryData.length < expectedBytes) {
      console.warn(`Depth data size mismatch: expected ${expectedBytes} bytes, got ${binaryData.length}`);
    }

    this.base = binaryData;
    this.baseKey = `${this.baseCols}x${this.baseRows}`;
    this.cache = new Map([[this.baseKey, binaryData]]);
    this.frameState = { first: 0, second: 0, blend: 0 };

    this.setGrid(this.baseCols, this.baseRows);
  }

  availableGrids(presetCols = [128, 96, 64, 48, 32, 24, 16]) {
    return presetCols
      .filter(cols => cols <= this.baseCols)
      .map(cols => ({
        cols,
        rows: this.rowsFor(cols)
      }));
  }

  rowsFor(cols) {
    return Math.max(1, Math.round((this.baseRows * cols) / this.baseCols));
  }

  setGrid(cols, rows = this.rowsFor(cols)) {
    const key = `${cols}x${rows}`;
    let data = this.cache.get(key);

    if (!data) {
      data = this.downsampleGrid(cols, rows);
      this.cache.set(key, data);
    }

    this.cols = cols;
    this.rows = rows;
    this.cells = cols * rows;
    this.data = data;
    this.heights = new Float32Array(this.cells);
    return this;
  }

  downsampleGrid(cols, rows) {
    const { baseCols, baseRows, frameCount, base } = this;
    const out = new Uint8Array(frameCount * cols * rows);
    const frameStride = baseCols * baseRows;
    const colIntervals = buildIntervals(baseCols, cols);
    const rowIntervals = buildIntervals(baseRows, rows);

    for (let f = 0; f < frameCount; f++) {
      const srcFrameOffset = f * frameStride;
      const dstFrameOffset = f * cols * rows;

      for (let r = 0; r < rows; r++) {
        const [rStart, rEnd] = rowIntervals[r];
        for (let c = 0; c < cols; c++) {
          const [cStart, cEnd] = colIntervals[c];
          let sum = 0;
          let count = 0;

          for (let y = rStart; y < rEnd; y++) {
            const rowOffset = srcFrameOffset + y * baseCols;
            for (let x = cStart; x < cEnd; x++) {
              sum += base[rowOffset + x];
              count++;
            }
          }
          out[dstFrameOffset + r * cols + c] = count ? Math.round(sum / count) : 0;
        }
      }
    }
    return out;
  }

  frame(idx) {
    const clamped = Math.max(0, Math.min(this.frameCount - 1, idx));
    const offset = clamped * this.cells;
    return this.data.subarray(offset, offset + this.cells);
  }

  framesAt(time, { smooth = true } = {}) {
    const continuousIndex = Math.max(0, time * this.rate);
    const first = Math.min(this.frameCount - 1, Math.floor(continuousIndex));
    const second = first + 1;
    let blend = continuousIndex - Math.floor(continuousIndex);

    let next = second;
    if (this.sceneChanges.has(second) || second >= this.frameCount) {
      next = first;
      blend = 0;
    } else if (smooth) {
      // Smoothstep easing for natural fluid motion without stutter
      blend = blend * blend * (3 - 2 * blend);
    }

    this.frameState.first = first;
    this.frameState.second = next;
    this.frameState.blend = blend;
    return this.frameState;
  }
}
