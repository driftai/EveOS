const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const dexMode = fs.readFileSync(path.join(ROOT, 'public', 'dex-mode.js'), 'utf8');
const runtimeClient = fs.readFileSync(path.join(ROOT, 'public', 'dex-runtime-client.js'), 'utf8');
const dexMembers = fs.readFileSync(path.join(ROOT, 'public', 'dex-members.js'), 'utf8');
const providerControl = fs.readFileSync(path.join(ROOT, 'public', 'dex-provider-control.js'), 'utf8');
const providerHealth = fs.readFileSync(path.join(ROOT, 'public', 'dex-provider-health.js'), 'utf8');
const server = fs.readFileSync(path.join(ROOT, 'server.js'), 'utf8');
const humanInputServerRoute = fs.readFileSync(
  path.join(ROOT, 'dex', 'server-human-input-route.js'), 'utf8');
const scheduler = fs.readFileSync(path.join(ROOT, 'dex', 'server-scheduler.js'), 'utf8');
const recovery = fs.readFileSync(path.join(ROOT, 'dex', 'server-scheduler-recovery.js'), 'utf8');

test('Base Mode remains present and Dex Mode is a separate sibling panel', () => {
  assert.match(html, /id="baseModeTab"[^>]*>Base Mode</);
  assert.match(html, /id="dexModeTab"[^>]*>Dex Mode</);
  assert.match(html, /id="baseModePanel"/);
  assert.match(html, /id="dexModePanel" hidden/);
  assert.match(html, /id="targetClassSelect"/);
  assert.match(html, /id="providerSelect"/);
  assert.match(html, /id="localTargetSelect"/);
});

test('Dex UI uses the shared relay-budget ceiling instead of a stale HTML cap', () => {
  assert.match(html, /id="dexMaxTurns"[^>]*min="1"/);
  assert.doesNotMatch(html, /id="dexMaxTurns"[^>]*max="50"/);
  assert.match(dexMode, /protocol\.MAX_RELAY_TURNS/);
  assert.doesNotMatch(dexMode, /maxTurns, 1, 50/);
});

test('Dex UI exposes room identity, member binding, relay controls and separate transcript', () => {
  for (const id of [
    'dexRoomList', 'dexRoomName', 'dexUserName', 'dexMemberClass', 'dexMemberType',
    'dexMemberTarget', 'dexMemberName', 'dexMemberRelayEnabled', 'dexMemberList',
    'dexTranscript', 'dexPrompt', 'dexSend', 'dexStopRelay', 'dexContinueRelay', 'dexClearChat'
  ]) assert.match(html, new RegExp(`id="${id}"`), `Missing Dex UI control ${id}`);

  assert.match(html, /\/dex-protocol\.js/);
  assert.match(html, /\/dex-runtime-client\.js/);
  assert.match(html, /\/dex-mode\.js/);
  assert.match(html, /\/dex-mode\.css/);
  assert.doesNotMatch(html, /\/dex-recovery\.js/);
  assert.doesNotMatch(html, /\/dex-scheduler\.js/);
});

