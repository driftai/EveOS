'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createDexServerScheduler } = require('../dex/server-scheduler');
const stateApi = require('../dex/server-scheduler-state');
const members = require('../public/dex-members');
const { createAppTargetServerController } = require('../app-targets/server-controller');

function memoryStore(seed) {
  let value = JSON.parse(JSON.stringify(seed));
  return {
    load: () => JSON.parse(JSON.stringify(value)),
    save(next) { value = JSON.parse(JSON.stringify(next)); return this.load(); },
    value: () => JSON.parse(JSON.stringify(value))
  };
}

const appTarget = {
  id: 'app-chatgpt-windows',
  title: 'ChatGPT',
  providerId: 'chatgpt-desktop',
  providerName: 'ChatGPT App',
  targetClassId: 'app-origin',
  targetTypeId: 'desktop-app',
  targetTypeName: 'Desktop App',
  transport: 'windows-uia-winapp',
  sessionOrigin: 'existing-app',
  pid: 118148,
  windowHandle: 4473474,
  concreteTargetIdentity: {
    kind: 'windows-app-window',
    app: 'ChatGPT',
    processId: 118148,
    windowHandle: 4473474,
    conversationTitle: 'Test response'
  },
  capabilities: { chat: true, captureLatest: true }
};

function appBinding(target = appTarget) {
  return members.bindingFromSource('app-origin', target);
}

function snapshot() {
  return {
    version: 1,
    activeRoomId: 'room-app',
    rooms: [{
      id: 'room-app',
      name: 'Native Eve',
      userName: 'Drift',
      members: [{ id: 'eve-app', name: 'Eve App', relayEnabled: true, binding: appBinding() }],
      messages: [{ id: 'm1', senderKind: 'user', senderId: 'user', senderName: 'Drift', text: 'hello native Eve' }],
      settings: { autoRelay: true, maxTurns: 1, contextMessages: 8 },
      relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Idle' },
      createdAt: '2026-10-01T19:00:00.000Z',
      updatedAt: '2026-10-01T19:00:00.000Z'
    }]
  };
}

function harness(target = appTarget, { busyOnce = false } = {}) {
  const store = memoryStore(snapshot());
  const timers = [], appSends = [], extensionSends = [], ledger = new Map();
  let busyRemaining = busyOnce ? 1 : 0;
  const durability = {
    async beforeDispatch(msg, meta) {
      if (ledger.has(msg.requestId)) return { ok: false };
      ledger.set(msg.requestId, { ...meta, state: 'dispatching' });
      return { ok: true };
    },
    async observe() {},
    async markFailed() {},
    query(id) { return { reliable: true, entry: ledger.get(id) || null }; },
    recordIncident() {}
  };
  const scheduler = createDexServerScheduler({
    stateStore: store,
    durability,
    getOnlineTargets: () => [],
    getProviders: () => [],
    getSelectedOnlineTarget: () => null,
    getLocalTargets: async () => [],
    getAppTargets: async () => target ? [target] : [],
    isExtensionAvailable: () => false,
    sendExtension(payload) { extensionSends.push(payload); return false; },
    sendLocalPrompt: async () => {},
    captureLocalLatest: async () => ({ text: '' }),
    captureAppLatest: async () => ({ text: 'Recovered native reply' }),
    async sendAppPrompt({ requestId, text, emit, beforeSend }) {
      if (busyRemaining > 0) {
        busyRemaining -= 1;
        const error = new Error('native target busy');
        error.code = 'APP_TARGET_BUSY';
        throw error;
      }
      await beforeSend?.(target);
      appSends.push({ requestId, text });
      await emit({ type: 'prompt_accepted', requestId, providerId: target.providerId,
        providerName: target.providerName, targetClassId: 'app-origin', targetId: target.id });
      await emit({ type: 'response_final', requestId, text: 'Native Dex reply',
        providerId: target.providerId, providerName: target.providerName,
        targetClassId: 'app-origin', targetId: target.id });
      return { text: 'Native Dex reply' };
    },
    setTimer(fn, delay) { timers.push({ fn, delay }); return timers.length; },
    clearTimer() {}
  });
  return { scheduler, store, timers, appSends, extensionSends, ledger };
}

async function runNext(h) {
  const timer = h.timers.shift();
  assert.ok(timer, 'expected scheduled Dex work');
  await timer.fn();
}

