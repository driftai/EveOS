'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { enhanceIndex, INDEX_ENHANCEMENTS } = require('../server-http');

const root = path.join(__dirname, '..');

test('Nexus index response injects Machine Spaces companions exactly once in dependency order', () => {
  const html = '<html><body><script src="/machine-spaces-ui.js"></script></body></html>';
  const enhanced = enhanceIndex(html);
  assert.match(enhanced, /machine-human-gate-ui\.js/);
  assert.match(enhanced, /room-recovery-intent\.js/);
  assert.match(enhanced, /machine-supervised-jobs-ui\.js/);
  assert.match(enhanced, /machine-request-view-ui\.js/);
  assert.ok(enhanced.indexOf('machine-spaces-ui.js') < enhanced.indexOf('machine-human-gate-ui.js'));
  assert.ok(enhanced.indexOf('machine-human-gate-ui.js') < enhanced.indexOf('machine-supervised-jobs-ui.js'));
  assert.ok(enhanced.indexOf('room-recovery-intent.js') < enhanced.indexOf('machine-supervised-jobs-ui.js'));
  assert.ok(enhanced.indexOf('machine-supervised-jobs-ui.js') < enhanced.indexOf('machine-request-view-ui.js'));
  assert.equal((enhanceIndex(enhanced).match(/machine-human-gate-ui\.js/g) || []).length, 1);
  assert.equal((enhanceIndex(enhanced).match(/machine-supervised-jobs-ui\.js/g) || []).length, 1);
  assert.equal((enhanceIndex(enhanced).match(/machine-request-view-ui\.js/g) || []).length, 1);
  assert.deepEqual(INDEX_ENHANCEMENTS, [
    '<script src="/machine-human-gate-ui.js"></script>',
    '<script src="/room-recovery-intent.js"></script>',
    '<script src="/machine-supervised-jobs-ui.js"></script>',
    '<script src="/machine-request-view-ui.js"></script>'
  ]);
});

test('Human Input gate companion mirrors the Dex toggle and scopes Dex terminal creation to the active room', () => {
  const source = fs.readFileSync(path.join(root, 'public/machine-human-gate-ui.js'), 'utf8');
  assert.match(source, /machine_set_human_input/);
  assert.match(source, /data-human-input/);
  assert.match(source, /clientKind: 'machine-human-gate'/);
  assert.match(source, /machineNewTerminal/);
  assert.match(source, /machine_create_target/);
  assert.match(source, /roomId/);
  assert.match(source, /stopImmediatePropagation/);
  assert.match(source, /addEventListener\('click', createDexTerminal, true\)/);
  assert.match(source, /pagehide/);
  assert.doesNotMatch(source, /\[\[DEX:CMD/);
});

test('supervised UI exposes local start/rebound/cancel but no provider control markers', () => {
  const source = fs.readFileSync(path.join(root, 'public/machine-supervised-jobs-ui.js'), 'utf8');
  assert.match(source, /machine_start_supervised_job/);
  assert.match(source, /machine_rebound_supervised_job/);
  assert.match(source, /machine_cancel_supervised_job/);
  assert.match(source, /data-human-input/);
  assert.match(source, /Reattach supervision/);
  assert.match(source, /It will not replay the command/);
  assert.match(source, /machine_prepare_recovery_job/);
  assert.match(source, /machine_prepare_room_recovery/);
  assert.match(source, /retrySafeConfirmed: true/);
  assert.match(source, /Confirm safe recovery for this script/);
  assert.match(source, /visible read-only terminal/);
  assert.match(source, /I confirm this exact command is idempotent/);
  assert.match(source, /TLO may edit only/);
  assert.doesNotMatch(source, /\[\[DEX:CMD/);
  assert.doesNotMatch(source, /job_start['"]/);
});

test('room recovery intent accepts only explicit repository-relative supported scripts', () => {
  const intent = require('../public/room-recovery-intent');
  assert.deepEqual(intent.parse('/recover tools/smoke/check.js'), {
    schema: 'eveos.dex.room-recovery-intent.v1', scriptPath: 'tools/smoke/check.js' });
  assert.equal(intent.parse('run this script with recovery: ../escape.ps1'), null);
  assert.equal(intent.parse('run C:\\temp\\unsafe.ps1 with recovery'), null);
  assert.equal(intent.parse('please run anything'), null);
  assert.equal(intent.parse('/recover tools/a;exit.ps1'), null);
  assert.equal(intent.parse('/recover tools/a$env:SECRET.ps1'), null);
});

test('supervised output UI uses bounded paging instead of requesting raw process logs', () => {
  const source = fs.readFileSync(path.join(root, 'public/machine-supervised-jobs-ui.js'), 'utf8');
  assert.match(source, /machine_output_page/);
  assert.match(source, /nextOffset/);
  assert.match(source, /Load more/);
  assert.doesNotMatch(source, /stdout\s*=/);
  assert.doesNotMatch(source, /readFile/);
});
