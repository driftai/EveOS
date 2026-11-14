/* WatchFusion: one correction must demonstrate progress before another is trusted. */
(() => {
  function createSeekHealth() {
    let scope = '', pending = null, cooldownUntil = 0, failures = 0;
    let previous = null, advancingSince = -1, reason = 'new-source';
    let overshoots = 0, rejected = 0, corrections = 0;
    function reset(nextScope = '') {
      scope = nextScope; pending = previous = null; cooldownUntil = 0;
      advancingSince = -1; failures = overshoots = rejected = corrections = 0;
      reason = 'new-source';
    }
    function observe({scope:next, nowMs, current, drift, target, rate = 1, playing, buffering}) {
      if (next !== scope) reset(next);
      if (![nowMs, current, drift].every(Number.isFinite)) { reason = 'invalid-player-sample'; return; }
      if (pending && Number.isFinite(target) && Math.abs(target - pending.target - (nowMs - pending.at) * rate / 1000) > .25) pending = null;
      if (pending && nowMs - pending.at >= 9000) fail(nowMs, 'unconfirmed-seek-backoff', 18000);
      if (buffering || !playing) {
        previous = null; advancingSince = -1;
        if (pending) pending.playingAfter = false;
        if (nowMs >= cooldownUntil) reason = buffering ? 'buffering' : 'not-playing';
        return;
      }
      const elapsed = previous ? nowMs - previous.at : Infinity;
      const delta = previous ? current - previous.current : 0;
      const progressing = elapsed > 0 && elapsed <= 1500 && delta > 0.001 && delta < elapsed / 1000 * 1.8 + .08;
      if (progressing) {
        if (advancingSince < 0) advancingSince = previous.at;
        if (pending && nowMs - advancingSince >= 650) pending.playingAfter = true;
      } else { advancingSince = -1; if (pending) pending.playingAfter = false; }
      previous = {at:nowMs, current};
      if (!pending && failures && Math.abs(drift) < .09 && advancingSince >= 0 && nowMs - advancingSince >= 2500) failures = 0;
      if (pending && nowMs - pending.at >= 2100 && pending.playingAfter) {
        const before = Math.abs(pending.before), after = Math.abs(drift);
        const opposite = Math.sign(drift) !== Math.sign(pending.before) && after >= .20;
        const improved = after <= Math.max(.14, before * .60);
        if (improved && !opposite) {
          failures = 0; cooldownUntil = Math.max(cooldownUntil, nowMs + 6500);
          reason = 'correction-improved'; pending = null;
        } else if (opposite || nowMs - pending.at >= 4200) {
          overshoots += Number(opposite);
          fail(nowMs, opposite ? 'seek-overshoot-backoff' : 'ineffective-seek-backoff', 12000);
        }
      }
    }
    function fail(nowMs, outcome, minimum) {
      failures = Math.min(3, failures + 1);
      cooldownUntil = Math.max(cooldownUntil, nowMs + Math.min(45000, minimum * 2 ** (failures - 1)));
      reason = outcome;
      pending = null;
    }
    function canRetry(nowMs) {
      return failures === 1 && !pending && nowMs >= cooldownUntil && advancingSince >= 0 && nowMs - advancingSince >= 2500;
    }
    function permit({scope:next, nowMs, current, target, action}) {
      if (next !== scope) reset(next);
      if (![nowMs, current, target].every(Number.isFinite) || Math.abs(target - current) > 1800) {
        rejected++; reason = 'implausible-player-position'; return false;
      }
      if (pending || nowMs < cooldownUntil || failures >= 2) { rejected++; return false; }
      if (action !== 'hard-seek' && (advancingSince < 0 || nowMs - advancingSince < 650)) {
        rejected++; reason = 'awaiting-steady-progress'; return false;
      }
      return true;
    }
    function record({scope:next, nowMs, current, target, action}) {
      if (next !== scope) reset(next);
      if (action === 'manual-sync') { pending = null; cooldownUntil = 0; failures = 0; reason = 'explicit-sync'; return; }
      pending = {at:nowMs, before:target-current, target, playingAfter:false};
      cooldownUntil = Math.max(cooldownUntil, nowMs + 6500);
      corrections++; reason = 'seek-awaiting-proof';
    }
    function snapshot(nowMs = (typeof performance === 'object' ? performance.now() : 0)) {
      return {reason, pending:!!pending, attempts:corrections, failures, overshoots,
        rejected, cooldownRemainingMs:Math.max(0, Math.round(cooldownUntil - nowMs))};
    }
    return {reset, observe, permit, record, snapshot, canRetry};
  }
  globalThis.WatchFusionSeekHealth = {createSeekHealth};
  globalThis.watchFusionSeekHealth = createSeekHealth();
})();
