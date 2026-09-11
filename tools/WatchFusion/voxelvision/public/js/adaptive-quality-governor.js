/**
 * One policy owner for requested versus active live-depth quality.
 *
 * Manual never changes a user choice. Detail priority protects the selected
 * grid and adapts FPS. Motion priority protects temporal responsiveness by
 * stepping model/grid detail first, then lowering FPS only at minimum detail.
 */

import { AdaptiveFpsGovernor, highestFpsStep, nextFpsStep } from './adaptive-fps-governor.js';

export const QUALITY_TUNING_MODES = Object.freeze({
  MANUAL: 'manual',
  DETAIL: 'detail-priority',
  MOTION: 'motion-priority'
});

const DEFAULT_DETAIL_STEPS = Object.freeze([48, 64, 96, 128, 192, 256, 384, 512]);
const DEFAULT_FPS_STEPS = Object.freeze([1, 2, 3, 4, 6, 8, 10, 12]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function highestStep(steps, value, fallback = steps[0]) {
  let selected = fallback;
  for (const step of steps) if (step <= value) selected = step;
  return selected;
}

function lowerStep(steps, value) {
  let selected = steps[0];
  for (const step of steps) {
    if (step >= value) break;
    selected = step;
  }
  return selected;
}

function nextStep(steps, value, ceiling) {
  for (const step of steps) if (step > value && step <= ceiling) return step;
  return highestStep(steps, ceiling, value);
}

function percentile(values, quantile) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))];
}

export class AdaptiveQualityGovernor {
  constructor({
    mode = QUALITY_TUNING_MODES.MANUAL,
    detailSteps = DEFAULT_DETAIL_STEPS,
    fpsSteps = DEFAULT_FPS_STEPS,
    maxDetail = 512,
    maxFps = 12,
    requestedDetail = 128,
    requestedFps = 3,
    minMotionFps = 4,
    minSamples = 4,
    sampleWindow = 16,
    downshiftConfirmSamples = 2,
    upshiftConfirmSamples = 10,
    changeCooldownMs = 3200,
    clock = () => performance.now()
  } = {}) {
    this.detailSteps = [...detailSteps].filter(Number.isFinite).sort((a, b) => a - b);
    this.fpsSteps = [...fpsSteps].filter(Number.isFinite).sort((a, b) => a - b);
    this.maxDetail = highestStep(this.detailSteps, maxDetail);
    this.maxFps = highestFpsStep(this.fpsSteps, maxFps);
    this.requestedDetail = highestStep(this.detailSteps, clamp(requestedDetail, this.detailSteps[0], this.maxDetail));
    this.requestedFps = highestFpsStep(this.fpsSteps, clamp(requestedFps, this.fpsSteps[0], this.maxFps));
    this.activeDetail = this.requestedDetail;
    this.activeFps = this.requestedFps;
    this.mode = Object.values(QUALITY_TUNING_MODES).includes(mode) ? mode : QUALITY_TUNING_MODES.MANUAL;
    this.minMotionFps = Math.max(1, minMotionFps);
    this.minSamples = Math.max(1, minSamples);
    this.sampleWindow = Math.max(this.minSamples, sampleWindow);
    this.downshiftConfirmSamples = Math.max(1, downshiftConfirmSamples);
    this.upshiftConfirmSamples = Math.max(1, upshiftConfirmSamples);
    this.changeCooldownMs = Math.max(0, changeCooldownMs);
    this.clock = clock;
    this.fpsGovernor = new AdaptiveFpsGovernor({
      steps: this.fpsSteps,
      maxFps: this.maxFps,
      requestedFps: this.requestedFps,
      initialFps: this.requestedFps,
      upshiftCooldownMs: this.changeCooldownMs,
      clock
    });
    this.reset({ restoreRequested: true });
  }

  reset({ restoreRequested = true, now = this.clock() } = {}) {
    this.samples = [];
    this.emaMs = null;
    this.downshiftEvidence = 0;
    this.upshiftEvidence = 0;
    this.lastChangeAt = now;
    this.fpsGovernor.setRequested(this.requestedFps, { allowImmediateUpshift: restoreRequested });
    this.fpsGovernor.reset({ preserveActive: !restoreRequested, now });
    if (restoreRequested) {
      this.activeDetail = this.requestedDetail;
      this.activeFps = this.requestedFps;
    }
    return this.snapshot();
  }

