const test = require('node:test');
const assert = require('node:assert/strict');
const { createDexServerScheduler } = require('../dex/server-scheduler.js');
const inbox = require('../dex/recovery-mailbox.js');

function memoryStore(seed) {
  let current = JSON.parse(JSON.stringify(seed));
  return {
    load() { return JSON.parse(JSON.stringify(current)); },
    save(value) { current = JSON.parse(JSON.stringify(value)); return this.load(); },
    value() { return this.load(); }
  };
}

function baseSnapshot(health = null) {
  return {
    version: 1,
    activeRoomId: 'room-1',
    rooms: [{
      id: 'room-1',
      name: 'Core',
      userName: 'Drift',
      members: [{
        id: 'eve', name: 'Eve', relayEnabled: true,
        binding: { targetClassId: 'online-origin', providerId: 'future-provider', providerName: 'Future Provider', targetId: 9, url: 'https://future.example/chat/1' }
      }],
      messages: [{ id: 'm1', senderKind: 'user', senderId: 'user', senderName: 'Drift', text: 'test' }],
      settings: { autoRelay: true, maxTurns: 1, contextMessages: 8 },
      relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Idle' },
      createdAt: '2026-09-18T23:50:00.000Z',
      updatedAt: '2026-09-18T23:50:00.000Z'
    }]
  };
}

function harness({ selected = true, health = null, extensionAvailable = true, operations = null } = {}) {
  const store = memoryStore(baseSnapshot());
  const sent = [], broadcasts = [], incidents = [], timers = [];
  const tab = { id: 9, providerId: 'future-provider', providerName: 'Future Provider', url: 'https://future.example/chat/1', health };
  const provider = {
    id: 'future-provider',
    adapterContract: {
      version: 1,
      operations: operations || {
        probe: true, ensureReady: true, send: true, observe: true,
        captureLatest: true, recover: true, health: true
      }
    }
  };
  const ledger = new Map();
  const durability = {
    async beforeDispatch(msg, meta) {
      if (ledger.has(msg.requestId)) return { ok: false, duplicate: true };
      ledger.set(msg.requestId, { requestId: msg.requestId, state: 'dispatching', ...meta });
      return { ok: true };
    },
    query(id) { return { reliable: true, entry: ledger.get(id) || null }; },
    recordIncident(input) { incidents.push(input); },
    diagnostics() { return {}; }
  };
  const scheduler = createDexServerScheduler({
    stateStore: store,
    durability,
    getOnlineTargets: () => [tab],
    getProviders: () => [provider],
    getSelectedOnlineTarget: () => selected ? tab : null,
    getLocalTargets: async () => [],
    isExtensionAvailable: () => extensionAvailable,
    sendExtension(payload) { sent.push(payload); return extensionAvailable; },
    sendLocalPrompt: async () => {},
    captureLocalLatest: async () => ({ text: '' }),
    broadcastState(snapshot) { broadcasts.push(snapshot); },
    recordIncident(input) { incidents.push(input); },
    setTimer(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimer() {}
  });
  return { scheduler, store, sent, broadcasts, incidents, timers, ledger, tab };
}

async function runNextTimer(h) {
  const item = h.timers.shift();
  assert.ok(item, 'expected scheduled work');
  return await item.fn();
}

test('localhost owns a normal online turn from queue through completion', async () => {
  const h = harness();
  assert.equal(h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 }).ok, true);
  await runNextTimer(h);

  assert.equal(h.scheduler.diagnostics().owner, 'localhost');
  assert.equal(h.sent.filter((item) => item.type === 'send_prompt').length, 1);
  assert.equal(h.sent.some((item) => item.type === 'select_target'), false);
  let room = h.store.value().rooms[0];
  assert.equal(room.relay.remaining, 0);
  assert.equal(room.recovery.dispatched, true);
  assert.match(room.recovery.expectedPrompt, /test/);
  assert.match(room.recovery.expectedPrompt, /FINAL-TURN BUDGET NUDGE/);

  const requestId = h.scheduler.diagnostics().current.requestId;
  await h.scheduler.handleTransportEvent({ type: 'prompt_accepted', requestId, tabId: 9, providerId: 'future-provider' });
  room = h.store.value().rooms[0];
  assert.equal(room.recovery.dispatched, true);

  await h.scheduler.handleTransportEvent({ type: 'response_final', requestId, text: 'Done.' });
  room = h.store.value().rooms[0];
  assert.equal(room.messages.at(-1).senderName, 'Eve');
  assert.equal(room.messages.at(-1).text, 'Done.');
  assert.equal(room.relay.active, false);
  assert.equal(room.relay.lastStopReason, 'Relay budget complete');
  assert.equal(room.recovery, undefined);
  assert.equal(h.sent.filter((item) => item.type === 'send_prompt').length, 1);
});

