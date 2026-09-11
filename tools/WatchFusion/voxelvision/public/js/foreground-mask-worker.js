// Optional anime silhouette evidence; never assigns geometry or touches playback.
let model;
let Tensor;
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'load') {
      const runtime = await import('https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.2.0');
      Tensor = runtime.Tensor;
      model = await runtime.AutoModel.from_pretrained('BritishWerewolf/IS-Net-Anime', {
        revision: '99b14ab0ce4311317febbfad1d2fc00da5ea6d90',
        device: 'webgpu', dtype: 'fp32'
      });
      self.postMessage({ type: 'ready' });
      return;
    }
    const { width, height, id } = data;
    const started = performance.now();
    let source = data.bitmap;
    if (!source) {
      source = new OffscreenCanvas(width, height);
      source.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(data.rgba), width, height), 0, 0);
    }
    const input = new OffscreenCanvas(1024, 1024);
    const ctx = input.getContext('2d', { willReadFrequently: true });
    const scale = 1024 / Math.max(width, height);
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const left = Math.floor((1024 - w) / 2), top = Math.floor((1024 - h) / 2);
    ctx.drawImage(source, left, top, w, h);
    data.bitmap?.close();
    const pixels = ctx.getImageData(0, 0, 1024, 1024).data;
    const values = new Float32Array(3 * 1024 * 1024);
    // Match this ONNX export's preprocessor_config (RGB means, unit std).
    const means = [0.485, 0.456, 0.406];
    for (let i = 0; i < 1024 * 1024; i++) {
      for (let c = 0; c < 3; c++) values[c * 1024 * 1024 + i] = pixels[i * 4 + c] / 255 - means[c];
    }
    const tensor = new Tensor('float32', values, [1, 3, 1024, 1024]);
    const outputs = await model({ img: tensor });
    const output = Object.values(outputs)[0];
    const mask = new Uint8Array(width * height);
    const raw = output.data;
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const index = (top + Math.min(h - 1, Math.floor(y * h / height))) * 1024 + left + Math.min(w - 1, Math.floor(x * w / width));
      const v = raw[index];
      mask[y * width + x] = Number.isFinite(v) ? Math.round(Math.min(1, Math.max(0, v)) * 255) : 0;
    }
    for (const value of Object.values(outputs)) value.dispose?.();
    tensor.dispose?.();
    self.postMessage({ type: 'mask', id, mask, ms: performance.now() - started }, [mask.buffer]);
  } catch (error) { self.postMessage({ type: 'error', message: String(error?.message || error) }); }
};