  setMode(mode, { restoreRequested = true } = {}) {
    this.mode = Object.values(QUALITY_TUNING_MODES).includes(mode) ? mode : QUALITY_TUNING_MODES.MANUAL;
    return this.reset({ restoreRequested });
  }

  /** Restore both the user's target and the exact active cache profile. */
  restoreProfile({ mode, requestedDetail, requestedFps, activeDetail, activeFps } = {}, now = this.clock()) {
    this.mode = Object.values(QUALITY_TUNING_MODES).includes(mode) ? mode : QUALITY_TUNING_MODES.MANUAL;
    const restoredDetail = highestStep(
      this.detailSteps,
      clamp(Number(activeDetail) || this.detailSteps[0], this.detailSteps[0], this.maxDetail)
    );
    const restoredFps = highestFpsStep(
      this.fpsSteps,
      clamp(Number(activeFps) || this.fpsSteps[0], this.fpsSteps[0], this.maxFps),
      this.fpsSteps[0]
    );
    this.requestedDetail = highestStep(
      this.detailSteps,
      clamp(Math.max(Number(requestedDetail) || restoredDetail, restoredDetail), this.detailSteps[0], this.maxDetail)
    );
    this.requestedFps = highestFpsStep(
      this.fpsSteps,
      clamp(Math.max(Number(requestedFps) || restoredFps, restoredFps), this.fpsSteps[0], this.maxFps),
      this.fpsSteps[0]
    );
    this.reset({ restoreRequested: true, now });
    this.activeDetail = Math.min(restoredDetail, this.requestedDetail);
    this.activeFps = Math.min(restoredFps, this.requestedFps);
    this.fpsGovernor.activeFps = this.activeFps;
    this.fpsGovernor.runtimeCeiling = this.activeFps;
    return this.snapshot({ restored: true });
  }

  setRequestedDetail(value) {
    this.requestedDetail = highestStep(
      this.detailSteps,
      clamp(Number(value) || this.detailSteps[0], this.detailSteps[0], this.maxDetail)
    );
    this.activeDetail = this.requestedDetail;
    return this.reset({ restoreRequested: false });
  }

  setRequestedFps(value) {
    this.requestedFps = highestFpsStep(
      this.fpsSteps,
      clamp(Number(value) || this.fpsSteps[0], this.fpsSteps[0], this.maxFps),
      this.fpsSteps[0]
    );
    this.activeFps = this.requestedFps;
    this.fpsGovernor.setRequested(this.requestedFps, { allowImmediateUpshift: true });
    return this.reset({ restoreRequested: false });
  }

  /** Apply one recent measured cost immediately when a user selects Auto. */
  prime(durationMs, measuredDetail = this.activeDetail, now = this.clock()) {
    if (this.mode === QUALITY_TUNING_MODES.MANUAL
      || !Number.isFinite(durationMs) || durationMs <= 0 || durationMs >= 60000) return this.snapshot();
    const sourceDetail = Math.max(this.detailSteps[0], Number(measuredDetail) || this.requestedDetail);
    const predictedAt = detail => durationMs * Math.pow(detail / sourceDetail, 2);
    this.activeDetail = this.requestedDetail;
    let predicted = predictedAt(this.requestedDetail);

    if (this.mode === QUALITY_TUNING_MODES.MOTION) {
      const budget = 1000 / Math.max(1, this.requestedFps);
      this.activeDetail = this.detailSteps[0];
      for (const detail of [...this.detailSteps].reverse()) {
        if (detail <= this.requestedDetail && predictedAt(detail) * 1.2 <= budget) {
          this.activeDetail = detail;
          break;
        }
      }
      predicted = predictedAt(this.activeDetail);
    }

    this.activeFps = Math.min(this.requestedFps, highestFpsStep(
      this.fpsSteps,
      Math.floor(1000 / (predicted * 1.22)),
      this.fpsSteps[0]
    ));
    if (this.mode === QUALITY_TUNING_MODES.MOTION && this.activeDetail > this.detailSteps[0]) {
      this.activeFps = this.requestedFps;
    }
    this.fpsGovernor.activeFps = this.activeFps;
    this.fpsGovernor.runtimeCeiling = this.activeFps;
    this.#clearEvidenceAfterDetailChange(now);
    return this.snapshot({
      changed: this.activeDetail !== this.requestedDetail || this.activeFps !== this.requestedFps,
      direction: 'down',
      dimension: this.activeDetail !== this.requestedDetail ? 'detail' : 'fps',
      primed: true
    });
  }

