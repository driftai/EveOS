const test = require('node:test');
const assert = require('node:assert/strict');

const { createAppTargetServerController } = require('../app-targets/server-controller');

function harness() {
  const target = {
    id: 'app-chatgpt-windows',
    title: 'ChatGPT',
    providerId: 'chatgpt-desktop',
    providerName: 'ChatGPT App',
    targetClassId: 'app-origin',
    targetTypeId: 'desktop-app'
  };
  const messages = [];
  const observed = [];
  const ws = { clientKind: 'browser', appTargetId: null, closed: false };
  const uiSockets = new Set([ws]);
  const terminalRelayStorage = {
    writes: [], clears: [], refreshes: [],
    writeTargetSelection(target) { this.writes.push({ ...target }); return target; },
    clearTargetSelection(targetId) { this.clears.push(targetId); return true; },
    refreshTargetSelection(target) { this.refreshes.push({ ...target }); return target; }
  };
  const durability = {
    async beforeDispatch(msg, meta) {
      observed.push({ kind: 'before', requestId: msg.requestId, meta });
      return { ok: true };
    },
    async observe(payload, meta) {
      observed.push({ kind: 'observe', type: payload.type, meta });
    },
    async markFailed() {}
  };
  const appTargets = {
    async listAppTargets() { return [target]; },
    publicAppTargetTypes() { return [{ id: 'desktop-app', name: 'Desktop App' }]; },
    discoveryDiagnostics() { return { 'chatgpt-desktop': { available: true } }; },
    async getAppTarget(id) { return id === target.id ? target : null; },
    getAppTargetStatus() { return { phase: 'idle' }; },
    async captureAppLatest() { return { text: 'captured app reply', target }; },
    async sendAppPrompt({ requestId, emit, beforeSend }) {
      await beforeSend?.(target);
      for (const payload of [
        { type: 'prompt_accepted', requestId },
        { type: 'response_partial', requestId, text: 'app par' },
        { type: 'response_final', requestId, text: 'app final' }
      ]) emit(payload);
      return { text: 'app final' };
    },
    stopAppTargets() {}
  };
  const controller = createAppTargetServerController({
    appTargets,
    safeSend(peer, payload) {
      if (peer?.closed) return false;
      messages.push({ peer, payload });
      return true;
    },
    uiSockets,
    getDurability: () => durability,
    terminalRelayStorage
  });
  return { controller, appTargets, durability, terminalRelayStorage, target, ws, uiSockets, messages, observed };
}

test('App-Origin discovery and selection stay independent from browser tabs', async () => {
  const h = harness();
  await h.controller.refresh(h.ws, { force: true });
  assert.equal(h.messages.at(-1).payload.type, 'app_targets_update');
  assert.equal(h.messages.at(-1).payload.targets[0].providerId, 'chatgpt-desktop');

  await h.controller.handle(h.ws, { type: 'select_app_target', targetId: h.target.id });
  assert.equal(h.ws.appTargetId, h.target.id);
  assert.equal(h.messages.at(-1).payload.type, 'app_target_selected');
  const scope = h.messages.at(-1).payload.bindingIdentity.deliveryScope;
  assert.match(scope, /^[a-f0-9]{64}$/);

  await h.controller.handle(h.ws, {
    type: 'select_app_target',
    targetId: h.target.id,
    expectedIdentity: h.messages.at(-1).payload.bindingIdentity
  });
  assert.equal(h.messages.at(-1).payload.bindingIdentity.deliveryScope, scope);
});

test('App-Origin server tests persist synthetic selections only through injected storage', async () => {
  const h = harness();
  await h.controller.handle(h.ws, { type: 'select_app_target', targetId: h.target.id });
  assert.equal(h.relayStorage, undefined);
  assert.equal(h.terminalRelayStorage.writes.length, 1);
  assert.equal(h.terminalRelayStorage.writes[0].id, h.target.id);
  assert.equal(h.terminalRelayStorage.writes[0].providerId, 'chatgpt-desktop');
});

