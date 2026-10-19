'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { recoveryProjection } = require('../machine-spaces/engineering-recovery-result');

test('bounded shared-engine receipt is projected into the outer supervised job', () => {
  const result = recoveryProjection({ stdout: '\nTLO_AUTORECOVERY GREEN\nRECEIPT data/runtime/smoke-results/tlo-autorecovery/run-1/receipt.json\n' });
  assert.equal(result.outcome, 'GREEN');
  assert.equal(result.receipt, 'data/runtime/smoke-results/tlo-autorecovery/run-1/receipt.json');
});

test('untrusted or unrelated output never fabricates a recovery receipt', () => {
  assert.equal(recoveryProjection({ stdout: 'GREEN maybe' }), null);
  assert.equal(recoveryProjection({ stdout: 'RECEIPT ../../secret/receipt.json' }), null);
});
