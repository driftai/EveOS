const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');

const serviceChats = require('../local-targets/eveos-service-chats');
const geminiChat = require('../local-targets/gemini-link-chat');

function sseResponse(text) {
  const body = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(0, 3) } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(3) } }] })}\n\n`,
    'data: [DONE]\n\n'
  ].join('');
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
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

test('Local MoE streams through its existing chat endpoint and retains provider-workspace history', async () => {
  serviceChats._histories.clear(serviceChats.LOCAL_MOE_ID);
  const target = (await serviceChats.listTargets()).find((entry) => entry.id === serviceChats.LOCAL_MOE_ID);
  const calls = [];
  const events = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return sseResponse(calls.length === 1 ? 'one' : 'two');
  };
  await serviceChats.sendPrompt({ requestId: 'local-moe-0001', text: 'first', target, emit: (event) => events.push(event), fetchImpl });
  await serviceChats.sendPrompt({ requestId: 'local-moe-0002', text: 'second', target, emit: (event) => events.push(event), fetchImpl });
  assert.match(calls[0].url, /:5180\/api\/chat\/stream$/);
  assert.deepEqual(calls[0].body.history, []);
  assert.deepEqual(calls[1].body.history, [
    { role: 'user', content: 'first' }, { role: 'assistant', content: 'one' }
  ]);
  assert.equal(events.filter((event) => event.type === 'response_final').at(-1).text, 'two');
});

test('TLO uses the scoped Search Monitor route without any lifecycle start call', async () => {
  serviceChats._histories.clear(serviceChats.TLO_ID);
  const target = (await serviceChats.listTargets()).find((entry) => entry.id === serviceChats.TLO_ID);
  let call;
  await serviceChats.sendPrompt({
    requestId: 'tlo-chat-0001', text: 'hello', target, emit: () => {},
    fetchImpl: async (url, options) => { call = { url, body: JSON.parse(options.body) }; return sseResponse('ready'); }
  });
  assert.match(call.url, /:8765\/api\/eve-state\/modular\/tlo\/chat\/stream$/);
  assert.equal(call.body.scopeId, 'default');
  assert.equal(call.body.requestId, 'tlo-chat-0001');
  assert.doesNotMatch(call.url, /start|control/);
});

class FakeGeminiSocket extends EventEmitter {
  constructor(url) { super(); this.url = url; this.sent = []; queueMicrotask(() => this.emit('open')); }
  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    if (message.sessionRole === 'nexus_chat') {
      queueMicrotask(() => this.emit('message', JSON.stringify({ type: 'session_ready' })));
    } else if (message.type === 'text_brain_request') {
      queueMicrotask(() => this.emit('message', JSON.stringify({
        type: 'text_brain_response', requestId: message.requestId, text: 'Gemini reply'
      })));
    }
  }
  close() { this.closed = true; }
}

test('Gemini Link chat uses an isolated text role and returns one provider final', async () => {
  geminiChat._histories.clear(geminiChat.TARGET_ID);
  const events = [];
  const target = geminiChat.publicTarget();
  const reply = await geminiChat.sendPrompt({
    requestId: 'gemini-link-0001', text: 'hello', target,
    emit: (event) => events.push(event), WebSocketImpl: FakeGeminiSocket, timeoutMs: 1000
  });
  assert.equal(reply, 'Gemini reply');
  assert.equal(events.filter((event) => event.type === 'response_final').length, 1);
  assert.equal(events.at(-1).providerId, 'gemini-link-chat');
});

test('Gemini backend keeps Nexus chat out of the Live-session slot and voice loop', () => {
  const root = path.resolve(__dirname, '..', '..', '..');
  const handler = fs.readFileSync(path.join(root, 'server', 'gemini-backend', 'interactions',
    'main_server_files', 'websocket_server', 'gemini_session_handler.py'), 'utf8');
  const session = fs.readFileSync(path.join(root, 'server', 'gemini-backend', 'interactions',
    'main_server_files', 'websocket_server', 'session_handler', 'nexus_chat_session.py'), 'utf8');
  assert.match(handler, /session_role != "nexus_chat"/);
  assert.ok(handler.indexOf('if session_role == "nexus_chat"') < handler.indexOf('# 4. EXECUTE THE ROLE-SPECIFIC SESSION LOOP'));
  assert.match(session, /send_to_gemini\(\s*None,/s);
  assert.doesNotMatch(session, /live\.connect|acquire_session_slot/);
});
