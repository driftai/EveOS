'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { engineeringNotice } = require('../public/dex-room-view');

test('successful supervised TLO recovery is a success notification, not a red error', () => {
  const raw = '[ENGINEERING INCIDENT v1] state=completed class=completed '
    + 'job=machine-job-abc123 request=sample space=machine-space-xyz '
    + 'target=terminal-powershell-sample epoch=session-sample exit=0 error=none '
    + 'recovery=GREEN receipt=data/runtime/smoke-results/receipt.json';
  const value = engineeringNotice(raw);
  assert.equal(value.tone, 'success');
  assert.match(value.title, /successfully/);
  assert.equal(value.raw, raw);
});

test('failed and uncertain outcomes never display as successful', () => {
  const failed = engineeringNotice('[ENGINEERING INCIDENT v1] state=failed exit=1 error=FAIL');
  const unknown = engineeringNotice('[ENGINEERING INCIDENT v1] state=outcome-unknown exit=unknown');
  assert.equal(failed.tone, 'danger');
  assert.equal(unknown.tone, 'warning');
  assert.match(unknown.explanation, /do not replay/i);
  assert.equal(engineeringNotice('ordinary Dex message'), null);
});
