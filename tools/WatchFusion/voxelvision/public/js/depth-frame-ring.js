/** Bounded, least-recently-used Float32 depth-frame queue. */

const MIB = 1024 * 1024;

export function memoryBudgetForSystemRam(systemMemoryGb) {
  const memory = Number(systemMemoryGb);
  if (!Number.isFinite(memory) || memory <= 0) return 192 * MIB;
  // Roughly 0.8% of system RAM, with conservative limits for both small and
  // very large machines.
  return Math.round(Math.min(768, Math.max(128, memory * 8)) * MIB);
}

export class DepthFrameRing {
  constructor(maxBytes = memoryBudgetForSystemRam(null)) {
    this.maxBytes = Math.max(MIB, Number(maxBytes) || MIB);
    this.bytes = 0;
    this.frames = new Map();
  }

  setBudgetBytes(maxBytes) {
    this.maxBytes = Math.max(MIB, Number(maxBytes) || MIB);
    this.#evict();
  }

  clear() {
    this.frames.clear();
    this.bytes = 0;
  }

  has(index) {
    return this.frames.has(Number(index));
  }

  get(index) {
    const key = Number(index);
    const record = this.frames.get(key);
    if (!record) return null;
    this.frames.delete(key);
    this.frames.set(key, record);
    return record;
  }

  set(index, frame, metadata = {}) {
    if (!(frame instanceof Float32Array)) throw new TypeError('RAM depth frames must be Float32Array values.');
    const key = Number(index);
    const existing = this.frames.get(key);
    if (existing) this.bytes -= existing.byteLength || existing.frame.byteLength;
    this.frames.delete(key);
    const metadataBytes = metadata.guide?.byteLength || 0;
    const record = { index: key, frame, ...metadata, byteLength: frame.byteLength + metadataBytes };
    this.frames.set(key, record);
    this.bytes += record.byteLength;
    this.#evict(key);
    return record;
  }

  snapshot() {
    return {
      frames: this.frames.size,
      bytes: this.bytes,
      maxBytes: this.maxBytes
    };
  }

  #evict(protectedIndex = null) {
    while (this.bytes > this.maxBytes && this.frames.size > 1) {
      const oldest = this.frames.keys().next().value;
      if (oldest === protectedIndex) {
        const protectedRecord = this.frames.get(oldest);
        this.frames.delete(oldest);
        this.frames.set(oldest, protectedRecord);
        continue;
      }
      const record = this.frames.get(oldest);
      this.frames.delete(oldest);
      this.bytes -= record.byteLength || record.frame.byteLength;
    }
  }
}
