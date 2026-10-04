'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createServerSchedulerRecovery } = require('../dex/server-scheduler-recovery');

function clone(value) { return JSON.parse(JSON.stringify(value)); }

test('interrupted App-Origin Dex turn recovers by stable capture without replaying the prompt', async () => {
  let nowMs = Date.parse('2026-10-01T19:30:00.000Z');
  let state = {
    version: 1,
    rooms: [{
      id: 'room-app',
      name: 'Native Eve',
      members: [{
        id: 'eve-app',
        name: 'Eve App',
        binding: {
          targetClassId: 'app-origin',
          targetId: 'app-chatgpt-windows',
          targetTypeId: 'desktop-app',
          providerId: 'chatgpt-desktop',
          providerName: 'ChatGPT App',
          concreteTargetIdentity: { processId: 118148, windowHandle: 4473474, conversationTitle: 'Test response' }
        }
      }],
      messages: [{
        id: 'source-1', senderKind: 'user', senderId: 'user',
        senderName: 'Drift', text: 'Continue from native app'
      }],
      relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Recovering' },
      recovery: {
        requestId: 'dex-turn-app-1',
        memberId: 'eve-app',
        sourceMessageId: 'source-1',
        inboxMessageIds: [],
        targetClassId: 'app-origin',
        providerId: 'chatgpt-desktop',
        relayActive: false,
        relayRemaining: 0,
        retryCount: 0,
        dispatched: true,
        startedAt: '2026-10-01T19:29:55.000Z',
        interruptedAt: '2026-10-01T19:29:58.000Z',
        captureRequestId: null,
        candidateText: null,
        candidateAt: 0
      }
    }]
  };
  const target = {
    id: 'app-chatgpt-windows',
    providerId: 'chatgpt-desktop',
    targetClassId: 'app-origin',
    concreteTargetIdentity: { processId: 118148, windowHandle: 4473474, conversationTitle: 'Test response' }
  };
  const captures = [], scheduled = [];
  const recovery = createServerSchedulerRecovery({
    load: () => clone(state),
    save(next) { state = clone(next); return clone(state); },
    uid: (prefix) => prefix + '-1',
    nowMs: () => nowMs,
    getOnlineTargets: () => [],
    getProviders: () => [],
    getSelectedOnlineTarget: () => null,
    getLocalTargets: async () => [],
    getAppTargets: async () => [target],
    isExtensionAvailable: () => false,
    sendExtension() { throw new Error('App recovery must not use the browser extension.'); },
    captureLocalLatest: async () => { throw new Error('Wrong recovery transport.'); },
    captureAppLatest: async ({ targetId }) => {
      captures.push(targetId);
      return {
        text: 'Recovered native reply',
        isGenerating: false,
        generationState: 'idle',
        completenessHint: 'settled',
        observedAt: nowMs
      };
    },
    recordIncident() {},
    markTimedOut: async () => {},
    addMessage(room, input) {
      const message = { id: 'recovered-1', at: new Date(nowMs).toISOString(), ...input };
      room.messages.push(message);
      return message;
    },
    enqueueNext: () => false,
    setStopped(room, reason) {
      room.relay.active = false;
      room.relay.remaining = 0;
      room.relay.waitingFor = null;
      room.relay.lastStopReason = reason;
    },
    processSoon(delay) { scheduled.push(delay); },
    onRecovered() {},
    onTurnSettled() {}
  });
  const durability = {
    query(id) {
      assert.equal(id, 'dex-turn-app-1');
      return { reliable: true, entry: { requestId: id, state: 'accepted' } };
    }
  };

  await recovery.resume(durability);
  assert.deepEqual(captures, ['app-chatgpt-windows']);
  assert.equal(state.rooms[0].recovery.candidateText, 'Recovered native reply',
    'first stable capture is recorded but not trusted immediately');
  assert.ok(scheduled.some((delay) => delay >= 1200));

  nowMs += 2000;
  await recovery.resume(durability);
  assert.deepEqual(captures, ['app-chatgpt-windows', 'app-chatgpt-windows']);
  assert.equal(state.rooms[0].recovery, undefined);
  assert.equal(state.rooms[0].messages.at(-1).text, 'Recovered native reply');
  assert.equal(state.rooms[0].messages.at(-1).senderName, 'Eve App');
});

test('App-Origin recovery refuses a replacement ChatGPT process until human rebind', async () => {
  const stateApi = require('../dex/server-scheduler-state');
  const member = {
    binding: {
      targetClassId: 'app-origin',
      targetId: 'app-chatgpt-windows',
      providerId: 'chatgpt-desktop',
      concreteTargetIdentity: { processId: 118148, windowHandle: 4473474, conversationTitle: 'Test response' }
    }
  };
  assert.equal(stateApi.resolveApp(member, [{
    id: 'app-chatgpt-windows',
    providerId: 'chatgpt-desktop',
    targetClassId: 'app-origin',
    concreteTargetIdentity: { processId: 999999, windowHandle: 4473474, conversationTitle: 'Test response' }
  }]), null);
  assert.equal(stateApi.resolveApp(member, [{
    id: 'app-chatgpt-windows',
    providerId: 'chatgpt-desktop',
    targetClassId: 'app-origin',
    concreteTargetIdentity: { processId: 118148, windowHandle: 4473474, conversationTitle: 'Another chat' }
  }]), null);
});
