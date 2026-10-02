'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..', '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const BASE = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const DEX = fs.readFileSync(path.join(ROOT, 'public', 'dex-mode.js'), 'utf8');
const DETACHED = fs.readFileSync(path.join(ROOT, 'public', 'detached-state.js'), 'utf8');
const HOST = fs.readFileSync(path.join(REPO, 'js', 'modules', 'gemini', 'search_monitor', 'nexusBrowser.js'), 'utf8');

test('workspace handoff helpers load before Base and Dex boot', () => {
  assert.ok(INDEX.indexOf('/workspace-handoff.js') < INDEX.indexOf('/app.js'));
  assert.ok(INDEX.indexOf('/workspace-base-state.js') < INDEX.indexOf('/app.js'));
  assert.ok(INDEX.indexOf('/workspace-dex-state.js') < INDEX.indexOf('/dex-mode.js'));
});

test('Base and Dex register with the same single-owner handoff coordinator', () => {
  assert.match(BASE, /handoff\.register\('base', baseWorkspace\)/);
  assert.match(DEX, /handoff\.register\('dex', dexWorkspace\)/);
  assert.match(BASE, /uiSocket\?\.stop\(\)/);
  assert.match(DEX, /dexSocket\?\.stop\(\)/);
});

test('reattach sends the latest detached snapshot directly to the embedded owner', () => {
  assert.match(HOST, /workspaceControl\('snapshot', 'detach'\)/);
  assert.match(HOST, /workspaceControl\('restore-and-claim', 'reattach', \{ snapshot: event\.data\.snapshot \}\)/);
  assert.match(HOST, /inline\.hidden = !running \|\| detachedOpen\(\)/);
  assert.match(DETACHED, /handoff\?\.snapshotNow\?\.\('reattach'\)/);
  assert.match(DETACHED, /publish\('reattach', \{ snapshot \}\)/);
  assert.match(DETACHED, /snapshot: false, disable: true/);
});
