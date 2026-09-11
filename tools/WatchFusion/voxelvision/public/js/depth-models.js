/**
 * Browser depth-model profiles and deterministic model I/O helpers.
 *
 * Keeping model-specific shape, direction and transfer-curve behavior here
 * prevents a future model upgrade from silently reversing or distorting the
 * voxel relief.
 */

const IMAGENET_MEAN = Object.freeze([0.485, 0.456, 0.406]);
const IMAGENET_STD = Object.freeze([0.229, 0.224, 0.225]);

export const DEFAULT_DEPTH_MODEL = 'enhanced';
export const FALLBACK_DEPTH_MODEL = 'balanced';

export const DEPTH_MODEL_PROFILES = Object.freeze({
  enhanced: Object.freeze({
    key: 'enhanced',
    id: 'en970/depth-anything-v3-small-onnx',
    name: 'Depth Anything V3 Small',
    badge: 'DA3 Enhanced',
    loader: 'worker-model',
    rank5: true,
    outputDirection: 'far-high',
    toneMap: 'linear',
    maxInputEdge: 518,
    patchSize: 14,
    // The exported FP16 graph's only cubic Resize generates invalid WGSL on
    // some Chrome/D3D WebGPU stacks. Running this inexpensive positional-grid
    // resize on CPU preserves the original cubic math and keeps the rest of
    // DA3 on WebGPU.
    webGpuFp16CpuNodes: Object.freeze(['/backbone/Resize']),
    license: 'Apache-2.0',
    source: 'https://huggingface.co/en970/depth-anything-v3-small-onnx'
  }),
  balanced: Object.freeze({
    key: 'balanced',
    id: 'onnx-community/depth-anything-v2-small-ONNX',
    name: 'Depth Anything V2 Small',
    badge: 'DA2 Balanced',
    loader: 'worker-model',
    rank5: false,
    outputDirection: 'near-high',
    toneMap: 'log-inverse',
    maxInputEdge: 518,
    patchSize: 14,
    license: 'Apache-2.0',
    source: 'https://huggingface.co/onnx-community/depth-anything-v2-small-ONNX'
  })
});

export function getDepthModelProfile(key = DEFAULT_DEPTH_MODEL) {
  return DEPTH_MODEL_PROFILES[key] || DEPTH_MODEL_PROFILES[DEFAULT_DEPTH_MODEL];
}

export function depthModelFallbackOrder(requestedKey = DEFAULT_DEPTH_MODEL) {
  const requested = getDepthModelProfile(requestedKey);
  return requested.key === FALLBACK_DEPTH_MODEL
    ? [requested]
    : [requested, getDepthModelProfile(FALLBACK_DEPTH_MODEL)];
}

/**
 * Preserve the exact source aspect inside a patch-aligned model canvas. Any
 * padding is filled by the live engine with replicated edge pixels and cropped
 * away from the returned depth field.
 */
export function fitModelCapture(width, height, profileOrKey = DEFAULT_DEPTH_MODEL, maxEdgeOverride = null) {
  const profile = typeof profileOrKey === 'string'
    ? getDepthModelProfile(profileOrKey)
    : profileOrKey;
  const sourceWidth = Math.max(1, Number(width) || 1);
  const sourceHeight = Math.max(1, Number(height) || 1);
  const patch = Math.max(1, Math.round(profile.patchSize));
  const requestedMaxEdge = maxEdgeOverride != null && Number.isFinite(Number(maxEdgeOverride))
    ? Math.min(Number(maxEdgeOverride), profile.maxInputEdge)
    : profile.maxInputEdge;
  const maxEdge = Math.max(patch * 4, Math.round(requestedMaxEdge));
  const scale = maxEdge / Math.max(sourceWidth, sourceHeight);
  const contentWidth = Math.max(1, Math.round(sourceWidth * scale));
  const contentHeight = Math.max(1, Math.round(sourceHeight * scale));
  const canvasWidth = Math.ceil(contentWidth / patch) * patch;
  const canvasHeight = Math.ceil(contentHeight / patch) * patch;
  const contentX = Math.floor((canvasWidth - contentWidth) / 2);
  const contentY = Math.floor((canvasHeight - contentHeight) / 2);

  return {
    canvasWidth,
    canvasHeight,
    contentX,
    contentY,
    contentWidth,
    contentHeight,
    sourceAspect: sourceWidth / sourceHeight
  };
}

