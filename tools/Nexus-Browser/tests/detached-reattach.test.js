'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const REPO = path.resolve(ROOT, '..', '..');
const DETACHED = fs.readFileSync(path.join(ROOT, 'public', 'detached-state.js'), 'utf8');
const PARENT = fs.readFileSync(
  path.join(REPO, 'js', 'modules', 'gemini', 'search_monitor', 'nexusBrowser.js'),
  'utf8'
);

test('detached Nexus exposes an explicit reattach control', () => {
  assert.match(DETACHED, /Reattach to EveOS/);
  assert.match(DETACHED, /publish\('reattach'\)/);
  assert.match(DETACHED, /window\.close\(\)/);
});

test('EveOS parent accepts reattach and returns focus to the embedded workspace', () => {
  assert.match(PARENT, /event\.data\.state === 'reattach'/);
  assert.match(PARENT, /window\.focus\(\)/);
  assert.match(PARENT, /scrollIntoView/);
});
