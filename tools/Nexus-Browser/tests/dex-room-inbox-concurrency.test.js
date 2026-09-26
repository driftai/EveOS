'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createProviderControlRouting } = require('../dex/provider-control-routing');
const socket = role => ({ role, sent: [] });
const resultFor = ws => ws.sent.filter(entry => entry.type === 'provider_control_result').at(-1);

test('simultaneous authenticated sends serialize durable admission without dropping or duplicating reports', async () => {
  const exact = { targetClassId: 'local-origin', providerId: 'local-antigravity-existing',
    targetId: 'local:antigravity-existing:9' };
  let stored = { rooms: [{ id: 'room-1', name: 'Eve + Astro',
    members: [{ id: 'astro', name: 'Astro', binding: exact }, { id: 'eve', name: 'Eve',
      binding: { targetClassId: 'online-origin', providerId: 'chatgpt',
        targetId: 42, url: 'https://chatgpt.com/c/eve' } }],
    messages: [], relay: { active: false, waitingFor: null, remaining: 0 }
  }] };
  let writes = 0;
  const routing = createProviderControlRouting({
    uiSockets: new Set(), safeSend: (ws, message) => { ws.sent.push(message); return true; },
    validateSource: async () => true,
    getState: () => structuredClone(stored),
    saveState: next => { writes++; stored = structuredClone(next); return stored; },
    broadcastState() {}, getScheduler: () => ({ onStateChanged() {} })
  });
  const request = (id, body) => ({ type: 'provider_control_request', requestId: id, source: exact,
    command: { action: 'send', room: 'room-1', relay: true, text: body } });
  const a = socket('provider-control-extension'), b = socket('provider-control-extension');
  const c = socket('provider-control-extension');
  await Promise.all([
    routing.handle(a, request('send-1', 'Report one')),
    routing.handle(b, request('send-2', 'Report two')),
    routing.handle(c, request('send-1', 'Report one'))
  ]);
  assert.equal(resultFor(a).result.ok, true);
  assert.equal(resultFor(b).result.ok, true);
  assert.equal(resultFor(c).result.data.messageId, resultFor(a).result.data.messageId);
  assert.equal(writes, 2);
  assert.deepEqual(stored.rooms[0].deferredRelays.map(x => x.requestId), ['send-1', 'send-2']);
  assert.deepEqual(stored.rooms[0].messages.map(x => x.text), ['Report one', 'Report two']);
});
