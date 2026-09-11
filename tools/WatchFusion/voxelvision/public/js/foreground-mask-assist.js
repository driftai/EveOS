/** Sparse, bounded auxiliary inference. Masks are tied to captured image evidence. */
export class ForegroundMaskAssist {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.enabled = false;
    this.worker = null;
    this.ready = false;
    this.pending = null;
    this.cached = null;
    this.id = 0;
    this.epoch = 0;
    this.interval = 0.5;
    this.loading = null;
    this.finishLoading = null;
    this.failed = false;
  }

  reset() { this.cached = null; this.epoch++; }

  setEnabled(enabled, { defer = false } = {}) {
    const next = Boolean(enabled);
    if (!next) {
      this.enabled = false;
      this.reset();
      this.#stopWorker();
      this.onStatus('Off');
      return Promise.resolve(false);
    }

    this.enabled = true;
    this.failed = false;
    if (defer && this.loading) {
      this.reset();
      this.#stopWorker();
    }
    if (this.ready) return Promise.resolve(true);
    if (this.loading) return this.loading;
    if (defer) {
      this.onStatus('Selected - loads only when uncached assisted frames are needed');
      return Promise.resolve(false);
    }
    return this.ensureReady();
  }

  ensureReady({ retry = false } = {}) {
    if (!this.enabled) return Promise.resolve(false);
    if (this.ready) return Promise.resolve(true);
    if (this.loading) return this.loading;
    if (this.failed && !retry) return Promise.resolve(false);

    this.failed = false;
    this.reset();
    this.#stopWorker();
    this.loading = new Promise(resolve => { this.finishLoading = resolve; });
    this.onStatus('Loading optional anime mask model (~176 MB)...');
    this.#startWorker();
    return this.loading;
  }

  #stopWorker() {
    this.worker?.terminate();
    this.worker = null;
    this.ready = false;
    this.pending?.resolve(null);
    clearTimeout(this.timer);
    this.pending = null;
    this.finishLoading?.(false);
    this.finishLoading = null;
    this.loading = null;
  }

  #startWorker() {
    try {
      this.worker = new Worker(new URL('./foreground-mask-worker.js', import.meta.url), { type: 'module' });
      const worker = this.worker;
      this.timer = setTimeout(() => this.fail(), 120000);
      this.worker.onerror = () => this.fail();
      this.worker.onmessage = ({ data }) => {
        if (this.worker !== worker) return;
        if (data.type === 'ready') {
          clearTimeout(this.timer);
          this.ready = true;
          this.finishLoading?.(true);
          this.finishLoading = null;
          this.loading = null;
          this.onStatus('Ready - sparse anime foreground assistance');
        } else if (data.type === 'mask' && this.pending?.id === data.id) {
          clearTimeout(this.timer);
          const job = this.pending;
          this.pending = null;
          if (job.epoch !== this.epoch) { job.resolve(null); return; }
          this.cached = { ...job, mask: data.mask };
          this.interval = Math.max(0.5, Math.min(2, data.ms / 250));
          this.onStatus(`Active - ${Math.round(data.ms)} ms per sparse mask`);
          job.resolve(data.mask);
        } else if (data.type === 'error') {
          this.fail();
        }
      };
      this.worker.postMessage({ type: 'load' });
    } catch {
      this.fail();
    }
  }

  fail() {
    this.finishLoading?.(false);
    this.finishLoading = null;
    this.loading = null;
    clearTimeout(this.timer);
    this.ready = false;
    this.failed = true;
    this.pending?.resolve(null);
    this.pending = null;
    this.cached = null;
    this.worker?.terminate();
    this.worker = null;
    this.onStatus('Mask assistance unavailable - base depth continues');
  }

  async forFrame(rgba, width, height, mediaTime, video = null) {
    if (!this.enabled || !this.ready || !rgba || this.pending) return null;
    const prior = this.cached;
    if (prior && prior.width === width && prior.height === height
      && mediaTime >= prior.mediaTime && mediaTime - prior.mediaTime < this.interval) {
      const mask = new Uint8Array(width * height);
      // No blind mask carry: moving/relit neighborhoods lose assistance until
      // their next inference. This also rejects a new scene's stale silhouette.
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
        const i = y * width + x;
        let stable = true;
        for (const offset of [0, -1, 1, -width, width]) {
          if ((offset === -1 && x === 0) || (offset === 1 && x === width - 1)
            || i + offset < 0 || i + offset >= width * height) continue;
          const k = (i + offset) * 4;
          for (let c = 0; c < 3; c++) {
            if (Math.abs(rgba[k + c] - prior.rgba[k + c]) > 10) stable = false;
          }
        }
        if (stable) mask[i] = prior.mask[i];
      }
      let lost = 0;
      let foreground = 0;
      for (let i = 0; i < mask.length; i += Math.max(1, Math.floor(mask.length / 8192))) {
        if (prior.mask[i] < 96) continue;
        foreground++;
        if (mask[i] < 96) lost++;
      }
      if (!foreground || lost / foreground < 0.03) return mask;
      // Significant local motion needs a fresh mask, not alternating corrected
      // and uncorrected geometry. This optional quality path pays that cost.
    }
    return new Promise(resolve => {
      const id = ++this.id;
      this.pending = { id, resolve, epoch: this.epoch, rgba: new Uint8ClampedArray(rgba), width, height, mediaTime };
      this.timer = setTimeout(() => this.fail(), 5000);
      const worker = this.worker;
      if (video && typeof createImageBitmap === 'function') {
        // Preserve source detail for a 1024-class specialist. Upscaling the
        // low-resolution voxel color grid erased the very hair edges it needs.
        createImageBitmap(video).then(bitmap => {
          if (this.worker !== worker || this.pending?.id !== id) { bitmap.close(); return; }
          worker.postMessage({ type: 'mask', id, bitmap, width, height }, [bitmap]);
        }).catch(() => this.fail());
      } else {
        const copy = new Uint8ClampedArray(rgba);
        worker.postMessage({ type: 'mask', id, rgba: copy.buffer, width, height }, [copy.buffer]);
      }
    });
  }
}
