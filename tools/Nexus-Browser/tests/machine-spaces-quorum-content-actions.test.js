'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

test('every online provider loads quorum actions after provider control', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'extension/manifest.json'), 'utf8'));
  assert.ok(manifest.content_scripts.length >= 1);
  for (const entry of manifest.content_scripts) {
    const control = entry.js.indexOf('content/dex-provider-control.js');
    const quorum = entry.js.indexOf('content/machine-quorum-actions.js');
    assert.ok(control >= 0, `${entry.matches.join(',')} must load provider control`);
    assert.ok(quorum > control, `${entry.matches.join(',')} must register quorum actions after provider control`);
  }
});

test('quorum content action list matches the server-facing action contract', () => {
  const source = fs.readFileSync(path.join(root, 'extension/content/machine-quorum-actions.js'), 'utf8');
  for (const action of ['quorum_presence', 'quorum_open', 'quorum_vote', 'quorum_status', 'quorum_close']) {
    assert.match(source, new RegExp(`['\"]${action}['\"]`));
  }
  assert.match(source, /BrowserAiBridgeDexProviderControlContent/);
  assert.match(source, /ACTIONS\?\.add/);
});