test('App-Origin binding pins the exact desktop process/window identity', () => {
  const binding = appBinding();
  assert.equal(members.exactBinding(binding, { ...appTarget, targetId: appTarget.id }), true);
  assert.equal(members.exactBinding(binding, {
    ...appTarget,
    targetId: appTarget.id,
    concreteTargetIdentity: { ...appTarget.concreteTargetIdentity, processId: 999999 }
  }), false);
  assert.equal(stateApi.resolveApp({ binding }, [appTarget])?.id, appTarget.id);
  assert.equal(stateApi.resolveApp({ binding }, [{
    ...appTarget,
    concreteTargetIdentity: { ...appTarget.concreteTargetIdentity, windowHandle: 123 }
  }]), null);
  assert.equal(stateApi.resolveApp({ binding }, [{
    ...appTarget,
    concreteTargetIdentity: { ...appTarget.concreteTargetIdentity, conversationTitle: 'Different chat' }
  }]), null);
  assert.match(members.memberFingerprint(binding), /^app:chatgpt-desktop:/);
  const ambiguous = appBinding({
    ...appTarget,
    concreteTargetIdentity: {
      ...appTarget.concreteTargetIdentity,
      conversationTitle: undefined
    }
  });
  assert.equal(stateApi.resolveApp({ binding: ambiguous }, [appTarget]), null,
    'ChatGPT Dex binding must fail closed without a native conversation identity');
});

test('localhost Dex scheduler dispatches App-Origin directly without browser extension', async () => {
  const h = harness();
  assert.equal(h.scheduler.startRelay({ roomId: 'room-app', sourceMessageId: 'm1', budget: 1 }).ok, true);
  await runNext(h);
  assert.equal(h.appSends.length, 1);
  assert.match(h.appSends[0].text, /hello native Eve/);
  assert.equal(h.extensionSends.length, 0);
  const room = h.store.value().rooms[0];
  assert.equal(room.messages.at(-1).senderName, 'Eve App');
  assert.equal(room.messages.at(-1).text, 'Native Dex reply');
  assert.equal(room.relay.active, false);
  assert.equal(room.recovery, undefined);
});

test('Dex retries App-Origin busy before claiming the durable dispatch boundary', async () => {
  const h = harness(appTarget, { busyOnce: true });
  h.scheduler.startRelay({ roomId: 'room-app', sourceMessageId: 'm1', budget: 1 });
  await runNext(h);

  assert.equal(h.appSends.length, 0);
  assert.equal(h.ledger.size, 0, 'busy native app must not be marked dispatching');
  const afterBusy = h.store.value().rooms[0];
  assert.ok(afterBusy.pendingTurn, 'busy native target should queue a bounded retry');
  assert.match(afterBusy.relay.lastStopReason, /APP_TARGET_BUSY/);

  assert.ok(h.timers.some((timer) => timer.delay >= 300),
    'busy native target should schedule a delayed retry rather than spin');
});

test('App-Origin Dex fails closed after native app process identity changes', async () => {
  const replacement = {
    ...appTarget,
    concreteTargetIdentity: { ...appTarget.concreteTargetIdentity, processId: 222222, windowHandle: 333333 }
  };
  const h = harness(replacement);
  h.scheduler.startRelay({ roomId: 'room-app', sourceMessageId: 'm1', budget: 1 });
  await runNext(h);
  assert.equal(h.appSends.length, 0);
  const room = h.store.value().rooms[0];
  assert.equal(room.relay.active, false);
  assert.match(room.messages.at(-1).text, /APP_TARGET_NOT_FOUND/);
});

test('Dex viewer may discover apps but cannot bypass localhost scheduler with direct app send', async () => {
  const dex = { clientKind: 'dex', appTargetId: null };
  const sent = [];
  const appTargets = {
    listAppTargets: async () => [appTarget],
    publicAppTargetTypes: () => [{ id: 'desktop-app', name: 'Desktop App' }],
    discoveryDiagnostics: () => ({ 'chatgpt-desktop': { available: true } }),
    getAppTargetStatus: () => ({ phase: 'idle' }),
    getAppTarget: async () => appTarget,
    stopAppTargets() {}
  };
  const controller = createAppTargetServerController({
    appTargets,
    safeSend(_ws, payload) { sent.push(payload); return true; },
    uiSockets: new Set([dex]),
    getDurability: () => ({})
  });

  assert.equal(await controller.handle(dex, { type: 'request_app_targets' }), true);
  assert.equal(sent.at(-1).type, 'app_targets_update');
  sent.length = 0;
  assert.equal(await controller.handle(dex, {
    type: 'send_prompt', requestId: 'dex-app-direct', text: 'forbidden',
    targetClassId: 'app-origin', targetId: appTarget.id
  }), true);
  assert.equal(sent.at(-1).code, 'DEX_SERVER_SCHEDULER_OWNS_TRANSPORT');
});
