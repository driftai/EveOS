import { voxelVisionApiUrl } from './runtime-paths.js';

const GRID_STEPS = Object.freeze([48, 64, 96, 128, 192, 256, 384, 512]);
const DEPTH_FPS_STEPS = Object.freeze([1, 2, 3, 4, 6, 8, 10, 12]);

const PROFILES = Object.freeze({
  safe: {
    id: 'safe',
    label: 'Safe',
    maxGridCols: 128,
    recommendedGridCols: 96,
    maxLiveVoxels: 18000,
    maxDepthFps: 3,
    recommendedDepthFps: 2
  },
  balanced: {
    id: 'balanced',
    label: 'Balanced',
    maxGridCols: 256,
    recommendedGridCols: 128,
    maxLiveVoxels: 65536,
    maxDepthFps: 6,
    recommendedDepthFps: 3
  },
  performance: {
    id: 'performance',
    label: 'Performance',
    maxGridCols: 384,
    recommendedGridCols: 192,
    maxLiveVoxels: 147456,
    maxDepthFps: 8,
    recommendedDepthFps: 4
  },
  extreme: {
    id: 'extreme',
    label: 'Extreme',
    maxGridCols: 512,
    recommendedGridCols: 256,
    maxLiveVoxels: 262144,
    maxDepthFps: 12,
    recommendedDepthFps: 6
  }
});

export const LUMA_FALLBACK_LIMITS = Object.freeze({
  maxGridCols: 256,
  recommendedGridCols: 192,
  maxDepthFps: 4,
  recommendedDepthFps: 3,
  heightScaleMultiplier: 0.72,
  depthCeiling: 0.75,
  kneeThreshold: 0.52
});

export function gridForLiveDetail(requestedDetail, width, height, maxDetail, maxVoxels) {
  const safeWidth = Number(width) > 0 ? Number(width) : 16;
  const safeHeight = Number(height) > 0 ? Number(height) : 9;
  const safeMaxDetail = Math.max(1, Number(maxDetail) || 128);
  const safeBudget = Math.max(1, Number(maxVoxels) || safeMaxDetail * safeMaxDetail);
  const detail = Math.max(1, Math.min(Number(requestedDetail) || 128, safeMaxDetail));
  const aspect = safeHeight / safeWidth;

  // Detail means the longest grid edge, matching Depth Anything's own
  // aspect-preserving 518-class preprocessing. A portrait source therefore
  // becomes (for example) 288 x 512 instead of accidentally becoming 512 x 910.
  let cols;
  let rows;
  if (safeWidth >= safeHeight) {
    cols = Math.round(detail);
    rows = Math.max(1, Math.round(cols * aspect));
  } else {
    rows = Math.round(detail);
    cols = Math.max(1, Math.round(rows / aspect));
  }

  const total = cols * rows;
  if (total > safeBudget) {
    const scale = Math.sqrt(safeBudget / total);
    cols = Math.max(1, Math.floor(cols * scale));
    rows = Math.max(1, Math.floor(rows * scale));
  }

  return { cols, rows };
}