test('localhost selects the exact bound online target before dispatch', async () => {
  const h = harness({ selected: false });
  h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 });
  await runNextTimer(h);
  assert.equal(h.sent[0].type, 'select_target');
  assert.equal(h.sent[0].tabId, 9);
  assert.equal(h.sent.some((item) => item.type === 'send_prompt'), false);

  const requestId = h.scheduler.diagnostics().current.requestId;
  await h.scheduler.handleTransportEvent({
    type: 'target_selected',
    requestId,
    target: h.tab
  });
  assert.equal(h.sent.filter((item) => item.type === 'send_prompt').length, 1);
});

test('provider health blocks before any provider dispatch', async () => {
  const h = harness({ health: { state: 'rate_limited', blocking: true, action: 'wait', summary: 'quota reached' } });
  h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 });
  await runNextTimer(h);
  assert.equal(h.sent.some((item) => item.type === 'send_prompt'), false);
  const room = h.store.value().rooms[0];
  assert.equal(room.relay.active, false);
  assert.match(room.messages.at(-1).text, /provider health blocked/i);
});

test('extension outage parks the durable turn instead of browser-side retrying it', async () => {
  const h = harness({ extensionAvailable: false });
  h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 });
  await runNextTimer(h);
  const room = h.store.value().rooms[0];
  assert.equal(h.scheduler.diagnostics().current, null);
  assert.ok(room.recovery);
  assert.equal(room.recovery.dispatched, false);
  assert.equal(room.relay.active, false);
  assert.match(room.relay.lastStopReason, /reconciling durable dispatch ledger/);
  assert.equal(h.sent.length, 0);
});


test('partial future provider fails closed before transport when send is undeclared', async () => {
  const h = harness({
    operations: {
      probe: true, ensureReady: true, send: false, observe: true,
      captureLatest: true, recover: true, health: true
    }
  });
  h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 });
  await runNextTimer(h);
  assert.equal(h.sent.some((item) => item.type === 'send_prompt'), false);
  const room = h.store.value().rooms[0];
  assert.equal(room.relay.active, false);
  assert.match(room.messages.at(-1).text, /PROVIDER_OPERATION_UNSUPPORTED/);
});


test('recover-class failure after dispatch preserves journal for capture recovery', async () => {
  const h = harness();
  h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 });
  await runNextTimer(h);
  const requestId = h.scheduler.diagnostics().current.requestId;
  await h.scheduler.handleTransportEvent({
    type: 'prompt_accepted',
    requestId,
    tabId: 9,
    providerId: 'future-provider'
  });
  await h.scheduler.handleTransportEvent({
    type: 'error',
    requestId,
    code: 'COMMAND_FAILED',
    message: 'transport outcome uncertain'
  });

  const room = h.store.value().rooms[0];
  assert.equal(h.scheduler.diagnostics().current, null);
  assert.ok(room.recovery);
  assert.equal(room.recovery.dispatched, true);
  assert.equal(room.relay.active, false);
  assert.match(room.relay.lastStopReason, /recovering interrupted turn/);
  assert.equal(room.messages.filter((item) => item.senderKind === 'system').length, 0);
});


