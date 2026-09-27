'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const { createProviderControlRouting } = require('../dex/provider-control-routing');
const { ACTIONS } = require('../public/dex-provider-control');
const source = { targetClassId: 'online-origin', providerId: 'chatgpt',
  targetId: 116814673, url: 'https://chatgpt.com/c/eve-room' };
function fixture() {
  return { rooms: [{ id: 'room-eve', name: 'Eve + Astro', members: [
    { id: 'eve', binding: { ...source } }], relay: { active: false } }] };
}
function harness(state = fixture()) {
  const dex = { clientKind: 'dex', role: 'ui', sent: [] }, callers = [];
  const server = createProviderControlRouting({
    uiSockets: new Set([dex]), getState: () => state,
    saveState() { throw Error('Rejected command must not save'); },
    safeSend(socket, payload) { socket.sent.push(payload); return true; },
    validateSource: async () => true,
    ensureDexClient: async () => { throw Error('Stale entry must never invoke Dex UI'); }
  });
  const send = async (sourceIdentity, command, id) => {
    const client = { role: 'provider-control-extension', sent: [] };
    callers.push(client);
    assert.equal(await server.handle(client, { type: 'provider_control_request',
      requestId: id, source: sourceIdentity, command }), true);
    const received = client.sent.find(e => e.type === 'provider_control_received');
    const result = client.sent.find(e => e.type === 'provider_control_result');
    return { received, result: result?.result };
  };
  return { dex, server, callers, send };
}
test('ALL room-related CMDs require one common server-side enter/admission check', async () => {
  for (const mismatch of [{ ...source, targetId: 116814674 },
    { ...source, url: 'https://chatgpt.com/c/different-conversation' }]) {
    const h = harness();
    let tested = 0;
    for (const action of ACTIONS) {
      if (['help', 'create_room'].includes(action)) continue;
      const r = await h.send(mismatch, { action, room: 'room-eve', text: 'Never dispatch' },
        'ctl-' + String(tested++));
      assert.ok(r.received, 'transport admission receipt: ' + action);
      assert.equal(r.result?.code, 'DEX_ROOM_STALE_BINDING', action);
    }
    assert.ok(tested > 25);
    assert.equal(h.dex.sent.length, 0);
  }
});
test('missing durable room state is rejected before any UI or delivery action', async () => {
  const h = harness(null);
  for (const action of ['targets', 'status', 'send', 'room_budget',
    'watch_done', 'reload_extension']) {
    const r = await h.send(source, { action, room: 'room-eve' }, 'missing-' + action);
    assert.equal(r.result.code, 'DEX_ENTRY_STATE_UNAVAILABLE');
  }
  assert.equal(h.dex.sent.length, 0);
});
test('even an exact room name cannot bypass the tab and conversation identity gate', async () => {
  const h = harness();
  const wrongProvider = { ...source, providerId: 'claude' };
  const r = await h.send(wrongProvider, { action: 'send', room: 'Eve + Astro',
    text: 'Untrusted' }, 'ctl-provider');
  assert.equal(r.result.code, 'DEX_ROOM_NOT_BOUND');
  assert.equal(h.dex.sent.length, 0);
});