function safeNumber(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function cleanGpuLabel(value) {
  return String(value || '')
    .replace(/ANGLE \(/i, '')
    .replace(/Direct3D\d+/ig, '')
    .replace(/vs_\d+_\d+|ps_\d+_\d+/ig, '')
    .replace(/\s+/g, ' ')
    .replace(/[(),]+$/g, '')
    .trim()
    .slice(0, 240);
}

function gpuTextLooksDiscrete(text) {
  return /\b(?:nvidia|geforce|quadro|radeon\s+rx|amd\s+radeon\s+rx|intel\s+arc\s+a\d|apple\s+m[1-9])\b/i.test(text);
}

function gpuTextLooksIntegrated(text) {
  return /\b(?:intel\s+(?:uhd|iris|hd)\b|radeon\s+(?:780m|760m|680m|660m)|adreno|mali)\b/i.test(text);
}

function gpuTextLooksHighEnd(text) {
  return /\b(?:rtx\s*(?:20|30|40|50)(?:60|70|80|90)|rx\s*(?:6|7|8|9)\d(?:00|50)|arc\s+a(?:7|9)\d{2}|apple\s+m[2-9]\s*(?:pro|max|ultra))\b/i.test(text);
}

function gpuTextLooksEntryDiscrete(text) {
  return /\b(?:rtx\s*(?:20|30|40|50)50|gtx\s*16\d{2}|rx\s*(?:5|6|7)\d50)\b/i.test(text);
}

function readWebGlRenderer() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl2', { powerPreference: 'high-performance' }) || canvas.getContext('webgl');
    if (!gl) return '';
    const extension = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = extension
      ? gl.getParameter(extension.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    return cleanGpuLabel(renderer);
  } catch {
    return '';
  }
}

async function readWebGpuInfo() {
  if (!navigator.gpu?.requestAdapter) {
    return { available: false, adapterLabel: '', limits: {} };
  }

  try {
    const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
    if (!adapter) return { available: false, adapterLabel: '', limits: {} };

    let info = adapter.info || null;
    if (!info && typeof adapter.requestAdapterInfo === 'function') {
      try { info = await adapter.requestAdapterInfo(); } catch {}
    }

    const adapterLabel = cleanGpuLabel([
      info?.vendor,
      info?.architecture,
      info?.device,
      info?.description
    ].filter(Boolean).join(' '));

    return {
      available: true,
      adapterLabel,
      limits: {
        maxBufferSize: safeNumber(adapter.limits?.maxBufferSize, 0),
        maxStorageBufferBindingSize: safeNumber(adapter.limits?.maxStorageBufferBindingSize, 0),
        maxTextureDimension2D: safeNumber(adapter.limits?.maxTextureDimension2D, 0)
      }
    };
  } catch {
    return { available: false, adapterLabel: '', limits: {} };
  }
}

async function readServerHardware() {
  try {
    const response = await fetch(voxelVisionApiUrl('/hardware'), { cache: 'no-store' });
    if (!response.ok) return null;
    const data = await response.json();
    return data && typeof data === 'object' ? data : null;
  } catch {
    return null;
  }
}

export function classifyMachineProfile(input = {}) {
  const cores = safeNumber(input.hardwareConcurrency, 4);
  const memoryGb = safeNumber(input.deviceMemoryGb, null);
  const systemMemoryGb = safeNumber(input.systemMemoryGb, memoryGb);
  const webgpu = Boolean(input.webgpu);
  const gpuText = cleanGpuLabel(input.gpuLabel);
  const maxBufferSize = safeNumber(input.maxBufferSize, 0);
  let score = 0;

  if (webgpu) score += 4;
  if (cores >= 16) score += 3;
  else if (cores >= 8) score += 2;
  else if (cores >= 4) score += 1;

  if (systemMemoryGb >= 16) score += 2;
  else if (systemMemoryGb >= 8) score += 1;

  if (gpuTextLooksDiscrete(gpuText)) score += 2;
  if (gpuTextLooksHighEnd(gpuText)) score += 2;
  else if (gpuTextLooksEntryDiscrete(gpuText)) score += 1;
  if (gpuTextLooksIntegrated(gpuText) && !gpuTextLooksDiscrete(gpuText)) score -= 1;
  if (maxBufferSize >= 1024 * 1024 * 1024) score += 1;

  let profile = PROFILES.safe;
  if (score >= 10) profile = PROFILES.extreme;
  else if (score >= 7) profile = PROFILES.performance;
  else if (score >= 4) profile = PROFILES.balanced;

  if (!webgpu && profile.id !== 'safe') profile = PROFILES.safe;

  return {
    ...profile,
    score,
    hardwareConcurrency: cores,
    deviceMemoryGb: memoryGb,
    systemMemoryGb,
    cpuModel: input.cpuModel || null,
    webgpu,
    gpuLabel: gpuText || null,
    gridSteps: GRID_STEPS.filter(value => value <= profile.maxGridCols),
    depthFpsSteps: DEPTH_FPS_STEPS.filter(value => value <= profile.maxDepthFps)
  };
}

export async function detectMachineProfile() {
  const [webgpu, serverHardware] = await Promise.all([
    readWebGpuInfo(),
    readServerHardware()
  ]);
  const webglLabel = readWebGlRenderer();
  const serverGpuLabels = Array.isArray(serverHardware?.gpuLabels) ? serverHardware.gpuLabels : [];
  const gpuLabel = [
    ...serverGpuLabels,
    webgpu.adapterLabel,
    webglLabel
  ].filter(Boolean).join(' | ');

  return classifyMachineProfile({
    hardwareConcurrency: serverHardware?.logicalCores || navigator.hardwareConcurrency || 4,
    deviceMemoryGb: navigator.deviceMemory || null,
    systemMemoryGb: serverHardware?.totalMemoryGb || navigator.deviceMemory || null,
    cpuModel: serverHardware?.cpuModel || null,
    webgpu: webgpu.available,
    gpuLabel,
    maxBufferSize: webgpu.limits.maxBufferSize
  });
}

export function describeMachineProfile(profile) {
  if (!profile) return 'Hardware profile unavailable';
  const parts = [`${profile.label} profile`];
  if (profile.gpuLabel) parts.push(profile.gpuLabel);
  parts.push(profile.webgpu ? 'WebGPU' : 'WASM fallback');
  if (profile.hardwareConcurrency) parts.push(`${profile.hardwareConcurrency} threads`);
  if (profile.systemMemoryGb) parts.push(`${profile.systemMemoryGb} GB RAM`);
  parts.push(`detail ≤ ${profile.maxGridCols} max edge`);
  parts.push(`AI ≤ ${profile.maxDepthFps} FPS before runtime tuning`);
  return parts.join(' · ');
}

export { GRID_STEPS, DEPTH_FPS_STEPS, PROFILES };
