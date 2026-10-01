const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const APP_MIRROR_UI = fs.readFileSync(path.join(ROOT, 'public', 'app-mirror-ui.js'), 'utf8');
const APP_TARGETS_UI = fs.readFileSync(path.join(ROOT, 'public', 'app-targets-ui.js'), 'utf8');

test('Base Mode recognizes server-session lifecycle events instead of logging them as unhandled', () => {
  assert.match(APP, /case 'server_session':/);
});

test('UI exposes Online-Origin, Local-Origin and App-Origin target classes', () => {
  assert.match(INDEX, /id="targetClassSelect"/);
  assert.match(INDEX, /Online-Origin Targets/);
  assert.match(INDEX, /Local-Origin Targets/);
  assert.match(INDEX, /App-Origin Targets/);
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

test('Dex participant builder exposes App-Origin as a first-class target class', () => {
  assert.match(INDEX, /id="dexMemberClass"[\s\S]*value="app-origin">App-Origin/);
});

test('Dex refuses ambiguous ChatGPT App bindings without native conversation identity', () => {
  const members = fs.readFileSync(path.join(ROOT, 'public', 'dex-members.js'), 'utf8');
  assert.match(members, /providerId === 'chatgpt-desktop'[\s\S]*conversationTitle/);
  assert.match(members, /Open the intended ChatGPT conversation first/);
});

test('Dex participant builder can refresh Online, Local and App-Origin targets in place', () => {
  assert.match(INDEX, /id="dexRefreshTargets"/);
  assert.match(APP, /request_tabs/);
  assert.match(APP, /request_local_targets/);
  assert.match(APP, /request_app_targets/);
});

test('Capture latest stays hidden for Local-Origin while App-Origin can capture visible app replies', () => {
  assert.match(APP, /captureLatest\.hidden = local/);
  assert.match(APP, /targetClassId:\s*state\.selectedTargetClassId/);
  assert.match(APP, /selectedTargetClassId === 'app-origin'/);
  assert.match(APP, /Search-result capture is available only for connected Online-Origin targets/);
});


test('ChatGPT App Mirror stays an Online-Origin transport while native apps use App-Origin', () => {
  assert.match(INDEX, /id="appMirrorControls"/);
  assert.match(INDEX, /id="appMirrorUrl"/);
  assert.match(INDEX, /id="attachAppMirror"/);
  assert.match(INDEX, /id="syncAppMirror"/);
  assert.match(APP_MIRROR_UI, /ensure_app_mirror/);
  assert.match(APP_MIRROR_UI, /sync_app_mirror/);
  assert.match(APP_MIRROR_UI, /selectedProviderId === 'chatgpt'/);
  assert.match(INDEX, /value="app-origin"/);
  assert.match(INDEX, /id="appTargetControls"/);
  assert.match(APP_TARGETS_UI, /request_app_targets/);
  assert.match(APP_TARGETS_UI, /select_app_target/);
});
