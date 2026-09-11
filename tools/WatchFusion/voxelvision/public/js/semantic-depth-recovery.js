/** Repair a masked object's missed upper detail from compact, near depth anchors.
 * A silhouette provides membership only; all target heights come from the model.
 */
export function recoverMaskedDepthGaps(frame, width, height, mask) {
  const empty = { frame, metrics: { regions: 0, pixels: 0, maximumLift: 0, evidence: 'anime-mask' } };
  if (!mask || mask.length !== frame.length) return empty;
  const values = [];
  // ISNet returns soft alpha, not calibrated class probabilities. Lower-alpha
  // thin detail still needs connected, independent model-depth support.
  let maximumAlpha = 0;
  for (const value of mask) maximumAlpha = Math.max(maximumAlpha, value);
  if (maximumAlpha < 160) return empty;
  const maskFloor = Math.max(64, maximumAlpha * 0.38);
  for (let i = 0; i < frame.length; i++) if (mask[i] >= maskFloor) values.push(frame[i]);
  if (values.length < 16 || values.length > frame.length * 0.85) return empty;
  values.sort((a, b) => a - b);
  const median = values[Math.floor(values.length * 0.5)];
  const near = values[Math.floor(values.length * 0.98)];
  if (near - median < 0.12) return empty;
  const threshold = Math.max(median + 0.12, near - 0.035);
  const visited = new Uint8Array(frame.length);
  const out = new Float32Array(frame);
  let regions = 0, pixels = 0, maximumLift = 0;
  for (let start = 0; start < frame.length; start++) {
    if (visited[start] || mask[start] < maskFloor || frame[start] < threshold) continue;
    const queue = [start], anchors = [];
    visited[start] = 1;
    let minX = width, minY = height, maxX = 0, maxY = 0;
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const i = queue[cursor], x = i % width, y = Math.floor(i / width);
      anchors.push(frame[i]);
      minX = Math.min(minX, x); maxX = Math.max(maxX, x);
      minY = Math.min(minY, y); maxY = Math.max(maxY, y);
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) {
        if (j < 0 || j >= frame.length || visited[j] || mask[j] < maskFloor || frame[j] < threshold) continue;
        visited[j] = 1; queue.push(j);
      }
    }
    const aw = maxX - minX + 1, ah = maxY - minY + 1;
    if (anchors.length < Math.max(8, frame.length * 0.001) || anchors.length > frame.length * 0.08
      || anchors.length < aw * ah * 0.3 || aw / ah > 2.5 || ah / aw > 3
      || minX === 0 || maxX === width - 1 || maxY === height - 1) continue;
    anchors.sort((a, b) => a - b);
    const target = anchors[Math.floor(anchors.length * 0.5)] - 0.035;
    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    const x0 = Math.max(0, Math.floor(minX - aw * 0.85));
    const x1 = Math.min(width - 1, Math.ceil(maxX + aw * 0.85));
    const y0 = Math.max(0, Math.floor(minY - ah * 1.4));
    // Connected mask traversal prevents jumping to another foreground object.
    const reached = new Set(queue);
    for (let cursor = 0; cursor < queue.length; cursor++) {
      const i = queue[cursor], x = i % width, y = Math.floor(i / width);
      for (const j of [x > 0 ? i - 1 : -1, x + 1 < width ? i + 1 : -1, i - width, i + width]) {
        if (j < 0 || j >= frame.length || reached.has(j) || mask[j] < maskFloor) continue;
        const nx = j % width, ny = Math.floor(j / width);
        if (nx < x0 || nx > x1 || ny < y0 || ny > centerY) continue;
        reached.add(j); queue.push(j);
      }
    }
    let changed = 0;
    for (const i of reached) {
      if (frame[i] >= threshold || Math.floor(i / width) > centerY) continue;
      const x = i % width, y = Math.floor(i / width);
      const horizontal = Math.abs(x - centerX) / Math.max(1, aw * 1.35);
      const vertical = Math.max(0, minY - y) / Math.max(1, ah * 1.4);
      const spatial = Math.max(0, 1 - Math.max(horizontal, vertical) ** 4);
      const confidence = Math.min(1, Math.max(0, (mask[i] - maskFloor) / Math.max(20, maximumAlpha * 0.15)));
      const lift = Math.max(0, Math.min(0.7, (target - frame[i]) * 0.94 * spatial * confidence));
      if (lift < 0.005) continue;
      out[i] = Math.max(out[i], frame[i] + lift);
      maximumLift = Math.max(maximumLift, lift); changed++;
    }
    if (changed) { regions++; pixels += changed; }
  }
  return { frame: pixels ? out : frame, metrics: { regions, pixels, maximumLift, evidence: 'anime-mask' } };
}
