'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const HOST = fs.readFileSync(
  path.join(ROOT, 'js', 'modules', 'gemini', 'search_monitor', 'nexusBrowser.js'),
  'utf8'
);

test('EveOS Nexus host canonicalizes iframe URLs before deciding to reload', () => {
  assert.match(HOST, /function canonicalUrl\(value\)/);
  assert.match(HOST, /canonicalUrl\(frame\.getAttribute\('src'\) \|\| ''\)/);
  assert.match(HOST, /if \(next && current !== next\) frame\.setAttribute\('src', next\)/);
  assert.doesNotMatch(HOST, /frame\.src !== next/);
});

test('transient status failure preserves a known-running embedded Nexus workspace', () => {
  assert.match(HOST, /if \(status\?\.running === true\) render\(status, message\)/);
  assert.match(HOST, /Keeping the current workspace while Search Monitor retries/);
});


test('detached Nexus is a single-workspace handoff rather than a second persistent iframe owner', () => {
  assert.match(HOST, /workspaceControl\('snapshot', 'detach'\)/);
  assert.match(HOST, /workspaceControl\('claim', 'reattach'\)/);
  assert.match(HOST, /inline\.hidden = !running \|\| detachedOpen\(\)/);
  assert.match(HOST, /if \(detachedOpen\(\) && detachedWindow && !detachedWindow\.closed\)/);
  assert.match(HOST, /detachedWindow\.focus\(\)/);
});


test('Search Monitor retires an older embedded Nexus root and explicitly owns the current visible frame', () => {
  assert.match(HOST, /workspaceControlFor\(previous, 'standby', 'host-root-replaced'\)/);
  assert.match(HOST, /workspaceControlFor\(container, 'claim-fresh', 'host-frame-load'\)/);
  assert.match(HOST, /workspaceControl\('claim', 'host-activate'\)/);
});
