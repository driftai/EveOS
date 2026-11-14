class WatchFusionMicrophone extends AudioWorkletProcessor {
  constructor() {
    super();
    this.port.onmessage = ({data}) => {
      if (data === 'record' && !this.buffer) {
        this.buffer = new Float32Array(5000);
        this.bin = this.count = this.power = this.index = 0;
        this.firstFrame = null;
      }
    };
  }

  process(inputs) {
    const audio = inputs[0]?.[0];
    if (!this.buffer || !audio) return true;
    this.firstFrame ??= currentFrame;
    for (const value of audio) {
      this.power += value * value;
      this.count++;
      this.bin += 1000;
      if (this.bin >= sampleRate) {
        this.bin -= sampleRate;
        this.buffer[this.index] = Math.log1p(30 * Math.sqrt(this.power / this.count));
        this.count = this.power = 0;
        if (++this.index === this.buffer.length) {
          const buffer = this.buffer;
          this.port.postMessage({ time: this.firstFrame / sampleRate, envelope: buffer }, [buffer.buffer]);
          this.buffer = null;
          break;
        }
      }
    }
    return true;
  }
}
registerProcessor('watchfusion-microphone', WatchFusionMicrophone);
