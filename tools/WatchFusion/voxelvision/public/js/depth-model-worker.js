import {
  modelTensorDimensions,
  rgbaToImageNetTensorData,
  validateDepthTensor
} from './depth-models.js';

const TRANSFORMERS_MODULE_URL = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0';

let runtime = null;
let model = null;
let modelProfile = null;
let queue = Promise.resolve();
let lastProgressPercent = -1;
let lastProgressAt = 0;

function post(message, transfer = []) {
  self.postMessage(message, transfer);
}

function postProgress(progress) {
  const now = Date.now();
  const percent = Number.isFinite(progress?.progress) ? Math.floor(progress.progress) : null;
  if (percent != null) {
    const meaningfulStep = percent >= 100 || percent >= lastProgressPercent + 2;
    if (!meaningfulStep && now - lastProgressAt < 750) return;
    lastProgressPercent = Math.max(lastProgressPercent, percent);
  } else if (now - lastProgressAt < 750) {
    return;
  }
  lastProgressAt = now;
  post({ type: 'progress', progress });
}

async function initialize(message) {
  try {
    lastProgressPercent = -1;
    lastProgressAt = 0;
    runtime = await import(TRANSFORMERS_MODULE_URL);
    if (runtime.env) {
      runtime.env.allowLocalModels = false;
      runtime.env.useBrowserCache = true;
      if (runtime.env.backends?.onnx?.wasm) runtime.env.backends.onnx.wasm.numThreads = 1;
    }
    modelProfile = {
      rank5: Boolean(message.rank5)
    };
    model = await runtime.AutoModelForDepthEstimation.from_pretrained(message.modelId, {
      device: message.backend,
      dtype: message.dtype,
      session_options: message.sessionOptions || {},
      progress_callback: postProgress
    });
    post({ type: 'ready' });
  } catch (error) {
    post({ type: 'init-error', message: error?.message || String(error) });
  }
}

async function infer(message) {
  if (!model || !runtime) throw new Error('Depth worker model is not ready.');
  const rgba = new Uint8ClampedArray(message.buffer);
  const data = rgbaToImageNetTensorData(rgba, message.width, message.height);
  const input = new runtime.Tensor(
    'float32',
    data,
    modelTensorDimensions(modelProfile, message.width, message.height)
  );
  const output = await model({ pixel_values: input });
  const tensor = output?.predicted_depth || output?.depth || output?.logits;
  validateDepthTensor(tensor, { roughnessLimit: Infinity });
  const copy = Float32Array.from(tensor.data);
  post({ type: 'result', id: message.id, dims: tensor.dims, buffer: copy.buffer }, [copy.buffer]);
}

self.onmessage = event => {
  const message = event.data;
  if (message?.type === 'init') {
    queue = initialize(message);
  } else if (message?.type === 'infer') {
    queue = queue.then(() => infer(message)).catch(error => {
      post({ type: 'error', id: message.id, message: error?.message || String(error) });
    });
  } else if (message?.type === 'dispose') {
    Promise.resolve(model?.dispose?.()).catch(() => {}).finally(() => self.close());
  }
};
