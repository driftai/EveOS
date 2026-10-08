'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { INDEX_ENHANCEMENTS, enhanceIndex } = require('../server-http');

const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'machine-request-view-ui.js'), 'utf8');

test('server injects the unified request-view companion after the base Machine Spaces UI', () => {
  assert.ok(INDEX_ENHANCEMENTS.includes('<script src="/machine-request-view-ui.js"></script>'));
  const html = enhanceIndex('<html><body><script src="/machine-spaces-ui.js"></script></body></html>');
  const baseAt = html.indexOf('/machine-spaces-ui.js');
  const companionAt = html.indexOf('/machine-request-view-ui.js');
  assert.ok(baseAt >= 0);
  assert.ok(companionAt > baseAt);
  assert.equal(html.match(/machine-request-view-ui\.js/g)?.length, 1);
});

test('companion requests server-side kind/state/actor/query/live filters and cursor pages', () => {
  assert.match(source, /type:\s*'machine_request_view'/);
  assert.match(source, /kind:\s*kind\.value/);
  assert.match(source, /state:\s*stateFilter\.value/);
  assert.match(source, /actor:\s*actor\.value/);
  assert.match(source, /query:\s*query\.value/);
  assert.match(source, /liveOnly:\s*liveOnly\.checked/);
  assert.match(source, /cursor:\s*append\s*\?\s*nextCursor/);
  assert.match(source, /Load more/);
});

test('unified view preserves the legacy list as a fail-safe until server support answers', () => {
  assert.match(source, /legacy\.hidden\s*=\s*value\s*===\s*true/);
  assert.match(source, /available\s*=\s*true/);
  assert.match(source, /useUnified\(false\)/);
  assert.match(source, /legacy request history remains available/);
});

test('primary unified cards preserve provenance, local approval and bounded output actions', () => {
  assert.match(source, /machine-request-view-provenance/);
  assert.match(source, /sourceMessageId/);
  assert.match(source, /processEpoch/);
  assert.match(source, /operationDigest/);
  assert.match(source, /machine_approve_command/);
  assert.match(source, /machine_output_page/);
  assert.match(source, /data-human-input/);
});
