'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createHarness() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'public', 'app-busy-recovery.js'), 'utf8');
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: 'app-busy-recovery.js' });
  const sent = [], messages = [], logs = [];
  const controller = context.globalThis.BrowserAiBridgeAppBusyRecovery.create({
    send(payload) { sent.push(payload); return true; },
    addMessage(role, text) { messages.push({ role, text }); },
    log(text) { logs.push(text); }
  });
  return { controller, sent, messages, logs };
}

test('busy App-Origin click preserves the draft path and probes the original request once', () => {
  const h = createHarness();
  const args = {
    target: { id: 'app-chatgpt-windows' },
    pending: new Map([['request-1', { targetClassId: 'app-origin' }]]),
    status: { phase: 'streaming', requestId: 'request-1' }
  };
  assert.equal(h.controller.requestIfBusy(args), true);
  assert.equal(h.controller.requestIfBusy(args), true);
  assert.equal(h.sent.length, 1);
  assert.deepEqual({ ...h.sent[0] }, {
    type: 'recover_app_target_busy',
    requestId: 'request-1',
    targetClassId: 'app-origin',
    targetId: 'app-chatgpt-windows'
  });
  assert.match(h.messages[0].text, /Checking the finished native reply/);
});

test('refused or failed busy recovery can be retried while canonical final clears it', () => {
  const h = createHarness();
  const args = {
    target: { id: 'app-chatgpt-windows' },
    pending: new Map([['request-2', { targetClassId: 'app-origin' }]]),
    status: { phase: 'waiting', requestId: 'request-2' }
  };
  h.controller.requestIfBusy(args);
  h.controller.observe({ requestId: 'request-2', recovered: false, reason: 'not-stable-yet' });
  h.controller.requestIfBusy(args);
  assert.equal(h.sent.length, 2);
  h.controller.complete('request-2');
  h.controller.requestIfBusy(args);
  assert.equal(h.sent.length, 3);
  h.controller.fail('request-2');
  assert.match(h.logs.join('\n'), /not-stable-yet/);
});
