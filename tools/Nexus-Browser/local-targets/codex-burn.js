'use strict';
// Account-level usage observations; NOT provider-published model burn or billing.
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../../..');
const HISTORY = path.join(ROOT, 'data/runtime/smoke-results/agent-governor/history.jsonl');
const MAX_BYTES = 1_000_000;
const validModels = new Set(['gpt-5.6-luna', 'gpt-5.6-terra', 'gpt-5.6-sol']);
const validEfforts = new Set(['low', 'medium', 'high', 'ultra', 'xhigh', 'max']);

function summarize(records) {
  const groups = new Map();
  for (const r of records.slice(-250)) {
    if (r?.schema !== 'eveos.codex-burn-observation.v1' || r.valid !== true ||
        !validModels.has(r.model) || !validEfforts.has(r.effort)) continue;
    const five = r.windows?.fiveHour, week = r.windows?.weekly;
    if (![five, week].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 100)) continue;
    const key = r.model + '/' + r.effort;
    if (!groups.has(key)) groups.set(key, { model: r.model, effort: r.effort, five: [], week: [], hourly: [] });
    groups.get(key).five.push(five);
    groups.get(key).week.push(week);
    if (typeof r.elapsedSeconds === 'number' && r.elapsedSeconds >= 60 && r.elapsedSeconds < 7 * 86400)
      groups.get(key).hourly.push(five * 3600 / r.elapsedSeconds);
  }
  const median = nums => {
    const sorted = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  };
  return {
    schema: 'eveos.codex-burn-estimates.v1',
    kind: 'observed-account-deltas',
    caveat: 'Percentage-point changes observed during tasks; concurrent activity is not isolated. Not a model billing rate or per-token Plus conversion.',
    minimumSamplesForPlanning: 3,
    models: [...groups.values()].map(g => ({ model: g.model, effort: g.effort, samples: g.five.length,
      confidence: g.five.length >= 3 ? 'OBSERVATIONAL' : 'INSUFFICIENT',
      medianFiveHourPoints: Number(median(g.five).toFixed(2)),
      medianWeeklyPoints: Number(median(g.week).toFixed(2)),
      medianFiveHourPointsPerElapsedHour: g.hourly.length ? Number(median(g.hourly).toFixed(2)) : null })).sort((a, b) => b.samples - a.samples),
  };
}

function readBurnSummary(file = HISTORY) {
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES) return summarize([]);
    const rows = [];
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/).slice(-250)) {
      if (!line) continue;
      try { rows.push(JSON.parse(line)); } catch { /* ignore invalid or partial append */ }
    }
    return summarize(rows);
  } catch { return summarize([]); }
}

module.exports = { summarize, readBurnSummary };