test('stop relay records an already-dispatched reply but schedules no next turn', async () => {
  const h = harness();
  h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 2 });
  await runNextTimer(h);
  const requestId = h.scheduler.diagnostics().current.requestId;
  await h.scheduler.handleTransportEvent({
    type: 'prompt_accepted',
    requestId,
    tabId: 9,
    providerId: 'future-provider'
  });

  const stopped = h.scheduler.stopRelay({ roomId: 'room-1', reason: 'Stopped by user' });
  assert.equal(stopped.ok, true);
  assert.equal(stopped.inFlight, true);
  let room = h.store.value().rooms[0];
  assert.equal(room.relay.active, false);
  assert.ok(room.recovery);
  assert.equal(room.recovery.stopRequested, true);
  assert.equal(room.recovery.stopReason, 'Stopped by user');
  assert.equal(room.recovery.relayActive, false);
  assert.ok(h.scheduler.diagnostics().current);

  await h.scheduler.handleTransportEvent({ type: 'response_final', requestId, text: 'Final in-flight reply.' });
  room = h.store.value().rooms[0];
  assert.equal(room.messages.at(-1).text, 'Final in-flight reply.');
  assert.equal(room.relay.active, false);
  assert.equal(room.relay.lastStopReason, 'Stopped by user');
  assert.equal(room.pendingTurn, undefined);
  assert.equal(room.recovery, undefined);
  assert.equal(h.sent.filter((item) => item.type === 'send_prompt').length, 1);
});


test('transport failure after durable dispatch boundary never retries before provider acknowledgement', async () => {
  const h = harness();
  h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 });
  await runNextTimer(h);
  const requestId = h.scheduler.diagnostics().current.requestId;
  assert.equal(h.sent.filter((item) => item.type === 'send_prompt').length, 1);
  assert.equal(h.store.value().rooms[0].recovery.dispatched, true);

  await h.scheduler.handleTransportEvent({
    type: 'error',
    requestId,
    code: 'EXTENSION_OFFLINE',
    message: 'socket disappeared after dispatch boundary'
  });

  const room = h.store.value().rooms[0];
  assert.equal(h.scheduler.diagnostics().current, null);
  assert.ok(room.recovery);
  assert.equal(room.recovery.dispatched, true);
  assert.equal(room.relay.active, false);
  assert.match(room.relay.lastStopReason, /recovering interrupted turn/);
  assert.equal(h.sent.filter((item) => item.type === 'send_prompt').length, 1);
});

test('completed member journal clears before next member receives a fresh journal', async () => {
  const h = harness();
  const roomSeed = h.store.value().rooms[0];
  roomSeed.members.push({
    id: 'stress',
    name: 'Eve Stress',
    relayEnabled: true,
    binding: {
      targetClassId: 'online-origin',
      providerId: 'future-provider',
      providerName: 'Future Provider',
      targetId: 9,
      url: 'https://future.example/chat/1'
    }
  });
  h.store.save({ ...h.store.value(), rooms: [roomSeed] });

  assert.equal(h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 2 }).ok, true);
  await runNextTimer(h);

  const first = h.scheduler.diagnostics().current;
  assert.equal(first.memberId, 'eve');
  const firstRequestId = first.requestId;
  await h.scheduler.handleTransportEvent({
    type: 'prompt_accepted',
    requestId: firstRequestId,
    tabId: 9,
    providerId: 'future-provider'
  });
  await h.scheduler.handleTransportEvent({
    type: 'response_final',
    requestId: firstRequestId,
    text: 'Wren final.'
  });

  let room = h.store.value().rooms[0];
  assert.equal(room.recovery, undefined);
  assert.equal(room.pendingTurn.memberId, 'stress');
  assert.equal(room.relay.waitingFor, 'stress');

  await h.scheduler.process();
  room = h.store.value().rooms[0];
  assert.ok(room.recovery);
  assert.equal(room.recovery.memberId, 'stress');
  assert.notEqual(room.recovery.requestId, firstRequestId);
  assert.equal(room.recovery.interruptedAt, null);
  assert.equal(room.relay.waitingFor, 'stress');
});



