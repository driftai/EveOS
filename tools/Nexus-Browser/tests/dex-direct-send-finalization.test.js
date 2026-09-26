'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDexServerScheduler } = require('../dex/server-scheduler');
const { createProviderControlRouting } = require('../dex/provider-control-routing');
const inbox = require('../dex/recovery-mailbox');
const eve = { targetClassId: 'online-origin', targetId: 42,
  providerId: 'future-provider', url: 'https://future.example/chat/1' };
function harness() {
  let snapshot = { rooms: [{ id: 'room-1', name: 'Eve + Astro',
    members: [{ id: 'eve', name: 'Eve', relayEnabled: true, binding: eve }],
    messages: [{ id: 'm1', senderKind: 'user', text: 'Original work' }],
    settings: { maxTurns: 1 },
    relay: { active: false, waitingFor: null, remaining: 0 } }] };
  const clone = value => JSON.parse(JSON.stringify(value));
  const store = { load: () => clone(snapshot), save: value => { snapshot = clone(value); return clone(snapshot); } };
  const sent = [], timers = [], ledger = new Map();
  const target = { id: 42, providerId: eve.providerId, url: eve.url };
  const scheduler = createDexServerScheduler({ stateStore: store,
    durability: {
      beforeDispatch: async ({ requestId }) => {
        if (ledger.has(requestId)) return { ok: false };
        ledger.set(requestId, { state: 'accepted' }); return { ok: true };
      }, query: id => ({ reliable: true, entry: ledger.get(id) || null }),
      markFailed: async () => {}
    },
    getOnlineTargets: () => [target], getSelectedOnlineTarget: () => target,
    getProviders: () => [{ id: eve.providerId, adapterContract: { operations: {
      send: true, observe: true, recover: true, captureLatest: true } } }],
    sendExtension: item => { sent.push(item); return true; },
    setTimer: fn => { timers.push(fn); return timers.length; }, clearTimer() {}
  });
  return { store, scheduler, sent, timers, get snapshot() { return snapshot; } };
}
test('direct SEND committed before response_final does not create an orphan pending-control lock', async () => {
  const h = harness();
  assert.equal(h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 }).ok, true);
  await h.timers.shift()();
  const current = h.scheduler.diagnostics().current.requestId;
  const snapshot = h.store.load(), room = snapshot.rooms[0];
  const command = { action: 'send', room: room.id, relay: true, text: 'Astro reported the final test failures.' };
  assert.equal(inbox.queueRoomSend(snapshot, { source: eve, requestId: 'ctl-report',
    command, makeId: () => 'msg-report' }).result.ok, true);
  h.store.save(snapshot);
  await h.scheduler.handleTransportEvent({ type: 'response_final', requestId: current,
    text: 'Sharing the result. [[DEX:CMD {"action":"send","room":"room-1","relay":true,"text":"Astro reported the final test failures."}]]' });
  const stopped = h.store.load().rooms[0];
  assert.equal(stopped.pendingProviderControlReceipt, undefined,
    'direct-admitted SEND carries its own receipt, never a duplicate pending origin');
  assert.equal(stopped.deferredRelays.length, 1);
  await h.scheduler.process();
  assert.equal(h.store.load().rooms[0].pendingTurn.sourceMessageId, 'msg-report');
  await h.scheduler.process();
  assert.equal(h.sent.filter(e => e.type === 'send_prompt').length, 2);
  assert.equal(h.store.load().rooms[0].recovery.requestId, h.scheduler.diagnostics().current.requestId);
});
test('private room_log bypasses active-turn origin waiting but returns only to its exact member', async () => {
  const h = harness();
  h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 });
  await h.timers.shift()();
  const caller = { role: 'provider-control-extension', sent: [] }, uiSockets = new Set();
  const router = createProviderControlRouting({ uiSockets,
    safeSend: (socket, payload) => { socket.sent.push(payload); return true; },
    validateSource: async () => true,
    getState: () => h.store.load(), saveState: value => h.store.save(value),
    broadcastState: () => {}, getScheduler: () => h.scheduler
  });
  assert.equal(await router.handle(caller, {
    type: 'provider_control_request', requestId: 'log-one', source: eve,
    command: { action: 'room_log', room: 'room-1', limit: 2 }
  }), true);
  const result = caller.sent.find(m => m.type === 'provider_control_result');
  assert.equal(result?.result?.ok, true);
  assert.equal(result.result.data.messages.at(-1).text, 'Original work');
  assert.equal(h.store.load().rooms[0].recovery.dispatched, true);
  assert.equal(router.pending.size, 0, 'a read-only lookup does not wait four minutes for the relay final');
});
