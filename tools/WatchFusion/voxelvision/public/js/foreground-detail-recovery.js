/**
 * Conservative mask-guided repair for small foreground regions that a depth
 * model merged into the background. It targets flat/illustrated color regions
 * adjacent to confirmed foreground and never assigns depth from color alone.
 */

import { recoverMaskedDepthGaps } from './semantic-depth-recovery.js';

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function sampledQuantile(values, q) {
  const step = Math.max(1, Math.floor(values.length / 8192));
  const sample = [];
  for (let index = 0; index < values.length; index += step) {
    if (Number.isFinite(values[index])) sample.push(values[index]);
  }
  sample.sort((a, b) => a - b);
  return sample[Math.round((sample.length - 1) * q)] || 0;
}

function colorDistanceSq(rgba, first, second) {
  const a = first * 4;
  const b = second * 4;
  const red = rgba[a] - rgba[b];
  const green = rgba[a + 1] - rgba[b + 1];
  const blue = rgba[a + 2] - rgba[b + 2];
  return red * red + green * green + blue * blue;
}

function lightingCompatible(rgba, first, second) {
  const a = first * 4;
  const b = second * 4;
  const dr = rgba[a] - rgba[b];
  const dg = rgba[a + 1] - rgba[b + 1];
  const db = rgba[a + 2] - rgba[b + 2];
  const illumination = (dr + dg + db) / 3;
  return Math.abs(illumination) <= 65
    && (dr - illumination) ** 2 + (dg - illumination) ** 2 + (db - illumination) ** 2 < 22 ** 2;
}

function findForegroundContact(frame, rgba, index, width, height, foregroundFloor, minDepthGap) {
  let best = null;
  const x = index % width;
  const y = Math.floor(index / width);
  const radius = Math.max(3, Math.min(6, Math.ceil(Math.max(width, height) / 128)));
  for (let offsetY = -radius; offsetY <= radius; offsetY++) {
    const nextY = y + offsetY;
    if (nextY < 0 || nextY >= height) continue;
    for (let offsetX = -radius; offsetX <= radius; offsetX++) {
      const nextX = x + offsetX;
      if ((offsetX === 0 && offsetY === 0) || nextX < 0 || nextX >= width) continue;
      const neighbor = nextY * width + nextX;
      const gap = frame[neighbor] - frame[index];
      if (frame[neighbor] < foregroundFloor || gap < minDepthGap) continue;
      if (colorDistanceSq(rgba, index, neighbor) < 18 * 18) continue;
      if (best == null || frame[neighbor] > frame[best]) best = neighbor;
    }
  }
  return best;
}

function growColorRegion(frame, rgba, start, contactDepth, width, height, visited, options) {
  const queue = [start];
  const region = [];
  const contacts = [];
  let cursor = 0;
  let touchedBorder = false;
  let minX = width;
  let maxX = 0;
  let minY = height;
  let maxY = 0;
  while (cursor < queue.length && region.length <= options.maxRegionCells) {
    const index = queue[cursor++];
    if (visited[index]) continue;
    visited[index] = 1;
    region.push(index);
    const x = index % width;
    const y = Math.floor(index / width);
    minX = Math.min(minX, x);
    maxX = Math.max(maxX, x);
    minY = Math.min(minY, y);
    maxY = Math.max(maxY, y);
    if (x === 0 || y === 0 || x + 1 === width || y + 1 === height) touchedBorder = true;
    for (let offsetY = -1; offsetY <= 1; offsetY++) {
      const nextY = y + offsetY;
      if (nextY < 0 || nextY >= height) continue;
      for (let offsetX = -1; offsetX <= 1; offsetX++) {
        const nextX = x + offsetX;
        if ((offsetX === 0 && offsetY === 0) || nextX < 0 || nextX >= width) continue;
        const neighbor = nextY * width + nextX;
        if (frame[neighbor] >= contactDepth - options.minDepthGap * 0.4) {
          contacts.push(neighbor);
          continue;
        }
        if (visited[neighbor]) continue;
        const localColor = colorDistanceSq(rgba, index, neighbor);
        const seedColor = colorDistanceSq(rgba, start, neighbor);
        const sameMaterial = lightingCompatible(rgba, start, neighbor);
        if ((localColor <= options.localColorDistanceSq || lightingCompatible(rgba, index, neighbor))
          && (seedColor <= options.seedColorDistanceSq || sameMaterial)) queue.push(neighbor);
      }
    }
  }
  return { region, contacts, touchedBorder, minX, maxX, minY, maxY };
}