test('provider-control reply records durable correlation to the exact originating relay sender', async () => {
  const h = harness();
  const value = h.store.value();
  const room = value.rooms[0];
  room.messages[0] = { id: 'm1', senderKind: 'agent', senderId: 'eve', senderName: 'Eve', text: 'Do one admin action.' };
  room.members.push({
    id: 'stress',
    name: 'Eve Stress',
    relayEnabled: true,
    binding: {
      targetClassId: 'online-origin',
      providerId: 'future-provider',
      providerName: 'Future Provider',
      targetId: 9,
      url: 'https://future.example/chat/1'
    }
  });
  h.store.save(value);

  assert.equal(h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 }).ok, true);
  await runNextTimer(h);
  const current = h.scheduler.diagnostics().current;
  assert.equal(current.memberId, 'stress');

  await h.scheduler.handleTransportEvent({
    type: 'response_final',
    requestId: current.requestId,
    text: 'Executing. [[DEX:CMD {"action":"status","room":"room-1"}]]'
  });

  const saved = h.store.value().rooms[0];
  assert.equal(saved.messages.at(-1).text, 'Executing.');
  assert.equal(saved.relay.active, false);
  assert.match(saved.relay.lastStopReason, /requested Dex provider control/);
  assert.equal(saved.pendingProviderControlReceipt.action, 'status');
  assert.equal(saved.pendingProviderControlReceipt.executorMemberId, 'stress');
  assert.equal(saved.pendingProviderControlReceipt.originMessageId, 'm1');
  assert.equal(saved.pendingProviderControlReceipt.originSenderId, 'eve');
  assert.equal(saved.pendingProviderControlReceipt.originTarget.targetId, 9);
});

test('final scheduled reply can extend its physical budget and request extra context for next hop', async () => {
  const h = harness();
  assert.equal(h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 1 }).ok, true);
  await runNextTimer(h);
  const original = h.sent.filter(m => m.type === 'send_prompt');
  assert.equal(original.length, 1);
  assert.match(original[0].text, /FINAL-TURN BUDGET NUDGE/);
  assert.match(original[0].text, /choose N/);
  const first = h.scheduler.diagnostics().current.requestId;
  await h.scheduler.handleTransportEvent({
    type: 'prompt_accepted', requestId: first, tabId: 9, providerId: 'future-provider'
  });
  await h.scheduler.handleTransportEvent({ type: 'response_final', requestId: first,
    text: 'Work continues. [[DEX:CONTEXT:5]] [[DEX:BUDGET:+3]]' });
  let room = h.store.value().rooms[0];
  assert.equal(room.relay.active, true);
  assert.equal(room.relay.turnBudgetTotal, 4);
  assert.equal(room.relay.scheduledTurns, 2);
  assert.equal(room.relay.remaining, 2);
  assert.equal(room.messages.at(-1).text, 'Work continues.');
  assert.equal(room.messages.at(-1).contextOverride, 5);
  assert.equal(room.pendingTurn.memberId, 'eve');
  await h.scheduler.process();
  const prompts = h.sent.filter(m => m.type === 'send_prompt');
  assert.equal(prompts.length, 2, 'one fresh next prompt; no replay of prior dispatch');
  assert.doesNotMatch(prompts[1].text, /FINAL-TURN BUDGET NUDGE/,
    'an opted-in budget extension must remove the final-turn warning until the next final turn');
  assert.match(prompts[1].text, /4 allocated.*2 scheduled.*2 unscheduled remaining/);
  assert.match(prompts[1].text, /Context selection: 1 earlier message/);
  assert.ok(prompts[1].text.includes('Current message:') && prompts[1].text.includes('Work continues.'));
  assert.equal(h.scheduler.diagnostics().current.memberId, 'eve');
});

