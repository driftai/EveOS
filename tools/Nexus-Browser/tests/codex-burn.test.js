'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { summarize } = require('../local-targets/codex-burn');
const record = (model, effort, five, weekly) => ({ schema: 'eveos.codex-burn-observation.v1',
  model, effort, valid: true, windows: { fiveHour: five, weekly } });
test('groups by exact model and reasoning, never applies fabricated ultra multipliers', () => {
  const o = summarize([record('gpt-5.6-sol', 'medium', 2, 1), record('gpt-5.6-sol', 'medium', 4, 3),
    record('gpt-5.6-sol', 'medium', 1, 2), record('gpt-5.6-luna', 'low', 1, 1),
    { ...record('gpt-5.6-sol', 'ultra', 50, 50), valid: false }]);
  assert.equal(o.models.length, 2);
  assert.deepEqual(o.models[0].medianFiveHourPoints, 2);
  assert.equal(o.models[0].confidence, 'OBSERVATIONAL');
  assert.equal(o.models[1].confidence, 'INSUFFICIENT');
});
test('rejects malformed / impossible deltas', () => {
  const o = summarize([record('gpt-5.6-sol', 'medium', -3, 9), record('gpt-5.6-sol', 'low', '3', 2),
    record('unknown', 'low', 1, 1), { ...record('gpt-5.6-sol', 'medium', 2, 2), valid: false }]);
  assert.equal(o.models.length, 0);
});
