'use strict';
// Downmix the captured stream to mono and hand blocks to the page. Audio never leaves memory.
class SpikeTap extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    if (input && input.length) {
      const n = input[0].length, mono = new Float32Array(n);
      for (const ch of input) for (let i = 0; i < n; i += 1) mono[i] += ch[i] / input.length;
      this.port.postMessage(mono, [mono.buffer]);
    }
    return true;
  }
}
registerProcessor('spike-tap', SpikeTap);
