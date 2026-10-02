const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const socketApi = require('../public/ui-socket.js');

class FakeWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 3;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.listeners = new Map();
    this.sent = [];
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  emit(type, value = {}) {
    if (type === 'open') this.readyState = FakeWebSocket.OPEN;
    if (type === 'close') this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get(type) || []) listener(value);
  }

  send(value) { this.sent.push(value); }
  close() {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.emit('close', { code: 1006, reason: 'client recovery' });
  }
}

function harness() {
  FakeWebSocket.instances = [];
  const scheduled = [];
  const timers = {
    setTimeout(fn, delay) {
      const entry = { fn, delay, cleared: false };
      scheduled.push(entry);
      return entry;
    },
    clearTimeout(entry) { if (entry) entry.cleared = true; }
  };
  const phases = [];
  const messages = [];
  const malformed = [];
  const client = socketApi.createClient({
    url: 'ws://127.0.0.1:9088/ws',
    hello: { type: 'hello', role: 'ui' },
    WebSocketImpl: FakeWebSocket,
    timers,
    onPhase: (value) => phases.push(value),
    onMessage: (value) => messages.push(value),
    onMalformed: (error) => malformed.push(error.message)
  });
  return { client, phases, messages, malformed, scheduled };
}

test('UI socket sends hello and permits dispatch only while connected', () => {
  const { client, phases } = harness();
  assert.equal(client.connect(), true);
  const socket = FakeWebSocket.instances[0];
  assert.equal(client.send({ type: 'request_tabs' }), false);
  socket.emit('open');
  assert.equal(phases.at(-1).phase, 'connected');
  assert.deepEqual(JSON.parse(socket.sent[0]), { type: 'hello', role: 'ui' });
  assert.equal(client.send({ type: 'request_tabs' }), true);
  assert.deepEqual(JSON.parse(socket.sent[1]), { type: 'request_tabs' });
});

test('short UI socket loss preserves a recovering phase and reconnects before hard disconnect', () => {
  const { client, phases, scheduled } = harness();
  client.connect();
  FakeWebSocket.instances[0].emit('open');
  FakeWebSocket.instances[0].emit('close', { code: 1006, reason: 'network change' });
  assert.equal(client.snapshot().phase, 'reconnecting');
  assert.equal(client.send({ type: 'send_prompt' }), false);
  assert.equal(phases.at(-1).closeCode, 1006);
  scheduled.find((entry) => entry.delay === 300).fn();
  FakeWebSocket.instances[1].emit('open');
  assert.equal(client.snapshot().phase, 'connected');
  assert.equal(client.snapshot().epoch, 2);
  const grace = scheduled.find((entry) => entry.delay === 8000);
  assert.equal(grace.cleared, true);
});

test('extended UI socket loss becomes disconnected after the visual grace period', () => {
  const { client, scheduled } = harness();
  client.connect();
  FakeWebSocket.instances[0].emit('open');
  FakeWebSocket.instances[0].emit('close');
  scheduled.find((entry) => entry.delay === 8000).fn();
  assert.equal(client.snapshot().phase, 'disconnected');
});

test('UI socket retries failed localhost reconnects with bounded exponential backoff', () => {
  const { client, scheduled } = harness();
  client.connect();
  FakeWebSocket.instances[0].emit('open');
  FakeWebSocket.instances[0].emit('close', { code: 1006 });
  scheduled.find((entry) => entry.delay === 300).fn();

  FakeWebSocket.instances[1].emit('close', { code: 1006 });
  assert.ok(scheduled.some((entry) => entry.delay === 600));

  scheduled.find((entry) => entry.delay === 600).fn();
  FakeWebSocket.instances[2].emit('close', { code: 1006 });
  assert.ok(scheduled.some((entry) => entry.delay === 1200));
});

test('UI socket error forces close so normal reconnect scheduling owns recovery', () => {
  const { client, scheduled } = harness();
  client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.emit('error', { message: 'connection reset' });
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.ok(scheduled.some((entry) => entry.delay === 300));
});

test('UI socket stop does not schedule a reconnect from its own close event', () => {
  const { client, scheduled } = harness();
  client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  client.stop();
  assert.equal(socket.readyState, FakeWebSocket.CLOSED);
  assert.equal(scheduled.filter((entry) => !entry.cleared && entry.delay <= 2000).length, 0);
});

test('UI socket parses bridge events and quarantines malformed payloads', () => {
  const { client, messages, malformed } = harness();
  client.connect();
  const socket = FakeWebSocket.instances[0];
  socket.emit('open');
  socket.emit('message', { data: '{"type":"tabs_update"}' });
  socket.emit('message', { data: '{not-json' });
  assert.deepEqual(messages, [{ type: 'tabs_update' }]);
  assert.equal(malformed.length, 1);
});

test('base and Dex UIs use the shared recovery client without stale socket state', () => {
  const publicDir = path.join(__dirname, '..', 'public');
  const app = fs.readFileSync(path.join(publicDir, 'app.js'), 'utf8');
  const dex = fs.readFileSync(path.join(publicDir, 'dex-mode.js'), 'utf8');
  const index = fs.readFileSync(path.join(publicDir, 'index.html'), 'utf8');
  assert.match(app, /socketApi\.createClient/);
  assert.match(dex, /socketApi\.createClient/);
  assert.doesNotMatch(`${app}\n${dex}`, /state\.(?:ws|reconnectTimer)/);
  assert.ok(index.indexOf('/ui-socket.js') < index.indexOf('/app.js'));
  assert.ok(index.indexOf('/ui-socket.js') < index.indexOf('/dex-mode.js'));
});
