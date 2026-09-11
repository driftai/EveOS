/**
 * Pure, deterministic adaptive FPS governor.
 *
 * Runtime integration is kept in hardware-autotune.js; this module owns the
 * policy so it can be tested without a DOM, GPU, or playing video.
 */

const DEFAULT_STEPS = Object.freeze([1, 2, 3, 4, 6, 8, 10, 12]);
const MAX_VALID_SAMPLE_MS = 60000;

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}
export function highestFpsStep(steps, value, fallback = 1) {
  let selected = fallback;
  for (const step of steps) {
    if (step <= value) selected = step;
  }
  return selected;
}

export function nextFpsStep(steps, value, ceiling) {
  for (const step of steps) {
    if (step > value && step <= ceiling) return step;
  }
  return highestFpsStep(steps, ceiling, value);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1));
  return sorted[index];
}

export class AdaptiveFpsGovernor {
  constructor({
    steps = DEFAULT_STEPS,
    maxFps = 12,
    requestedFps = maxFps,
    initialFps = requestedFps,
    minSamples = 4,
    sampleWindow = 16,
    emaAlpha = 0.28,
    downshiftHeadroom = 1.22,
    recoveryHeadroom = 1.38,
    downshiftConfirmSamples = 2,
    upshiftConfirmSamples = 10,
    upshiftCooldownMs = 4000,
    clock = () => performance.now()
  } = {}) {
    this.steps = [...steps].filter(value => Number.isFinite(value) && value > 0).sort((a, b) => a - b);
    if (!this.steps.length) this.steps = [...DEFAULT_STEPS];
    this.maxFps = highestFpsStep(this.steps, Math.max(1, maxFps), this.steps[0]);
    this.requestedFps = highestFpsStep(this.steps, clamp(requestedFps, 1, this.maxFps), this.steps[0]);
    this.activeFps = highestFpsStep(this.steps, clamp(initialFps, 1, this.requestedFps), this.steps[0]);
    this.runtimeCeiling = this.maxFps;
    this.minSamples = Math.max(1, Math.round(minSamples));
    this.sampleWindow = Math.max(this.minSamples, Math.round(sampleWindow));
    this.emaAlpha = clamp(emaAlpha, 0.01, 1);
    this.downshiftHeadroom = Math.max(1, downshiftHeadroom);
    this.recoveryHeadroom = Math.max(this.downshiftHeadroom, recoveryHeadroom);
    this.downshiftConfirmSamples = Math.max(1, Math.round(downshiftConfirmSamples));
    this.upshiftConfirmSamples = Math.max(1, Math.round(upshiftConfirmSamples));
    this.upshiftCooldownMs = Math.max(0, upshiftCooldownMs);
    this.clock = clock;
    this.reset({ preserveActive: true });
  }

  reset({ preserveActive = true, now = this.clock() } = {}) {
    this.runtimeCeiling = this.maxFps;
    this.samples = [];
    this.emaMs = null;
    this.downshiftEvidence = 0;
    this.upshiftEvidence = 0;
    this.lastChangeAt = now;
    if (!preserveActive) this.activeFps = Math.min(this.requestedFps, this.maxFps);
    else this.activeFps = Math.min(this.activeFps, this.requestedFps, this.maxFps);
    return this.snapshot();
  }

  setRequested(value, { allowImmediateUpshift = false } = {}) {
    this.requestedFps = highestFpsStep(
      this.steps,
      clamp(Number(value) || this.steps[0], this.steps[0], this.maxFps),
      this.steps[0]
    );
    const permitted = Math.min(this.requestedFps, this.runtimeCeiling);
    if (this.activeFps > permitted) this.activeFps = highestFpsStep(this.steps, permitted, this.steps[0]);
    else if (allowImmediateUpshift && this.activeFps < permitted) this.activeFps = permitted;
    return this.snapshot();
  }

  record(durationMs, now = this.clock()) {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs >= MAX_VALID_SAMPLE_MS) return this.snapshot();

    this.emaMs = this.emaMs == null
      ? durationMs
      : this.emaMs + (durationMs - this.emaMs) * this.emaAlpha;
    this.samples.push(durationMs);
    if (this.samples.length > this.sampleWindow) this.samples.shift();

    let changed = false;
    let direction = null;
    if (this.samples.length >= this.minSamples) {
      // p90 reacts to repeated stalls; the EMA prevents one isolated spike from
      // permanently hiding fast tiers. Recovery also requires p75 headroom, so
      // a genuinely easier scene can age out an old expensive scene.
      const p90Ms = percentile(this.samples, 0.9);
      const p75Ms = percentile(this.samples, 0.75);
      const overloadCost = Math.max(this.emaMs, p90Ms);
      const recoveryCost = Math.max(this.emaMs, p75Ms);
      const measuredCeiling = highestFpsStep(
        this.steps,
        Math.floor(1000 / (overloadCost * this.downshiftHeadroom)),
        this.steps[0]
      );
      const recoveryCeiling = highestFpsStep(
        this.steps,
        Math.floor(1000 / (recoveryCost * this.recoveryHeadroom)),
        this.steps[0]
      );

      if (measuredCeiling < this.runtimeCeiling) {
        this.downshiftEvidence += 1;
        this.upshiftEvidence = 0;
        if (this.downshiftEvidence >= this.downshiftConfirmSamples) {
          this.runtimeCeiling = Math.min(this.maxFps, measuredCeiling);
          this.activeFps = Math.min(this.activeFps, this.requestedFps, this.runtimeCeiling);
          this.downshiftEvidence = 0;
          this.lastChangeAt = now;
          changed = true;
          direction = 'down';
        }
      } else if (recoveryCeiling > this.runtimeCeiling && this.runtimeCeiling < this.requestedFps) {
        this.upshiftEvidence += 1;
        this.downshiftEvidence = 0;
        if (
          this.upshiftEvidence >= this.upshiftConfirmSamples
          && now - this.lastChangeAt >= this.upshiftCooldownMs
        ) {
          const ceiling = Math.min(this.maxFps, this.requestedFps, recoveryCeiling);
          this.runtimeCeiling = nextFpsStep(this.steps, this.runtimeCeiling, ceiling);
          this.activeFps = nextFpsStep(this.steps, this.activeFps, Math.min(this.requestedFps, this.runtimeCeiling));
          this.upshiftEvidence = 0;
          this.lastChangeAt = now;
          changed = true;
          direction = 'up';
        }
      } else {
        this.downshiftEvidence = 0;
        this.upshiftEvidence = 0;
      }
    }

    return this.snapshot({ changed, direction });
  }

  snapshot(extra = {}) {
    return {
      requestedFps: this.requestedFps,
      activeFps: this.activeFps,
      runtimeCeiling: this.runtimeCeiling,
      sampleCount: this.samples?.length || 0,
      emaMs: this.emaMs,
      p90Ms: this.samples?.length ? percentile(this.samples, 0.9) : null,
      ...extra
    };
  }
}
