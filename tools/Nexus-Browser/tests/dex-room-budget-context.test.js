'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const protocol = require('../public/dex-protocol.js');
const stateApi = require('../dex/server-scheduler-state.js');
const tools = require('../dex/room-tools.js');
const merge = require('../dex/server-state-merge.js');
const source = { targetClassId: 'online-origin', providerId: 'chatgpt',
  targetId: 42, url: 'https://chatgpt.com/c/eve' };
function room() {
  return { id: 'room-one', name: 'Eve and Astro',
    members: [
      { id: 'eve', name: 'Eve', binding: source },
      { id: 'astro', name: 'Astro', binding: { targetClassId: 'local-origin',
        providerId: 'local-antigravity-existing', targetId: 'local-1' } }
    ], settings: { maxTurns: 8, contextMessages: 8 },
    relay: { active: true, remaining: 0, turnBudgetTotal: 8, scheduledTurns: 8,
      waitingFor: 'eve', lastStopReason: 'Running' },
    messages: [
      { id: 'm1', senderKind: 'agent', senderId: 'eve', senderName: 'Eve', text: 'old eve' },
      { id: 'm2', senderKind: 'user', senderId: 'user', senderName: 'Drift', text: 'old human' },
      { id: 'm3', senderKind: 'agent', senderId: 'eve', senderName: 'Eve', text: 'latest eve' },
      { id: 'm4', senderKind: 'agent', senderId: 'astro', senderName: 'Astro', text: 'latest astro' },
      { id: 'm5', senderKind: 'agent', senderId: 'astro', senderName: 'Astro', text: 'new source' }
    ] };
}
test('normal context includes one prior message per agent, not every room turn or user history', () => {
  const r = room(), sourceMessage = r.messages[4];
  assert.deepEqual(protocol.selectRelayHistory(r, sourceMessage).map(m => m.id), ['m3', 'm4']);
  const prompt = protocol.buildRelayPrompt({ room: r, recipient: r.members[0], sourceMessage, requestId: 'dex-turn-test' });
  assert.match(prompt, /8 allocated.*8 scheduled.*0 unscheduled remaining/);
  assert.match(prompt, /latest eve/);
  assert.match(prompt, /latest astro/);
  assert.doesNotMatch(prompt, /old human/);
  assert.doesNotMatch(prompt, /old eve/);
  assert.ok(prompt.includes('Current message:') && prompt.includes('new source'));
});
test('per-message context flag expands one outgoing hop and does not mutate room defaults', () => {
  const r = room(), parsed = protocol.parseAgentReply('handoff [[DEX:CONTEXT:4]] [[DEX:RETURN:dex-turn-7f22a583-748f-46da-a5fa-3b5e07954941]]');
  assert.equal(parsed.contextOverride, 4);
  const msg = stateApi.addMessage(r, { id: 'm6', senderKind: 'agent', senderId: 'eve',
    senderName: 'Eve', text: parsed.text, contextOverride: parsed.contextOverride });
  assert.deepEqual(protocol.selectRelayHistory(r, msg).map(m => m.id), ['m2', 'm3', 'm4', 'm5']);
  assert.equal(r.settings.contextMessages, 8);
  const followUp = stateApi.addMessage(r, { id: 'm7', senderKind: 'agent', senderId: 'astro', text: 'later' });
  assert.equal(followUp.contextOverride, undefined);
  assert.deepEqual(protocol.selectRelayHistory(r, followUp).map(m => m.id), ['m5', 'm6']);
});
test('a deferred older source cannot receive newer private room messages as backlog', () => {
  const r = room();
  assert.deepEqual(protocol.selectRelayHistory(r, r.messages[2]).map(m => m.id), ['m1']);
});
test('trailing budget and context flags enforce exact finite limits and do not masquerade as content', () => {
  const valid = protocol.parseAgentReply('Continuing [[DEX:BUDGET:+4]] [[DEX:CONTEXT:6]]');
  assert.equal(valid.text, 'Continuing');
  assert.equal(valid.budgetIncrease, 4);
  assert.equal(valid.contextOverride, 6);
  for (const token of ['[[DEX:BUDGET:+501]]', '[[DEX:CONTEXT:99]]', '[[DEX:CONTEXT:4]] [[DEX:CONTEXT:5]]'])
    assert.equal(protocol.parseAgentReply('body ' + token).malformedCommand, true);
});
test('the last already-scheduled reply may extend the room before budget-stop disposition', () => {
  const r = room();
  const parsed = protocol.parseAgentReply('Still working [[DEX:BUDGET:+4]]');
  assert.equal(stateApi.extendBudget(r, parsed), 4);
  assert.equal(r.relay.turnBudgetTotal, 12);
  assert.equal(r.relay.remaining, 4);
  assert.equal(protocol.relayDisposition(parsed, 'Eve', false, r.relay).action, 'continue');
  assert.equal(stateApi.extendBudget(r, { ...parsed, done: true }), 0);
  r.relay.turnBudgetTotal = 499;
  assert.equal(stateApi.extendBudget(r, { budgetIncrease: 10 }), 1);
  assert.equal(r.relay.turnBudgetTotal, 500);
});
test('room_budget and room_log are exact-member scoped, read-only and cursor paginated', () => {
  const r = room(); const snapshot = { rooms: [r], savedAt: '2026-09-26T00:00:00Z' };
  const status = tools.execute(snapshot, { source, command: { action: 'room_budget' } });
  assert.equal(status.changed, false);
  assert.equal(status.result.data.scheduledTurns, 8);
  assert.equal(status.result.data.remainingTurns, 0);
  assert.equal(status.result.data.inFlight, true);
  const first = tools.execute(snapshot, { source, command: { action: 'room_log', limit: 2 } });
  assert.deepEqual(first.result.data.messages.map(m => m.id), ['m4', 'm5']);
  assert.equal(first.result.data.hasMore, true);
  const second = tools.execute(snapshot, { source, command: { action: 'room_log',
    limit: 2, before: first.result.data.nextBefore } });
  assert.deepEqual(second.result.data.messages.map(m => m.id), ['m2', 'm3']);
  assert.equal(r.messages.length, 5);
  const foreign = tools.execute(snapshot, { source: { ...source, targetId: 72, url: 'https://chatgpt.com/c/foreign' }, command: { action: 'room_log' } });
  assert.equal(foreign.result.code, 'DEX_ROOM_NOT_BOUND');
  const wrongCursor = tools.execute(snapshot, { source, command: { action: 'room_log', before: 'not-a-message' } });
  assert.equal(wrongCursor.result.code, 'DEX_ROOM_LOG_BAD_CURSOR');
});
test('set_room_budget never mutates a running room, and persists exact idle configuration', () => {
  const r = room(), snapshot = { rooms: [r] };
  const busy = tools.execute(snapshot, { source, command: { action: 'set_room_budget', turns: 12, resume: true } });
  assert.equal(busy.result.code, 'DEX_BUDGET_BUSY');
  assert.equal(r.settings.maxTurns, 8);
  r.relay = { active: false, waitingFor: null, remaining: 0, scheduledTurns: 8,
    turnBudgetTotal: 8, lastStopReason: 'Relay budget complete' };
  const configured = tools.execute(snapshot, { source, command: { action: 'set_room_budget', turns: 12, resume: true } });
  assert.equal(configured.result.ok, true);
  assert.equal(configured.resume, true);
  assert.equal(r.settings.maxTurns, 12);
  assert.equal(r.settings.budgetRevision, 1);
  assert.equal(tools.execute(snapshot, { source, command: { action: 'set_room_budget', turns: 501 } }).result.code, 'DEX_BUDGET_INVALID');
});
test('stale browser room sync cannot overwrite a server-updated budget', () => {
  const server = room(), client = structuredClone(server);
  server.settings = { ...server.settings, maxTurns: 16, budgetRevision: 5 };
  client.settings = { ...client.settings, maxTurns: 8, budgetRevision: 4 };
  server.relay.active = false; server.relay.waitingFor = null;
  client.relay.active = false; client.relay.waitingFor = null;
  const merged = merge.mergeIdleRoom(server, client);
  assert.equal(merged.settings.maxTurns, 16);
  assert.equal(merged.settings.budgetRevision, 5);
});
test('read-only room_log does not enqueue a relay or send a room message', async () => {
  let state = { rooms: [room()] }, sent = [], resumes = 0;
  const routed = await tools.route({ source, command: { action: 'room_log', limit: 1 }, requestId: 'read-one', ws: {}, origin: null }, {
    getState: () => structuredClone(state), saveState: next => { state = structuredClone(next); return state; },
    broadcastState: () => { throw Error('read-only query must not mutate state'); },
    getScheduler: () => ({ continueRelay() { resumes++; return { ok: true }; } }),
    now: () => 42,
    commitOriginReceipt: () => null,
    sendResult: (_target, result) => sent.push(result)
  });
  assert.equal(routed, true);
  assert.equal(sent[0].action, 'room_log');
  assert.equal(resumes, 0);
  assert.equal(state.rooms[0].messages.length, 5);
});

test('private history data never leaks into the durable room control receipt', async () => {
  const r = room(), sourceState = { rooms: [r] };
  const receipts = [], delivered = [];
  const ok = await tools.route({
    source, command: { action: 'room_log', limit: 2 },
    requestId: 'private-room-log', ws: {}, origin: { roomId: r.id }
  }, {
    getState: () => structuredClone(sourceState),
    saveState: x => x, broadcastState() {}, getScheduler: () => null,
    now: () => 42,
    commitOriginReceipt: (_origin, receiptResult) => {
      receipts.push(receiptResult); return { id: 'receipt-meta-only' };
    },
    sendResult: (_recipient, fullResult) => delivered.push(fullResult)
  });
  assert.equal(ok, true);
  assert.equal(delivered[0].data.messages.length, 2);
  assert.equal(receipts[0].data.messages, undefined);
  assert.equal(JSON.stringify(receipts[0]).includes('new source'), false);
});