test('in-flight reports queue while Eve works; NOTE cannot swallow them and FIFO resumes automatically', async () => {
  const h = harness();
  assert.equal(h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 2 }).ok, true);
  await runNextTimer(h);
  const first = h.scheduler.diagnostics().current.requestId;
  const snapshot = h.store.value(), room = snapshot.rooms[0], source = room.members[0].binding;
  for (let n = 1; n <= 2; n++) {
    const admitted = inbox.queueRoomSend(snapshot, { source, requestId: 'incoming-' + n,
      command: { action: 'send', room: room.id, relay: true, text: 'NEW REPORT ' + n },
      makeId: () => 'msg-incoming-' + n });
    assert.equal(admitted.result.data.deliveryState, 'queued');
  }
  h.store.save(snapshot);
  h.scheduler.onStateChanged();
  assert.equal(h.sent.filter(m => m.type === 'send_prompt').length, 1);
  await h.scheduler.handleTransportEvent({ type: 'response_final', requestId: first,
    text: 'Waiting for the result. [[DEX:NOTE]]' });
  assert.equal(h.store.value().rooms[0].relay.active, false);
  assert.equal(h.store.value().rooms[0].deferredRelays.length, 2);
  await h.scheduler.process();
  assert.equal(h.store.value().rooms[0].pendingTurn.sourceMessageId, 'msg-incoming-2');
  assert.deepEqual(h.store.value().rooms[0].pendingTurn.inboxMessageIds, ['msg-incoming-1']);
  await h.scheduler.process();
  const prompts = h.sent.filter(m => m.type === 'send_prompt');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].text, /NEW INCOMING ROOM UPDATES \(FIFO/);
  assert.match(prompts[1].text, /Queued message IDs: msg-incoming-1/);
  assert.ok(prompts[1].text.indexOf('NEW REPORT 1') < prompts[1].text.indexOf('NEW REPORT 2'));
  assert.equal(h.store.value().rooms[0].deferredRelays.length, 0);
  assert.equal(h.store.value().rooms[0].deferredSendReceipts.every(e => e.phase === 'dispatched'), true);
});
test('ordinary continuing turn stages newer reports in next prompt, never mid-gesture or twice', async () => {
  const h = harness();
  h.scheduler.startRelay({ roomId: 'room-1', sourceMessageId: 'm1', budget: 2 });
  await runNextTimer(h);
  const requestId = h.scheduler.diagnostics().current.requestId;
  const snapshot = h.store.value(), room = snapshot.rooms[0], source = room.members[0].binding;
  for (let n = 1; n <= 2; n++) inbox.queueRoomSend(snapshot, {
    source, requestId: 'r-' + n,
    command: { action: 'send', room: room.id, relay: true, text: 'Pending update ' + n },
    makeId: () => 'queue-' + n
  });
  h.store.save(snapshot);
  await h.scheduler.handleTransportEvent({ type: 'response_final', requestId, text: 'Continue task.' });
  const queued = h.store.value().rooms[0];
  assert.equal(queued.relay.active, true);
  assert.deepEqual(queued.pendingTurn.inboxMessageIds, ['queue-1', 'queue-2']);
  assert.equal(queued.deferredRelays.length, 0);
  await h.scheduler.process();
  const prompts = h.sent.filter(m => m.type === 'send_prompt');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].text, /Queued message IDs: queue-1, queue-2/);
  assert.match(prompts[1].text, /Current message:\nContinue task\./);
  assert.equal(h.store.value().rooms[0].recovery.inboxMessageIds.length, 2,
    'the exact queued update IDs survive into the durable recovery journal');
});
