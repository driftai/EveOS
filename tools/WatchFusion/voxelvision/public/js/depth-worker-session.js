/** A small request/response facade around the isolated depth-model worker. */

export class DepthWorkerSession {
  static async create(options) {
    const session = new DepthWorkerSession(options);
    try {
      await session.ready;
      return session;
    } catch (error) {
      await session.dispose();
      throw error;
    }
  }

  constructor({ modelId, backend, dtype, rank5, sessionOptions = null, onProgress = null }) {
    this.worker = new Worker(new URL('./depth-model-worker.js', import.meta.url), { type: 'module' });
    this.pending = new Map();
    this.nextRequestId = 1;
    this.onProgress = typeof onProgress === 'function' ? onProgress : () => {};
    this.disposed = false;
    this.ready = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;
    });

    this.worker.onmessage = event => this.#handleMessage(event.data);
    this.worker.onerror = event => {
      const error = new Error(event.message || 'Depth worker failed to initialize.');
      this.readyReject?.(error);
      this.#rejectAll(error);
    };
    this.worker.postMessage({ type: 'init', modelId, backend, dtype, rank5, sessionOptions });
  }

  #handleMessage(message) {
    if (!message || typeof message !== 'object') return;
    if (message.type === 'progress') {
      this.onProgress(message.progress);
      return;
    }
    if (message.type === 'ready') {
      this.readyResolve?.(this);
      this.readyResolve = null;
      this.readyReject = null;
      return;
    }
    if (message.type === 'init-error') {
      const error = new Error(message.message || 'Depth worker model initialization failed.');
      this.readyReject?.(error);
      this.readyResolve = null;
      this.readyReject = null;
      this.#rejectAll(error);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) return;
    this.pending.delete(message.id);
    if (message.type === 'result') {
      const data = new Float32Array(message.buffer);
      pending.resolve({ predicted_depth: { dims: message.dims, data } });
    } else {
      pending.reject(new Error(message.message || 'Depth worker inference failed.'));
    }
  }

  #rejectAll(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  async run(rgba, width, height) {
    if (this.disposed) throw new Error('Depth worker session was disposed.');
    await this.ready;
    const id = this.nextRequestId++;
    const bytes = rgba instanceof Uint8ClampedArray
      ? rgba
      : new Uint8ClampedArray(rgba.buffer, rgba.byteOffset, rgba.byteLength);
    // getImageData() gives this call sole ownership of a complete buffer, so it
    // can move to the worker without duplicating a multi-megabyte frame. Copy
    // only unusual subarray views whose surrounding buffer is not ours.
    const transferable = bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
      ? bytes
      : bytes.slice();
    const result = new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
    this.worker.postMessage(
      { type: 'infer', id, width, height, buffer: transferable.buffer },
      [transferable.buffer]
    );
    return result;
  }

  async dispose() {
    if (this.disposed) return;
    this.disposed = true;
    const error = new Error('Depth worker session was disposed.');
    this.readyReject?.(error);
    this.#rejectAll(error);
    try { this.worker.postMessage({ type: 'dispose' }); } catch {}
    this.worker.terminate();
  }
}
