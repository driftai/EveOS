/* Compare the same content through independently recorded output paths. */
(() => {
  const LIMIT_MS = 1500;
  const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
  const round = value => Math.round(value);

  function score(reference, receiver, start, size, lag) {
    const end = start + size;
    if (start + lag < 0 || end + lag > receiver.length) return -1;
    let x = 0, y = 0, xx = 0, yy = 0, xy = 0;
    for (let i = start; i < end; i++) {
      const a = reference[i], b = receiver[i + lag];
      x += a; y += b; xx += a * a; yy += b * b; xy += a * b;
    }
    const variance = (xx - x * x / size) * (yy - y * y / size);
    return variance > 1e-16 ? (xy - x * y / size) / Math.sqrt(variance) : -1;
  }

  function findPeak(reference, receiver, start, center, radius) {
    const size = 480, scores = [];
    const low = Math.max(-start, center - radius);
    const high = Math.min(receiver.length - start - size, center + radius);
    for (let lag = low; lag <= high; lag++) scores.push({lag, value: score(reference, receiver, start, size, lag)});
    scores.sort((a, b) => b.value - a.value);
    const best = scores[0];
    if (!best) return null;
    const runnerUp = scores.find(item => Math.abs(item.lag - best.lag) > 24);
    return best.value >= .55 && best.value - (runnerUp?.value ?? -1) >= .055 ? best : null;
  }

  function estimate(reference, receiver, predictedLagMs = 0) {
    if (reference.length < 3800 || receiver.length < 3800 || reference.length > 6000 || receiver.length > 6000 ||
        !Number.isFinite(predictedLagMs) || Math.abs(predictedLagMs) > 1800) return null;
    const center = round(predictedLagMs), hits = [];
    for (const start of [350, 800, 1250, 1700, 2150, 2600, 3050]) {
      const peak = findPeak(reference, receiver, start, center, LIMIT_MS);
      if (peak) hits.push(peak.lag);
    }
    if (hits.length < 3) return null;
    const lag = median(hits);
    const agreement = hits.filter(value => Math.abs(value - lag) <= 20);
    if (agreement.length < 3 || agreement.length < hits.length * .75) return null;
    const early = hits[0], late = hits.at(-1);
    if (Math.abs(early - late) > 25) return null;
    return { lagMs: lag, uncertaintyMs: Math.max(5, ...agreement.map(value => Math.abs(value - lag))), matches: agreement.length };
  }

  function measure(reference, receiver, detection) {
    if (!detection || reference.rate !== receiver.rate || reference.rate <= 0) return null;
    const playerDelta = (receiver.positionMs - reference.positionMs) / reference.rate;
    const acousticDelta = playerDelta + detection.lagMs;
    const clockUncertainty = (reference.rttMs + receiver.rttMs) / 2;
    const uncertainty = Math.ceil(detection.uncertaintyMs + clockUncertainty + Math.max(reference.jitterMs, receiver.jitterMs) + 3);
    // A fixed speaker delay and room/player phase are separate measurements.
    const referencePhase = (reference.positionMs - reference.roomPositionMs) / reference.rate;
    const receiverPhase = (receiver.positionMs - receiver.roomPositionMs) / receiver.rate;
    const residualMs = acousticDelta + referencePhase - receiverPhase;
    const adjustmentMs = -referencePhase - acousticDelta;
    if (![uncertainty, acousticDelta, residualMs, adjustmentMs].every(Number.isFinite) || uncertainty > 30 ||
        Math.abs(acousticDelta) > LIMIT_MS || Math.abs(adjustmentMs) > LIMIT_MS) return null;
    return {
      observedMs: round(acousticDelta), residualMs: round(residualMs), adjustmentMs: round(adjustmentMs),
      uncertaintyMs: uncertainty
    };
  }

  function commonTarget(paths) {
    if (paths.length < 2 || paths.some(path => !path.delayable || !Number.isFinite(path.latencyMs) ||
      !Number.isFinite(path.uncertaintyMs) || path.uncertaintyMs > 30 || Math.abs(path.latencyMs) > LIMIT_MS)) return null;
    const reference = Math.max(...paths.map(path => path.latencyMs));
    const delays = paths.map(path => ({ id: path.id, delayMs: round(reference - path.latencyMs) }));
    return delays.every(path => path.delayMs <= LIMIT_MS) ? delays : null;
  }

  globalThis.WatchFusionAcoustics = { estimate, measure, commonTarget };
})();
