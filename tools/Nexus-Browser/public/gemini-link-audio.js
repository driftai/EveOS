(() => {
  let context = null;
  let nextStartAt = 0;

  function audioContext() {
    if (context) return context;
    const AudioContextImpl = globalThis.AudioContext || globalThis.webkitAudioContext;
    if (!AudioContextImpl) return null;
    context = new AudioContextImpl();
    return context;
  }

  function decodeBase64(value) {
    const binary = atob(String(value || ''));
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  }

  function schedulePcm(message) {
    const ctx = audioContext();
    if (!ctx || !message?.audio) return;
    const sampleRate = Math.max(8000, Number(message.sampleRate || 24000));
    const channels = Math.max(1, Math.min(2, Number(message.channels || 1)));
    const bytes = decodeBase64(message.audio);
    const frameCount = Math.floor(bytes.byteLength / (2 * channels));
    if (!frameCount) return;

    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const buffer = ctx.createBuffer(channels, frameCount, sampleRate);
    for (let channel = 0; channel < channels; channel += 1) {
      const output = buffer.getChannelData(channel);
      for (let frame = 0; frame < frameCount; frame += 1) {
        const offset = (frame * channels + channel) * 2;
        output[frame] = view.getInt16(offset, true) / 32768;
      }
    }

    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    const startAt = Math.max(ctx.currentTime + 0.015, nextStartAt);
    source.start(startAt);
    nextStartAt = startAt + buffer.duration;
  }

  function unlock() {
    const ctx = audioContext();
    if (ctx?.state === 'suspended') ctx.resume().catch(() => {});
  }

  function handle(message) {
    if (message?.type !== 'response_audio' || message?.providerId !== 'gemini-link-chat') return false;
    if (message.encoding && message.encoding !== 'pcm_s16le') return true;
    unlock();
    try { schedulePcm(message); } catch (error) { console.warn('Gemini Link Nexus audio playback failed:', error); }
    return true;
  }

  globalThis.addEventListener?.('pointerdown', unlock, { passive: true });
  globalThis.addEventListener?.('keydown', unlock, { passive: true });
  globalThis.BrowserAiBridgeGeminiLinkAudio = { handle, unlock };
  if (typeof module !== 'undefined' && module.exports) module.exports = { handle };
})();
