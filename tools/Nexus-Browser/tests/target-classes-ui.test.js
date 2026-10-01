const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const APP_MIRROR_UI = fs.readFileSync(path.join(ROOT, 'public', 'app-mirror-ui.js'), 'utf8');

test('UI exposes Online-Origin and Local-Origin target classes', () => {
  assert.match(INDEX, /id="targetClassSelect"/);
  assert.match(INDEX, /Online-Origin Targets/);
  assert.match(INDEX, /Local-Origin Targets/);
});

test('online and local target controls are separate panels', () => {
  assert.match(INDEX, /id="onlineTargetControls"/);
  assert.match(INDEX, /id="localTargetControls"/);
  assert.match(INDEX, /id="providerSelect"/);
  assert.match(INDEX, /id="localTypeSelect"/);
  assert.match(INDEX, /id="localTargetSelect"/);
});

test('Local-Origin mode requests and selects local targets without browser tabs', () => {
  assert.match(APP, /request_local_targets/);
  assert.match(APP, /select_local_target/);
  assert.match(APP, /targetClassId:\s*state\.selectedTargetClassId/);
  assert.match(APP, /selectedTargetClassId === 'local-origin'/);
});

test('Capture latest remains online-only in first Local-Origin pass', () => {
  assert.match(APP, /captureLatest\.hidden = local/);
  assert.match(APP, /Search-result capture is available only for connected Online-Origin targets/);
});


test('ChatGPT App Mirror UI is an Online-Origin transport option, not a new target class', () => {
  assert.match(INDEX, /id="appMirrorControls"/);
  assert.match(INDEX, /id="appMirrorUrl"/);
  assert.match(INDEX, /id="attachAppMirror"/);
  assert.match(INDEX, /id="syncAppMirror"/);
  assert.match(APP_MIRROR_UI, /ensure_app_mirror/);
  assert.match(APP_MIRROR_UI, /sync_app_mirror/);
  assert.match(APP_MIRROR_UI, /selectedProviderId === 'chatgpt'/);
  assert.doesNotMatch(INDEX, /value="app-origin"/);
});
