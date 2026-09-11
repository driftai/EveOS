/** A small request/response facade around the isolated depth-model worker. */

const MODEL_STATUS_KEY = 'voxelvision.model-ready-v1';

function modelStatusKey(modelId) {
  if (modelId === 'en970/depth-anything-v3-small-onnx') return 'enhanced';
  if (modelId === 'onnx-community/depth-anything-v2-small-ONNX') return 'balanced';
  return String(modelId || 'unknown');
}

function rememberModelReady(modelId) {
  try {
    const parsed = JSON.parse(localStorage.getItem(MODEL_STATUS_KEY) || '{}');
    const current = parsed && typeof parsed === 'object' ? parsed : {};
    current[modelStatusKey(modelId)] = { modelId, readyAt: new Date().toISOString() };
    localStorage.setItem(MODEL_STATUS_KEY, JSON.stringify(current));
  } catch {}
}

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
    this.modelId = modelId;
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
      rememberModelReady(this.modelId);
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