/**
 * Recover compact, edge-bounded color masks beside an already-confirmed near
 * surface. The vertical gate favors hair/headwear-like regions above a face
 * while keeping background holes and large walls untouched.
 */
export function recoverForegroundDetail(frame, width, height, rgba, settings = {}) {
  const cells = width * height;
  if (!(frame instanceof Float32Array) || frame.length !== cells || !rgba || rgba.length < cells * 4 || width < 8 || height < 8) {
    return { frame, metrics: { regions: 0, pixels: 0, maximumLift: 0 } };
  }
  const options = {
    minDepthGap: settings.minDepthGap ?? 0.14,
    maxLift: settings.maxLift ?? 0.44,
    semanticMask: settings.semanticMask?.length === cells ? settings.semanticMask : null,
    maxRegionCells: Math.max(12, Math.floor(cells * (settings.maxRegionRatio ?? 0.14))),
    localColorDistanceSq: (settings.localColorDistance ?? 54) ** 2,
    seedColorDistanceSq: (settings.seedColorDistance ?? 92) ** 2
  };
  if (options.semanticMask) return recoverMaskedDepthGaps(frame, width, height, options.semanticMask);
  const median = sampledQuantile(frame, 0.5);
  const high = sampledQuantile(frame, 0.98);
  const foregroundFloor = Math.max(median + 0.08, median + (high - median) * 0.55);
  if (high - sampledQuantile(frame, 0.28) < options.minDepthGap) {
    return { frame, metrics: { regions: 0, pixels: 0, maximumLift: 0 } };
  }

  const visited = new Uint8Array(cells);
  const out = new Float32Array(frame);
  let recoveredRegions = 0;
  let recoveredPixels = 0;
  let maximumLift = 0;
  for (let index = 0; index < cells; index++) {
    if (visited[index] || frame[index] >= foregroundFloor) continue;
    const firstContact = findForegroundContact(frame, rgba, index, width, height, foregroundFloor, options.minDepthGap);
    if (firstContact == null) continue;
    const grown = growColorRegion(frame, rgba, index, frame[firstContact], width, height, visited, options);
    const { region, contacts } = grown;
    if (region.length < 3 || region.length > options.maxRegionCells || grown.touchedBorder) continue;
    const boxArea = (grown.maxX - grown.minX + 1) * (grown.maxY - grown.minY + 1);
    // Model upsampling can put a soft transition between the color boundary
    // and confirmed foreground. Collect support across that narrow band.
    const support = new Set(contacts);
    for (const cell of region) {
      const contact = findForegroundContact(frame, rgba, cell, width, height, foregroundFloor, options.minDepthGap);
      if (contact != null) support.add(contact);
    }
    const uniqueContacts = [...support].filter(contact => frame[contact] >= foregroundFloor);
    if (boxArea > region.length * 4.5 || uniqueContacts.length < Math.max(2, Math.sqrt(region.length) * 0.24)) continue;
    const regionY = region.reduce((sum, cell) => sum + Math.floor(cell / width), 0) / region.length;
    const contactY = uniqueContacts.reduce((sum, cell) => sum + Math.floor(cell / width), 0) / uniqueContacts.length;
    if (regionY > contactY + height * 0.055) continue;
    const contactDepths = uniqueContacts.map(cell => frame[cell]).sort((a, b) => a - b);
    const contactSpread = contactDepths[Math.floor(contactDepths.length * 0.8)] - contactDepths[Math.floor(contactDepths.length * 0.2)];
    if (contactSpread > 0.18) continue;
    const targetDepth = contactDepths[Math.floor(contactDepths.length / 2)] - 0.018;
    for (const cell of region) {
      const desired = frame[cell] + (targetDepth - frame[cell]) * 0.86;
      const repaired = clamp(Math.max(frame[cell], Math.min(frame[cell] + options.maxLift, desired)), 0, 1);
      maximumLift = Math.max(maximumLift, repaired - frame[cell]);
      out[cell] = repaired;
    }
    recoveredRegions += 1;
    recoveredPixels += region.length;
  }
  return { frame: recoveredRegions ? out : frame, metrics: { regions: recoveredRegions, pixels: recoveredPixels, maximumLift } };
}