test('Base Mode App-Origin send flows through durability and returns app response events', async () => {
  const h = harness();
  h.ws.appTargetId = h.target.id;
  const handled = await h.controller.handle(h.ws, {
    type: 'send_prompt',
    requestId: 'app-send-1',
    text: 'hello native app',
    targetClassId: 'app-origin',
    targetId: h.target.id
  });
  assert.equal(handled, true);
  assert.equal(h.observed[0].kind, 'before');
  assert.equal(h.observed[0].meta.targetClassId, 'app-origin');
  assert.ok(h.observed.some((entry) => entry.type === 'prompt_accepted'));
  assert.ok(h.observed.some((entry) => entry.type === 'response_final'));
  assert.ok(h.messages.some((entry) =>
    entry.payload.type === 'response_final' && entry.payload.text === 'app final'));
});

test('App-Origin replays a missed terminal event after Base UI socket reconnect and rebind', async () => {
  const h = harness();
  h.ws.appTargetId = h.target.id;
  h.ws.closed = true;
  await h.controller.handle(h.ws, {
    type: 'send_prompt', requestId: 'app-reconnect-1', text: 'survive ui disconnect',
    targetClassId: 'app-origin', targetId: h.target.id
  });
  assert.equal(h.messages.some((entry) => entry.payload.requestId === 'app-reconnect-1'), false);

  const replacement = { clientKind: 'browser', appTargetId: null, closed: false };
  h.uiSockets.add(replacement);
  await h.controller.handle(replacement, { type: 'select_app_target', targetId: h.target.id });
  const recovered = h.messages.find((entry) => entry.peer === replacement
    && entry.payload.type === 'response_final' && entry.payload.requestId === 'app-reconnect-1');
  assert.equal(recovered?.payload.text, 'app final');
  assert.equal(recovered?.payload.recoveredAfterReconnect, true);
  assert.equal(h.controller.diagnostics().missedTerminalEvents, 0);
});

test('Base Mode busy rejection happens before the durable dispatch boundary', async () => {
  const h = harness();
  h.ws.appTargetId = h.target.id;
  h.appTargets.sendAppPrompt = async () => {
    const error = new Error('native target busy');
    error.code = 'APP_TARGET_BUSY';
    throw error;
  };

  await h.controller.handle(h.ws, {
    type: 'send_prompt',
    requestId: 'app-busy-1',
    text: 'do not claim me',
    targetClassId: 'app-origin',
    targetId: h.target.id
  });

  assert.equal(h.observed.some((entry) => entry.kind === 'before'), false,
    'busy native target must fail before durable dispatch is claimed');
  const error = h.messages.find((entry) => entry.payload.code === 'APP_TARGET_BUSY');
  assert.ok(error, 'Base Mode should surface APP_TARGET_BUSY directly');
});

test('Base Mode can capture the latest native app reply', async () => {
  const h = harness();
  h.ws.appTargetId = h.target.id;
  await h.controller.handle(h.ws, {
    type: 'capture_latest',
    requestId: 'capture-app-1',
    targetClassId: 'app-origin',
    targetId: h.target.id
  });
  const capture = h.messages.find((entry) => entry.payload.type === 'capture_result');
  assert.equal(capture.payload.text, 'captured app reply');
  assert.equal(capture.payload.providerName, 'ChatGPT App');
});

test('Dex viewer can discover App-Origin targets but direct transport stays scheduler-owned', async () => {
  const h = harness();
  const dex = { clientKind: 'dex', appTargetId: null };

  await h.controller.handle(dex, { type: 'request_app_targets' });
  const discovery = h.messages.find((entry) => entry.peer === dex && entry.payload.type === 'app_targets_update');
  assert.equal(discovery.payload.targets[0].id, h.target.id);

  await h.controller.handle(dex, {
    type: 'send_prompt',
    requestId: 'dex-app-1',
    text: 'no direct send',
    targetClassId: 'app-origin',
    targetId: h.target.id
  });
  const error = h.messages.find((entry) => entry.peer === dex && entry.payload.type === 'error');
  assert.equal(error.payload.code, 'DEX_SERVER_SCHEDULER_OWNS_TRANSPORT');
});
