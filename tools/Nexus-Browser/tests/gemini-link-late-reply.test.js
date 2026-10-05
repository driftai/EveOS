'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const {
  correlationMatches,
  sendPrompt
} = require('../local-targets/gemini-link-chat');

const CORRELATION = Object.freeze({
  roomId: 'room-1',
  turnId: 'dex-turn-1',
  requestId: 'dex-turn-1',
  sourceMessageId: 'msg-source-1'
});

class MockWebSocket extends EventEmitter {
  static instances = [];

  constructor(url) {
    super();
    this.url = url;
    this.sent = [];
    this.closed = false;
    MockWebSocket.instances.push(this);
    queueMicrotask(() => this.emit('open'));
  }

  send(raw) {
    const message = JSON.parse(String(raw));
    this.sent.push(message);
    if (message.sessionRole === 'nexus_chat') {
      queueMicrotask(() => this.emit('message', JSON.stringify({
        type: 'session_ready',
        workspace: { bound: true, connectionId: 'gemini-workspace-1' }
      })));
    }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.emit('close');
  }
}

async function waitFor(predicate, timeoutMs = 250) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error('Timed out waiting for mock websocket state.');
}

function event(type, extra = {}) {
  return JSON.stringify({
    type,
    requestId: CORRELATION.requestId,
    correlation: { ...CORRELATION },
    ...extra
  });
}

test('correlation matcher requires the exact Dex room/turn/request/source tuple', () => {
  assert.equal(correlationMatches({ requestId: CORRELATION.requestId, correlation: CORRELATION }, CORRELATION), true);
  for (const key of ['roomId', 'turnId', 'requestId', 'sourceMessageId']) {
    const changed = { ...CORRELATION, [key]: `${CORRELATION[key]}-other` };
    const message = {
      requestId: key === 'requestId' ? changed.requestId : CORRELATION.requestId,
      correlation: changed
    };
    assert.equal(correlationMatches(message, CORRELATION), false, `${key} mismatch was accepted`);
  }
});

test('a correlated Gemini reply after the old deadline wins inside the bounded grace window', async () => {
  MockWebSocket.instances.length = 0;
  const emitted = [];
  const pending = sendPrompt({
    requestId: CORRELATION.requestId,
    text: 'late reply test',
    correlation: CORRELATION,
    emit: (message) => emitted.push(message),
    WebSocketImpl: MockWebSocket,
    timeoutMs: 12,
    lateReplyGraceMs: 60
  });

  const socket = await waitFor(() => MockWebSocket.instances[0]);
  const request = await waitFor(() => socket.sent.find((message) => message.type === 'nexus_workspace_request'));
  assert.deepEqual(request.correlation, CORRELATION);
  assert.equal(request.timeoutMs, 72);

  await new Promise((resolve) => setTimeout(resolve, 22));
  assert.equal(emitted.some((message) => message.type === 'response_activity' && message.event === 'late_reply_grace'), true);

  socket.emit('message', event('nexus_workspace_transcription', { text: 'late correlated answer' }));
  socket.emit('message', event('nexus_workspace_turn_complete'));

  assert.equal(await pending, 'late correlated answer');
  assert.equal(emitted.filter((message) => message.type === 'response_final').length, 1);
  assert.equal(emitted.find((message) => message.type === 'response_final').correlation.sourceMessageId, CORRELATION.sourceMessageId);
});

test('mismatched late replies are ignored and the request rejects once after grace', async () => {
  MockWebSocket.instances.length = 0;
  const emitted = [];
  const pending = sendPrompt({
    requestId: CORRELATION.requestId,
    text: 'ignore wrong room',
    correlation: CORRELATION,
    emit: (message) => emitted.push(message),
    WebSocketImpl: MockWebSocket,
    timeoutMs: 8,
    lateReplyGraceMs: 24
  });

  const socket = await waitFor(() => MockWebSocket.instances[0]);
  await waitFor(() => socket.sent.find((message) => message.type === 'nexus_workspace_request'));
  await new Promise((resolve) => setTimeout(resolve, 12));

  socket.emit('message', JSON.stringify({
    type: 'nexus_workspace_turn_complete',
    requestId: CORRELATION.requestId,
    correlation: { ...CORRELATION, roomId: 'wrong-room' }
  }));

  await assert.rejects(pending, /late-reply grace window/);
  assert.equal(emitted.filter((message) => message.type === 'response_final').length, 0);
  assert.equal(emitted.filter((message) => message.type === 'response_activity' && message.event === 'late_reply_grace').length, 1);
});