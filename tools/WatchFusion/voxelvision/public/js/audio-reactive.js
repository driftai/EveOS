/**
 * VoxelVision Audio-Reactive & Palette Engine
 * Extracts live FFT audio data and computes dynamic scene color harmonies.
 */

export class AudioReactiveEngine {
  constructor() {
    this.audioCtx = null;
    this.sourceNode = null;
    this.analyser = null;
    this.freqData = null;
    this.timeData = null;
    this.isAttached = false;

    this.bass = 0;
    this.mid = 0;
    this.high = 0;
    this.level = 0;
    this.pulse = 0;
    this.lastEnergy = 0;
    this.beatDetected = false;
  }

  attach(videoElement) {
    if (this.isAttached) return;

    try {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      this.audioCtx = new AudioContextClass();
      this.analyser = this.audioCtx.createAnalyser();
      this.analyser.fftSize = 256;
      this.analyser.smoothingTimeConstant = 0.82;

      this.sourceNode = this.audioCtx.createMediaElementSource(videoElement);
      this.sourceNode.connect(this.analyser);
      this.analyser.connect(this.audioCtx.destination);

      const bufferLength = this.analyser.frequencyBinCount;
      this.freqData = new Uint8Array(bufferLength);
      this.timeData = new Uint8Array(bufferLength);

      this.isAttached = true;
    } catch (err) {
      console.warn('AudioContext initialization deferred until user interaction:', err);
    }
  }

  resume() {
    if (this.audioCtx && this.audioCtx.state === 'suspended') {
      this.audioCtx.resume();
    }
  }

  update(deltaTime = 0.016) {
    if (!this.isAttached || !this.analyser) {
      return {
        available: false,
        bass: 0,
        mid: 0,
        high: 0,
        level: 0,
        pulse: 0,
        beat: false
      };
    }

    this.analyser.getByteFrequencyData(this.freqData);

    const len = this.freqData.length;
    let sumBass = 0, countBass = 0;
    let sumMid = 0, countMid = 0;
    let sumHigh = 0, countHigh = 0;
    let totalSum = 0;

    // Split into 3 bands:
    // Bins 0-6 (~0-500Hz) = Bass
    // Bins 7-24 (~500-2000Hz) = Mid
    // Bins 25-64 (~2000-5500Hz) = High
    for (let i = 0; i < len; i++) {
      const val = this.freqData[i] / 255;
      totalSum += val;

      if (i <= 6) {
        sumBass += val;
        countBass++;
      } else if (i <= 24) {
        sumMid += val;
        countMid++;
      } else if (i <= 64) {
        sumHigh += val;
        countHigh++;
      }
    }

    const currentBass = countBass ? sumBass / countBass : 0;
    const currentMid = countMid ? sumMid / countMid : 0;
    const currentHigh = countHigh ? sumHigh / countHigh : 0;
    const currentLevel = len ? totalSum / len : 0;

    // Exponential smoothing
    this.bass += (currentBass - this.bass) * 0.25;
    this.mid += (currentMid - this.mid) * 0.25;
    this.high += (currentHigh - this.high) * 0.25;
    this.level += (currentLevel - this.level) * 0.25;

    // Beat detection via energy delta
    const energy = this.bass * 1.5 + this.mid * 0.5;
    const delta = energy - this.lastEnergy;
    this.beatDetected = delta > 0.18;
    this.lastEnergy = energy;

    // Decay pulse
    if (this.beatDetected) {
      this.pulse = 1.0;
    } else {
      this.pulse = Math.max(0, this.pulse - deltaTime * 3.5);
    }

    return {
      available: true,
      bass: this.bass,
      mid: this.mid,
      high: this.high,
      level: this.level,
      pulse: this.pulse,
      beat: this.beatDetected,
      freqData: this.freqData
    };
  }
}