/** Convert RGBA pixels to the NCHW ImageNet-normalized layout used by DA2/DA3. */
export function rgbaToImageNetTensorData(rgba, width, height) {
  const pixels = Math.max(0, Math.round(width) * Math.round(height));
  if (!rgba || rgba.length < pixels * 4) {
    throw new Error('Depth model preprocessing received an incomplete RGBA frame.');
  }
  const data = new Float32Array(pixels * 3);
  const rScale = 1 / (255 * IMAGENET_STD[0]);
  const gScale = 1 / (255 * IMAGENET_STD[1]);
  const bScale = 1 / (255 * IMAGENET_STD[2]);
  const rShift = IMAGENET_MEAN[0] / IMAGENET_STD[0];
  const gShift = IMAGENET_MEAN[1] / IMAGENET_STD[1];
  const bShift = IMAGENET_MEAN[2] / IMAGENET_STD[2];
  for (let i = 0, src = 0; i < pixels; i++, src += 4) {
    data[i] = rgba[src] * rScale - rShift;
    data[pixels + i] = rgba[src + 1] * gScale - gShift;
    data[pixels * 2 + i] = rgba[src + 2] * bScale - bShift;
  }
  return data;
}

export function modelTensorDimensions(profileOrKey, width, height) {
  const profile = typeof profileOrKey === 'string'
    ? getDepthModelProfile(profileOrKey)
    : profileOrKey;
  return profile.rank5 ? [1, 1, 3, height, width] : [1, 3, height, width];
}

/**
 * Convert a model's native output into a monotonic near-is-high signal.
 * DA2 emits inverse depth, where logarithmic spacing recovers structure that
 * linear normalization compresses into the far end. DA3 emits direct depth,
 * so only its direction is reversed and no second logarithm is applied.
 */
export function prepareModelDepthSignal(values, profileOrKey = DEFAULT_DEPTH_MODEL) {
  const profile = typeof profileOrKey === 'string'
    ? getDepthModelProfile(profileOrKey)
    : profileOrKey;
  const out = new Float32Array(values.length);
  if (profile.toneMap === 'log-inverse') {
    let smallestPositive = Infinity;
    for (let i = 0; i < values.length; i++) {
      const value = Number(values[i]);
      if (Number.isFinite(value) && value > 0 && value < smallestPositive) smallestPositive = value;
    }
    const floor = Number.isFinite(smallestPositive) ? Math.max(1e-6, smallestPositive * 0.25) : 1e-4;
    for (let i = 0; i < values.length; i++) {
      const value = Number.isFinite(values[i]) ? values[i] : floor;
      out[i] = Math.log(Math.max(floor, value));
    }
    return out;
  }

  const direction = profile.outputDirection === 'far-high' ? -1 : 1;
  for (let i = 0; i < values.length; i++) {
    const value = Number(values[i]);
    out[i] = Number.isFinite(value) ? value * direction : 0;
  }
  return out;
}

export function tensorSpatialShape(tensor) {
  const dims = Array.isArray(tensor?.dims) ? tensor.dims : [];
  if (dims.length < 2) return null;
  const height = Number(dims[dims.length - 2]);
  const width = Number(dims[dims.length - 1]);
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  return { width, height };
}

/** Reject finite-looking but unusable GPU output before announcing readiness. */
export function validateDepthTensor(tensor, { roughnessLimit = 0.16 } = {}) {
  const shape = tensorSpatialShape(tensor);
  const values = tensor?.data;
  if (!shape || !values || values.length < shape.width * shape.height) {
    throw new Error('Depth model returned no usable depth tensor.');
  }
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < values.length; i++) {
    const value = Number(values[i]);
    if (!Number.isFinite(value)) throw new Error('Depth model produced non-finite output.');
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min;
  if (!(span > Math.max(1e-7, Math.max(Math.abs(min), Math.abs(max)) * 1e-7))) {
    throw new Error('Depth model produced a constant field.');
  }

  let variation = 0;
  let samples = 0;
  const cells = shape.width * shape.height;
  for (let y = 0; y < shape.height; y++) {
    const row = y * shape.width;
    for (let x = 0; x + 1 < shape.width && row + x + 1 < cells; x++) {
      variation += Math.abs(Number(values[row + x + 1]) - Number(values[row + x]));
      samples += 1;
    }
  }
  const roughness = samples ? variation / samples / span : 0;
  if (!Number.isFinite(roughness) || roughness > roughnessLimit) {
    throw new Error(`Depth model output failed structure validation (roughness ${roughness.toFixed(3)}).`);
  }
  return { ...shape, min, max, span, roughness };
}
