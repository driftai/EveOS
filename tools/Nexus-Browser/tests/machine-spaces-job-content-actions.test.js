'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('every online provider loads supervised job actions after provider control', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
  assert.ok(manifest.content_scripts.length >= 1);
  for (const entry of manifest.content_scripts) {
    const control = entry.js.indexOf('content/dex-provider-control.js');
    const jobs = entry.js.indexOf('content/machine-job-actions.js');
    assert.ok(control >= 0, `${entry.matches.join(',')} must load provider control`);
    assert.ok(jobs > control, `${entry.matches.join(',')} must register supervised job actions after provider control`);
  }
});

test('supervised job content actions expose prepare/status/list only', () => {
  const source = fs.readFileSync(path.join(root, 'extension/content/machine-job-actions.js'), 'utf8');
  for (const action of ['job_prepare', 'job_status', 'job_list']) assert.match(source, new RegExp(`['\"]${action}['\"]`));
  assert.doesNotMatch(source, /job_start/);
  assert.doesNotMatch(source, /job_rebound/);
  assert.match(source, /BrowserAiBridgeDexProviderControlContent/);
});
