const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const serviceChats = require('../local-targets/eveos-service-chats');
const geminiChat = require('../local-targets/gemini-link-chat');
const workspaceBridge = require('../service-workspace-bridge');
function workspaceHost(targets) {
  const socket = { readyState: 1, sent: [], send(raw) { this.sent.push(JSON.parse(raw)); } };
  workspaceBridge.registerHost(socket, { workspaceId: 'search-monitor-one', targets });
  return socket;
}

test('Local MoE and TLO are passive provider-workspace targets', async () => {
  const targets = await serviceChats.listTargets();
  assert.deepEqual(targets.map((target) => target.id), [serviceChats.LOCAL_MOE_ID, serviceChats.TLO_ID]);
  for (const target of targets) {
    assert.equal(target.targetClassId, 'local-origin');
    assert.equal(target.targetTypeId, 'provider-workspace');
    assert.equal(target.capabilities.chat, true);
    assert.match(target.detail, /Local MoE|Search Monitor|never starts/i);
  }
});

test('Local MoE routes into its exact existing Search Monitor workspace without a shadow history', async () => {
  workspaceBridge._resetForTests();
  const target = (await serviceChats.listTargets()).find((entry) => entry.id === serviceChats.LOCAL_MOE_ID);
  const socket = workspaceHost([serviceChats.LOCAL_MOE_ID]);
  const events = [], pending = serviceChats.sendPrompt({ requestId: 'local-moe-0001', text: 'first', target,
    emit: (event) => events.push(event) });
  assert.deepEqual(socket.sent[0], { type: 'service_workspace_request', targetId: serviceChats.LOCAL_MOE_ID,
    requestId: 'local-moe-0001', text: 'first', workspaceId: 'search-monitor-one' });
  workspaceBridge.handleHostMessage(socket, { type: 'service_workspace_final', targetId: serviceChats.LOCAL_MOE_ID,
    requestId: 'local-moe-0001', workspaceId: 'search-monitor-one', text: 'one' });
  assert.equal(await pending, 'one');
  assert.equal(events.at(-1).text, 'one');
});

test('TLO uses the same passive Search Monitor workspace bridge without a lifecycle start call', async () => {
  workspaceBridge._resetForTests();
  const target = (await serviceChats.listTargets()).find((entry) => entry.id === serviceChats.TLO_ID);
  const socket = workspaceHost([serviceChats.TLO_ID]);
  const pending = serviceChats.sendPrompt({ requestId: 'tlo-chat-0001', text: 'hello', target, emit: () => {} });
  assert.equal(socket.sent[0].targetId, serviceChats.TLO_ID);
  assert.equal(Object.hasOwn(socket.sent[0], 'history'), false);
  assert.equal(Object.hasOwn(socket.sent[0], 'start'), false);
  workspaceBridge.handleHostMessage(socket, { type: 'service_workspace_final', targetId: serviceChats.TLO_ID,
    requestId: 'tlo-chat-0001', workspaceId: 'search-monitor-one', text: 'ready' });
  assert.equal(await pending, 'ready');
});

class FakeGeminiSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; queueMicrotask(() => this.emit('open')); }
  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.sessionRole === 'nexus_chat') {
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session_ready', workspace: { bound: true } })));
    } else if (message.type === 'nexus_workspace_request') {
      queueMicrotask(() => {
        this.emit('message', JSON.stringify({ type: 'nexus_workspace_text', requestId: message.requestId,
          correlation: message.correlation, text: 'Gemini reply' }));
        this.emit('message', JSON.stringify({ type: 'nexus_workspace_turn_complete', requestId: message.requestId,
          correlation: message.correlation }));
      });
    }
  }
  close() { this.closed = true; }
}

test('Gemini Link chat uses the active workspace sidecar and returns one provider final', async () => {
  geminiChat._histories.clear(geminiChat.TARGET_ID);
  const events = [];
  const target = geminiChat.publicTarget();
  const reply = await geminiChat.sendPrompt({
    requestId: 'gemini-link-0001', text: 'hello', target,
    emit: (event) => events.push(event), WebSocketImpl: FakeGeminiSocket, timeoutMs: 1000, lateReplyGraceMs: 0
  });
  assert.equal(reply, 'Gemini reply');
  assert.equal(events.filter((event) => event.type === 'response_final').length, 1);
  assert.equal(events.at(-1).providerId, 'gemini-link-chat');
});

test('Gemini backend keeps Nexus chat in the existing workspace and out of a second Live-session slot', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const handler = fs.readFileSync(path.join(root, 'server', 'gemini-backend', 'interactions',
    'main_server_files', 'websocket_server', 'gemini_session_handler.py'), 'utf8');
  const session = fs.readFileSync(path.join(root, 'server', 'gemini-backend', 'interactions',
    'main_server_files', 'websocket_server', 'session_handler', 'nexus_chat_session.py'), 'utf8');
  assert.match(handler, /session_role != "nexus_chat"/);
  assert.ok(handler.indexOf('if session_role == "nexus_chat"') < handler.indexOf('# 4. EXECUTE THE ROLE-SPECIFIC SESSION LOOP'));
  assert.match(session, /stream_workspace_turn\(/);
  assert.match(session, /workspace_connection_id=workspace_connection_id/);
  assert.doesNotMatch(session, /send_to_gemini|live\.connect|acquire_session_slot/);
});