  #recordSample(durationMs) {
    this.emaMs = this.emaMs == null ? durationMs : this.emaMs + (durationMs - this.emaMs) * 0.28;
    this.samples.push(durationMs);
    if (this.samples.length > this.sampleWindow) this.samples.shift();
  }

  #clearEvidenceAfterDetailChange(now) {
    this.samples = [];
    this.emaMs = null;
    this.downshiftEvidence = 0;
    this.upshiftEvidence = 0;
    this.lastChangeAt = now;
  }

  record(durationMs, now = this.clock()) {
    if (!Number.isFinite(durationMs) || durationMs <= 0 || durationMs >= 60000) return this.snapshot();
    if (this.mode === QUALITY_TUNING_MODES.MANUAL) return this.snapshot();

    if (this.mode === QUALITY_TUNING_MODES.DETAIL) {
      this.activeDetail = this.requestedDetail;
      const fps = this.fpsGovernor.record(durationMs, now);
      this.activeFps = fps.activeFps;
      return this.snapshot({ changed: fps.changed, direction: fps.direction, dimension: fps.changed ? 'fps' : null });
    }

    this.#recordSample(durationMs);
    let changed = false;
    let direction = null;
    let dimension = null;
    if (this.samples.length >= this.minSamples) {
      const cost = Math.max(this.emaMs, percentile(this.samples, 0.9));
      const targetBudget = 1000 / Math.max(1, this.requestedFps);
      const overloaded = cost * 1.2 > targetBudget;

      if (overloaded) {
        this.downshiftEvidence += 1;
        this.upshiftEvidence = 0;
        if (this.downshiftEvidence >= this.downshiftConfirmSamples) {
          const minimumDetail = this.detailSteps[0];
          if (this.activeDetail > minimumDetail) {
            this.activeDetail = lowerStep(this.detailSteps, this.activeDetail);
            changed = true;
            direction = 'down';
            dimension = 'detail';
            this.#clearEvidenceAfterDetailChange(now);
          } else {
            const sustainable = highestFpsStep(
              this.fpsSteps,
              Math.floor(1000 / (cost * 1.22)),
              this.fpsSteps[0]
            );
            const next = Math.min(this.requestedFps, sustainable);
            if (next < this.activeFps) {
              this.activeFps = next;
              changed = true;
              direction = 'down';
              dimension = 'fps';
              this.lastChangeAt = now;
            }
            this.downshiftEvidence = 0;
          }
        }
      } else {
        const recoveryCost = Math.max(this.emaMs, percentile(this.samples, 0.75));
        let recoveryAvailable = false;
        let recoveryDimension = null;
        if (this.activeFps < this.requestedFps) {
          const next = nextFpsStep(this.fpsSteps, this.activeFps, this.requestedFps);
          recoveryAvailable = recoveryCost * 1.38 < 1000 / next;
          recoveryDimension = 'fps';
        } else if (this.activeDetail < this.requestedDetail) {
          const next = nextStep(this.detailSteps, this.activeDetail, this.requestedDetail);
          const predictedCost = recoveryCost * Math.pow(next / Math.max(1, this.activeDetail), 2);
          recoveryAvailable = predictedCost * 1.32 < targetBudget;
          recoveryDimension = 'detail';
        }

        if (recoveryAvailable) {
          this.upshiftEvidence += 1;
          this.downshiftEvidence = 0;
          if (this.upshiftEvidence >= this.upshiftConfirmSamples && now - this.lastChangeAt >= this.changeCooldownMs) {
            if (recoveryDimension === 'fps') {
              this.activeFps = nextFpsStep(this.fpsSteps, this.activeFps, this.requestedFps);
            } else {
              this.activeDetail = nextStep(this.detailSteps, this.activeDetail, this.requestedDetail);
            }
            changed = true;
            direction = 'up';
            dimension = recoveryDimension;
            this.#clearEvidenceAfterDetailChange(now);
          }
        } else {
          this.downshiftEvidence = 0;
          this.upshiftEvidence = 0;
        }
      }
    }

    return this.snapshot({ changed, direction, dimension });
  }

  snapshot(extra = {}) {
    return {
      mode: this.mode,
      requestedDetail: this.requestedDetail,
      activeDetail: this.activeDetail,
      requestedFps: this.requestedFps,
      activeFps: this.activeFps,
      minimumMotionFps: Math.min(this.requestedFps, this.minMotionFps),
      sampleCount: this.samples?.length || 0,
      emaMs: this.emaMs,
      p90Ms: this.samples?.length ? percentile(this.samples, 0.9) : null,
      ...extra
    };
  }
}