test('browser Dex runtime is viewer/controller only and cannot own provider transport', () => {
  assert.match(dexMode, /browser-ai-bridge\.dex\.rooms\.v1/);
  assert.doesNotMatch(dexMode, /state\.turn/);
  assert.doesNotMatch(dexMode, /state\.queue/);
  assert.doesNotMatch(dexMode, /BrowserAiBridgeDexRecovery/);
  assert.doesNotMatch(dexMode, /type:\s*['"]send_prompt['"]/);
  assert.doesNotMatch(dexMode, /type:\s*['"]select_target['"]/);
  assert.doesNotMatch(dexMode, /type:\s*['"]ensure_target['"]/);
  assert.doesNotMatch(dexMode, /type:\s*['"]capture_latest['"]/);
  assert.match(runtimeClient, /dex_relay_start/);
  assert.match(runtimeClient, /dex_relay_stop/);
  assert.match(runtimeClient, /dex_relay_continue/);
});

test('localhost server owns scheduling, exact target routing, timeout and recovery', () => {
  assert.match(server, /createDexServerScheduler/);
  assert.match(server, /scheduler: dexScheduler/);
  assert.match(humanInputServerRoute, /scheduler\.startRelay\(msg\)/);
  assert.match(humanInputServerRoute, /scheduler\.stopRelay\(msg\)/);
  assert.match(humanInputServerRoute, /scheduler\.continueRelay\(msg\)/);
  assert.match(server, /dexScheduler\.handleTransportEvent/);
  assert.match(server, /DEX_SERVER_SCHEDULER_OWNS_TRANSPORT/);
  assert.match(scheduler, /protocol\.nextMemberIndex|stateApi\.enqueueNext/);
  assert.match(scheduler, /TURN_TIMEOUT_MS/);
  assert.match(scheduler, /type:\s*'select_target'/);
  assert.match(scheduler, /type:\s*'send_prompt'/);
  assert.match(recovery, /type:\s*'capture_latest'/);
  assert.doesNotMatch(recovery, /type:\s*'send_prompt'/);
});

test('Dex treats server-process changes as soft resync and asset changes as the only reload trigger', () => {
  assert.match(server, /SERVER_SESSION_ID/);
  assert.match(server, /assetRevision: ASSET_REVISION/);
  assert.match(dexMode, /sessionPolicy\.observe/);
  assert.match(dexMode, /onSoftResync/);
  assert.match(dexMode, /onAssetChange/);
  assert.match(dexMode, /state\.uiConnectionPhase = 'resyncing'/);
  assert.match(dexMode, /state\.uiConnectionPhase = 'connected'/);
  assert.match(dexMode, /savedView\?\.scrollTop/);
  assert.doesNotMatch(dexMode, /Bridge server restart detected.*reloading/);
  assert.doesNotMatch(dexMode, /recover the already-dispatched reply after reconnect/);
});

test('server-authorized edits stay room-scoped while the browser mirrors server state', () => {
  assert.match(server, /humanInputRoute\.handle\(ws, msg\)/);
  assert.match(humanInputServerRoute, /operation: 'state:edit', roomId, kind: 'human-input'/);
  assert.match(humanInputServerRoute, /scopedState\.mergeRoomEdit\(stateStore\.load\(\), msg\.snapshot, roomId\)/);
  assert.match(humanInputServerRoute, /stateStore\.save\(merged\.snapshot\)/);
  assert.match(dexMode, /Dex state synchronized from localhost scheduler/);
  assert.match(dexMode, /stateSync\?\.applyRemote/);
});

test('room deletion is a localhost-authorized operation and stopped receipt rooms remain editable', () => {
  assert.match(server, /humanInputRoute\.handle\(ws, msg\)/);
  assert.match(humanInputServerRoute, /if \(msg\.type === 'dex_room_delete'\) return deleteRoom\(ws, msg\)/);
  assert.match(humanInputServerRoute, /function deleteRoom\(ws, msg\) \{\s*const access = authorize\(ws, msg, \{ operation: 'room:delete', roomId: msg\.roomId, kind: 'human-input' \}\);\s*if \(!access\.ok\) return sendError\(ws, msg, access\);/);
  assert.match(dexMode, /type: 'dex_room_delete'/);
  assert.match(dexMode, /msg\.type === 'dex_room_delete_result'/);
  assert.match(dexMode, /roomExecutionBusy\(state, room\)/);
  assert.match(dexMode, /unresolved provider receipt preserved; editing available/);
});

test('Dex exposes safe room-chat clearing without deleting room identity or participants', () => {
  assert.match(html, /id="dexClearChat"[^>]*>Clear chat</);
  assert.match(dexMode, /controlApi\.clearRoomHistory\(room\)/);
  assert.match(dexMode, /controlApi\.roomBusy\(state, room\)/);
  assert.match(dexMode, /Participants and room settings stay intact/);
});

test('Dex participant UI exposes headed relay participation control', () => {
  assert.match(html, /id="dexMemberRelayEnabled"[^>]*type="checkbox"/);
  assert.match(html, /Participates in relay/);
  assert.match(dexMode, /dexMemberRelayEnabled/);
});


test('all browser Dex helpers remain free of live queue/current-turn ownership', () => {
  for (const [name, source] of [
    ['dex-mode', dexMode],
    ['dex-members', dexMembers],
    ['dex-provider-control', providerControl],
    ['dex-provider-health', providerHealth]
  ]) {
    assert.doesNotMatch(source, /state\.turn/, name);
    assert.doesNotMatch(source, /state\.queue/, name);
    assert.doesNotMatch(source, /BrowserAiBridgeDexRecovery/, name);
    assert.doesNotMatch(source, /BrowserAiBridgeDexScheduler/, name);
  }
});
