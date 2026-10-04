'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createSafeSend, guardAsyncHandler, requestIdFromRaw } = require('../server-socket-safety');

test('safe websocket send converts close races into a false result instead of throwing', () => {
  const errors = [];
  const safeSend = createSafeSend({ openState: 1, onError: (error, detail) => errors.push([error.message, detail.phase]) });
  const closed = { readyState: 3, send() { throw new Error('should not run'); } };
  assert.equal(safeSend(closed, { type: 'x' }), false);

  const raced = { readyState: 1, send() { throw new Error('socket closed during send'); } };
  assert.equal(safeSend(raced, { type: 'x' }), false);
  assert.deepEqual(errors, [['socket closed during send', 'send']]);
});

test('safe websocket send quarantines async send callback errors', async () => {
  const errors = [];
  const safeSend = createSafeSend({ openState: 1, onError: (error, detail) => errors.push([error.message, detail.phase]) });
  const socket = {
    readyState: 1,
    send(_body, callback) { queueMicrotask(() => callback(new Error('late write failure'))); }
  };
  assert.equal(safeSend(socket, { type: 'x' }), true);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(errors, [['late write failure', 'callback']]);
});

test('guarded async websocket handler catches rejected commands without unhandled rejection', async () => {
  const observed = [];
  const guarded = guardAsyncHandler(async (raw) => {
    await Promise.resolve();
    throw Object.assign(new Error('synthetic command failure'), { raw });
  }, { onError: (error, raw) => observed.push([error.message, String(raw)]) });
  guarded('{"requestId":"req-1"}');
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(observed, [['synthetic command failure', '{"requestId":"req-1"}']]);
});

test('requestId recovery is best-effort and never throws on malformed input', () => {
  assert.equal(requestIdFromRaw('{"requestId":"abc"}'), 'abc');
  assert.equal(requestIdFromRaw('{bad-json'), null);
  assert.equal(requestIdFromRaw(null), null);
});
