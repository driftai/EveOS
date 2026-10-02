const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const APP_MIRROR_UI = fs.readFileSync(path.join(ROOT, 'public', 'app-mirror-ui.js'), 'utf8');
const APP_TARGETS_UI = fs.readFileSync(path.join(ROOT, 'public', 'app-targets-ui.js'), 'utf8');
const DEX_MODE = fs.readFileSync(path.join(ROOT, 'public', 'dex-mode.js'), 'utf8');

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
  assert.match(DEX_MODE, /request_tabs/);
  assert.match(DEX_MODE, /request_local_targets/);
  assert.match(DEX_MODE, /request_app_targets/);
});

test('Capture latest stays hidden for Local-Origin while App-Origin can capture visible app replies', () => {
  assert.match(APP, /captureLatest\.hidden = local/);
  assert.match(APP, /targetClassId:\s*state\.selectedTargetClassId/);
  assert.match(APP, /selectedTargetClassId === 'app-origin'/);
  assert.match(APP, /Search-result capture is available only for connected Online-Origin targets/);
});


test('ChatGPT conversation sync is an App-Origin capability, not a separate Online-Origin target', () => {
  assert.match(INDEX, /id="appTargetControls"[\s\S]*id="appMirrorControls"/);
  assert.match(INDEX, /Conversation sync/);
  assert.match(INDEX, /id="appMirrorUrl"/);
  assert.match(APP_MIRROR_UI, /ensure_app_mirror/);
  assert.match(APP_MIRROR_UI, /sync_app_mirror/);
  assert.match(APP_MIRROR_UI, /selectedTargetClassId === 'app-origin'/);
  assert.match(APP_MIRROR_UI, /providerId === 'chatgpt-desktop'/);
  assert.match(APP, /tab\.appMirror !== true/);
  assert.match(DEX_MODE, /tab\.appMirror !== true/);
  assert.match(APP_TARGETS_UI, /request_app_targets/);
  assert.match(APP_TARGETS_UI, /select_app_target/);
});


test('Base Mode App-Origin renders passive native turns and ACKs durable fingerprints', () => {
  assert.match(APP_TARGETS_UI, /native_app_turn/);
  assert.match(APP_TARGETS_UI, /ack_native_app_turn/);
  assert.match(APP_TARGETS_UI, /app_target_rebind_required/);
  assert.match(APP_TARGETS_UI, /app_target_binding_update/);
  assert.match(APP_TARGETS_UI, /bindingIdentity/);
  assert.match(APP_TARGETS_UI, /expectedIdentity/);
});


test('App-Origin exposes the latest native transport stage timings in the target panel', () => {
  assert.match(INDEX, /id="appTargetTiming"/);
  assert.match(APP_TARGETS_UI, /Send→app/);
  assert.match(APP_TARGETS_UI, /App→first/);
  assert.match(APP_TARGETS_UI, /App→final/);
  assert.match(APP_TARGETS_UI, /Round trip/);
});


test('Conversation sync is optional and collapsed by default', () => {
  assert.match(INDEX, /<details id="appMirrorControls"[^>]*>/);
  assert.doesNotMatch(INDEX, /<details id="appMirrorControls"[^>]*\sopen(?:\s|>)/);
  assert.match(INDEX, /<summary>Conversation sync<\/summary>/);
});

test('intentional handoff suspension is not mislabeled as a transport reconnect', () => {
  assert.match(APP, /state\.uiConnectionPhase === 'suspended' \? 'Workspace standby'/);
  assert.match(APP, /closeCode/);
  assert.match(DEX_MODE, /closeCode/);
});


test('fresh App-Origin discovery is manual-connect only and does not backfill native history', () => {
  assert.doesNotMatch(APP_TARGETS_UI, /if \(msg\.target\)\s*\{\s*selectedTarget = msg\.target/);
  assert.match(APP_TARGETS_UI, /el\.connect\?\.addEventListener\('click'/);
  assert.match(APP_TARGETS_UI, /send\(\{ type: 'select_app_target', targetId \}\)/);
  assert.match(APP_TARGETS_UI, /Suppressed passive .* history before manual Base connection/);
});
