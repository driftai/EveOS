// The room owns the media timeline. Reports describe a player or a compositor, never a speaker.
const MAX_AGE = 4500;
const MAX_HOLDBACK = 350;
const MAX_PHASE = 1200;
const finite = (value, min, max) => Number.isFinite(value) && value >= min && value <= max;
const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

export function createPlayoutCoordinator() {
  let segment = 0, anchor = null, reference = null, holdbackMs = 0;
  const history = new Map(), latestReport = new Map();

  function transport(playback, discontinuity = false) {
    const rate = playback.paused || playback.ended ? 0 : playback.rate;
    const next = {rate, at:playback.updatedAt, positionMs:playback.position * 1000};
    const predicted = anchor && anchor.positionMs + (next.at - anchor.at) * anchor.rate;
    if (discontinuity || !anchor || anchor.rate !== rate || Math.abs(next.positionMs - predicted) > 500) {
      segment++;
      history.clear();
      latestReport.clear();
      reference = null;
      holdbackMs = 0;
    } else if (predicted !== next.positionMs) {
      const shift = next.positionMs - predicted;
      for (const entry of history.values()) for (const item of entry.readings) item.phase -= shift;
      if (reference) reference.phase -= shift;
    }
    anchor = next;
    return segment;
  }

  function position(at) {
    return Math.max(0, anchor.positionMs + (at - anchor.at) * anchor.rate);
  }

  function observe(id, report, receivedAt) {
    const fresh = finite(report.sampledAt, receivedAt - 1500, receivedAt + 50);
    const previousReport = latestReport.get(id);
    if (!fresh || (previousReport && report.sampledAt <= previousReport.sampledAt)) return;
    latestReport.set(id, {at:receivedAt, sampledAt:report.sampledAt, buffering:report.buffering === true, output:report.outputSession});
    let samples = history.get(id);
    const valid = anchor?.rate > 0 && Number.isFinite(receivedAt) && report.ready && report.playing && !report.buffering &&
      finite(report.positionMs, 0, 1e10) && finite(report.uncertaintyMs, 0, 150);
    const routeChanged = previousReport && previousReport.output !== report.outputSession;
    if (reference?.authority === id && routeChanged) reference = null;
    if (!valid || routeChanged) {
      history.delete(id);
      samples = null;
    }
    if (!valid) return;
    if (!samples) {
      samples = {readings:[]};
      history.set(id, samples);
    }
    const previous = samples.readings.at(-1);
    if (previous && report.sampledAt - previous.at > 2400) samples.readings = [];
    const phase = report.positionMs - position(report.sampledAt);
    samples.readings.push({at:report.sampledAt, phase, uncertaintyMs:report.uncertaintyMs,
      bufferedUntilMs:report.bufferedUntilMs});
    samples.readings = samples.readings.filter(item => report.sampledAt - item.at <= MAX_AGE).slice(-8);
  }

  function estimate(id, now) {
    const items = history.get(id)?.readings;
    if (!items || items.length < 4 || now - items.at(-1).at > 2000 || items.at(-1).at - items[0].at < 1000) return null;
    const phase = median(items.map(item => item.phase));
    const inliers = items.filter(item => Math.abs(item.phase - phase) <= Math.max(35, item.uncertaintyMs));
    if (inliers.length < 4 || inliers.length < items.length * .75 || Math.abs(phase) > MAX_PHASE) return null;
    const first = inliers[0], last = inliers.at(-1);
    const span = last.at - first.at;
    if (span < 1000 || now - last.at > 2200) return null;
    // A phase estimate is invalid while the anchor is moving faster/slower than the player.
    if (Math.abs(last.phase - first.phase) > Math.max(45, span * .035)) return null;
    const jitter = Math.max(...inliers.map(item => Math.abs(item.phase - phase)));
    return {phase, at:last.at, uncertaintyMs:Math.ceil(jitter + Math.max(...inliers.map(item => item.uncertaintyMs)))};
  }

  function coordinate({now, authority, viewers, allowHoldback}) {
    for (const [id, entry] of history) {
      if ((!viewers.has(id) && id !== authority) || now - entry.readings.at(-1).at > MAX_AGE) history.delete(id);
    }
    for (const [id, entry] of latestReport) if ((!viewers.has(id) && id !== authority) || now - entry.at > MAX_AGE) latestReport.delete(id);
    const authoritySample = latestReport.get(authority);
    const authorityBuffering = authoritySample?.buffering === true && now - authoritySample.at < 1700;
    if (reference && reference.authority !== authority) reference = null;
    const observed = estimate(authority, now);
    if (observed && observed.uncertaintyMs <= 125) {
      if (!reference || Math.abs(observed.phase - reference.phase) > Math.max(20, observed.uncertaintyMs)) reference = {...observed, authority};
      else reference = {...reference, at:observed.at, uncertaintyMs:observed.uncertaintyMs};
    } else if (reference && now - reference.at > MAX_AGE) reference = null;

    if (!allowHoldback) holdbackMs = 0;
    if (allowHoldback && observed && observed.uncertaintyMs <= 125 && reference && !authorityBuffering && viewers.size >= 2) {
      const limits = [...viewers].map(id => {
        const entry = estimate(id, now);
        const readings = history.get(id)?.readings.slice(-3);
        if (!entry || !readings.every(item => finite(item.bufferedUntilMs, 0, 1e10))) return null;
        // Estimate the shared playable frontier only from stable live buffer observations.
        return median(readings.map(item => item.bufferedUntilMs - position(item.at)));
      });
      if (limits.every(value => value !== null)) {
        const deficit = reference.phase + 180 * anchor.rate - Math.min(...limits);
        const next = Math.min(MAX_HOLDBACK, Math.max(0, Math.ceil(deficit / anchor.rate / 50) * 50));
        // A one-way allowance per transport segment avoids re-seeking when a member joins/leaves.
        if (next >= holdbackMs + 75) holdbackMs = next;
      }
    }
    return {
      segment, reference:reference ? (authority === 'linked' ? 'linked-tab' : 'host-player') : 'room-clock',
      phaseMs:Math.round(reference?.phase ?? 0), uncertaintyMs:reference?.uncertaintyMs ?? null,
      holdbackMs, authorityBuffering, outputTiming:'speaker-unmeasured'
    };
  }

  return {transport, observe, coordinate, segment:() => segment};
}
