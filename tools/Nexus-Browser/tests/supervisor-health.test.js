'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { createChildHealthProbe } = require('../scripts/supervisor-child-health');
const { attachSupervisorHealth } = require('../server-supervisor-health');

test('owned Nexus child confirms listening state over IPC when HTTP health misses', async () => {
  const processRef = new EventEmitter();
  processRef.connected = true;
  const child = new EventEmitter();
  child.connected = true;
  child.killed = false;
  const server = {
    listening: true,
    address() { return { address: '127.0.0.1', port: 9088 }; }
  };
  const sentByServer = [];
  processRef.send = (message) => {
    sentByServer.push(message);
    queueMicrotask(() => child.emit('message', message));
  };
  const detach = attachSupervisorHealth({
    server,
    sessionId: 'session-live',
    processRef
  });

  const probe = createChildHealthProbe({ timeoutMs: 100 });
  child.send = (message) => queueMicrotask(() => processRef.emit('message', message));
  child.on('message', (message) => probe.handle(child, message));

  const result = await probe.probe(child);
  assert.equal(result.ok, true);
  assert.equal(result.listening, true);
  assert.equal(result.sessionId, 'session-live');
  assert.equal(result.address?.port, 9088);
  assert.equal(sentByServer.at(-1).type, 'supervisor_health_ack');
  detach();
});

test('supervisor IPC health probe fails closed for an unresponsive child', async () => {
  const probe = createChildHealthProbe({ timeoutMs: 5 });
  const child = {
    connected: true,
    killed: false,
    send() {}
  };
  const result = await probe.probe(child);
  assert.equal(result.ok, false);
  assert.equal(result.listening, false);
  assert.equal(result.reason, 'ipc-timeout');
  assert.equal(probe.pendingCount(), 0);
});

test('supervisor IPC health rejects unavailable or exited children immediately', async () => {
  const probe = createChildHealthProbe({ timeoutMs: 100 });
  assert.deepEqual(await probe.probe(null), {
    ok: false, listening: false, reason: 'ipc-unavailable'
  });
  assert.deepEqual(await probe.probe({ killed: true, connected: true, send() {} }), {
    ok: false, listening: false, reason: 'ipc-unavailable'
  });
});
