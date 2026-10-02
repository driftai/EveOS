const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SERVER = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(ROOT, 'extension', 'service-worker.js'), 'utf8');
const MIRROR_WORKER = fs.readFileSync(path.join(ROOT, 'extension', 'chatgpt-app-mirror-worker.js'), 'utf8');

test('localhost routes App Mirror setup, sync and status through the extension authority', () => {
  for (const command of ['ensure_app_mirror', 'sync_app_mirror', 'request_app_mirror_status']) {
    assert.match(SERVER, new RegExp("'" + command + "'"));
  }
  assert.match(SERVER, /postIdleMaintenance\.leaseActive\(\).*ensure_app_mirror/);
  assert.match(SERVER, /postIdleMaintenance\.leaseActive\(\).*sync_app_mirror/);
});

test('extension delegates App Mirror commands to the isolated worker integration', () => {
  assert.match(WORKER, /appMirrorWorker\.handleBridgeCommand/);
  assert.match(WORKER, /appMirrorWorker\.noteCommittedPrompt/);
  assert.match(WORKER, /appMirrorWorker\.noteRuntimeMessage/);
  assert.match(WORKER, /appMirrorWorker\.restore/);
});

test('conversation sync remains an internal ChatGPT helper and never selects an Online-Origin mirror target', () => {
  assert.match(WORKER, /providerId === 'chatgpt'|provider\.id === 'chatgpt'|noteCommittedPrompt\(provider\.id/);
  assert.doesNotMatch(MIRROR_WORKER, /await selectTarget\(/);
  assert.doesNotMatch(WORKER, /providerId:\s*['"]chatgpt-app['"]/);
});
