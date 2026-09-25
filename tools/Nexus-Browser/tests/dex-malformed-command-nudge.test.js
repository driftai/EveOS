'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = path.resolve(__dirname, '..');
const watcherSrc = fs.readFileSync(path.join(root, 'extension/content/dex-provider-control.js'), 'utf8');
const bridgeSrc = fs.readFileSync(path.join(root, 'extension/dex-provider-control-bridge.js'), 'utf8');
const watcher = require('../extension/content/dex-provider-control.js');
const protocol = require('../public/dex-protocol.js');

test('valid trailing commands, nested marker strings and code examples never nudge', () => {
  const valid = '[[DEX:CMD {"action":"status"}]]';
  assert.equal(watcher.parseTrailingCommand(valid).command.action, 'status');
  assert.equal(watcher.malformedTrailingCommand(valid), null);
  const inner = '[[DEX:CMD {"action":"status"}]]';
  const outer = '[[DEX:CMD ' + JSON.stringify({ action: 'send', text: 'embedded ' + inner, relay: true }) + ']]';
  assert.equal(watcher.parseTrailingCommand(outer).command.text, 'embedded ' + inner);
  assert.equal(watcher.malformedTrailingCommand(outer), null);
  const fence = String.fromCharCode(96).repeat(3);
  assert.equal(watcher.malformedTrailingCommand(fence + '\n[[DEX:CMD\n' + fence), null);
  assert.equal(watcher.malformedTrailingCommand('Regular chat with no attempted marker.'), null);
});

test('truncated closing brackets, spaced delimiters, broken JSON, unknown action and trailing prose produce diagnostic only', () => {
  const cases = [
    ['[[DEX:CMD {"action":"status"}]', 'MISSING_CLOSER'],
    ['[[DEX:CMD', 'MALFORMED_DELIMITERS'],
    ['[ [DEX:CMD {"action":"status"}] ]', 'MALFORMED_DELIMITERS'],
    ['[DEX:CMD {"action":"status"}]', 'MALFORMED_DELIMITERS'],
    ['Starting the action: [[DEX:CMD {"action":"status"}', 'MISSING_CLOSER'],
    ['[[DEX:CMD {"action":"status"', 'INCOMPLETE_JSON'],
    ['[[DEX:CMD {"action":status}]]', 'INVALID_JSON'],
    ['[[DEX:CMD {"action":"unsupported"}]]', 'UNKNOWN_ACTION'],
    ['[[DEX:CMD {"action":"status"}]]\nextra prose', 'TRAILING_TEXT']
  ];
  for (const [input, code] of cases) {
    assert.equal(watcher.parseTrailingCommand(input), null, input);
    assert.equal(watcher.malformedTrailingCommand(input)?.code, code, input);
    const parsed = protocol.parseAgentReply(input);
    assert.equal(parsed.providerControlCommand, undefined);
    assert.equal(parsed.malformedCommand, true);
    const disposition = protocol.relayDisposition(parsed, 'Eve', false, { active: true, remaining: 2 });
    assert.equal(disposition.action, 'stop', input);
    assert.equal(disposition.kind, 'invalid-control', input);
  }
});

function headedWatcher() {
  let clock = 10000, onMutation, active = false, raw = '', turnId = 'turn-1';
  const timers = [], sent = [];
  const answer = {
    assistantNodes: () => [{ innerText: raw, closest: () => ({
      getAttribute: (name) => name === 'data-chatgpt-selection-message-id' ? turnId : null
    }) }],
    latestAssistantText: () => raw
  };
  const sandbox = {
    window: {}, document: { body: {} }, Date: { now: () => clock },
    setTimeout(fn, ms) { timers.push({ fn, ms }); return timers.length; },
    MutationObserver: class { constructor(fn) { onMutation = fn; } observe() {} },
    chrome: { runtime: { onMessage: { addListener() {} }, sendMessage(payload) {
      sent.push(JSON.parse(JSON.stringify(payload)));
      return Promise.resolve({ ok: true });
    } } },
    BrowserAiBridgeChatGptAnswer: answer,
    BrowserAiBridgeChatGptInput: { generationLooksActive: () => active }
  };
  vm.runInNewContext(watcherSrc, sandbox, { filename: 'dex-provider-control.js' });
  const flush = () => {
    const task = timers.shift();
    assert.ok(task, 'a stabilized watcher sample is scheduled');
    clock += Math.max(task.ms, 451);
    task.fn();
  };
  return { sent, flush, timers, sandbox,
    setReply(value, id) { raw = value; turnId = id; onMutation(); },
    generating(value) { active = value; }
  };
}

test('headed watcher waits for final generation, nudges once, prevents corrective loops, and accepts a valid retry', () => {
  const h = headedWatcher();
  h.setReply('[[DEX:CMD {"action":"send","text":"qualified","relay":true}]', 'turn-one');
  h.generating(true);
  h.flush(); h.flush();
  assert.equal(h.sent.length, 0, 'never nudge during generation');
  h.generating(false);
  h.flush();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].type, 'dex_provider_command_malformed');
  assert.equal(h.sent[0].code, 'MISSING_CLOSER');
  assert.equal(h.sent[0].clientActionId, 'chatgpt:message:turn-one');
  h.setReply('[[DEX:CMD {"action":"send","text":"qualified","relay":true}]', 'turn-one');
  h.flush();
  assert.equal(h.sent.length, 1, 'same assistant turn cannot nudge twice');
  h.setReply('[ [DEX:CMD {"action":"status"}] ]', 'repair-followup');
  h.flush(); h.flush();
  assert.equal(h.sent.length, 1, 'a malformed repair response cannot start an acknowledgement loop');
  h.setReply('[[DEX:CMD {"action":"status"}]]', 'valid-retry');
  h.flush(); h.flush();
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[1].type, 'dex_provider_command');
  assert.equal(h.sent[1].command.action, 'status');
  const diag = h.sandbox.BrowserAiBridgeDexProviderControlContent.diagnostics();
  assert.equal(diag.nudgesSent, 1);
  assert.equal(diag.nudgesSuppressed, 1);
  assert.equal(Object.hasOwn(diag, 'text'), false, 'no private reply content in diagnostics');
});

function bridgeHarness(sharedStore, accept = true) {
  const injected = [];
  const session = {
    async get(key) { return { [key]: sharedStore.get(key) || 0 }; },
    async set(value) { for (const [key, val] of Object.entries(value)) sharedStore.set(key, val); },
    async remove(key) { sharedStore.delete(key); }
  };
  const sandbox = {
    NexusBrowserRuntimeConfig: { websocketUrl: 'ws://localhost/ws', healthUrl: 'http://localhost/health' },
    BrowserAiBridgeProviders: { providerForUrl: (url) => url.includes('chatgpt.com')
      ? { id: 'chatgpt', name: 'ChatGPT' } : null },
    BrowserAiBridgeProviderAdapterFreshness: { ensure: async () => {} },
    chrome: { storage: { session }, tabs: { async sendMessage(id, message) {
      injected.push({ id, message });
      return accept ? { ok: true } : { ok: false, error: 'submission uncertain' };
    } } }
  };
  vm.runInNewContext(bridgeSrc, sandbox, { filename: 'dex-provider-control-bridge.js' });
  return { bridge: sandbox.BrowserAiBridgeDexProviderControlBridge, injected, sandbox };
}

test('background claims one exact-tab nudge and persists cooldown across content and worker reloads', async () => {
  const store = new Map(), h = bridgeHarness(store);
  const sender = { tab: { id: 42, url: 'https://chatgpt.com/c/eve' } };
  const msg = { type: 'dex_provider_command_malformed', providerId: 'chatgpt',
    clientActionId: 'chatgpt:message:turn-one', code: 'MISSING_CLOSER' };
  await Promise.all([h.bridge.handleMalformedMessage(msg, sender),
    h.bridge.handleMalformedMessage(msg, sender)]);
  assert.equal(h.injected.length, 1);
  assert.equal(h.injected[0].id, 42);
  assert.equal(h.injected[0].message.delivery.kind, 'dex-control-nudge');
  assert.match(h.injected[0].message.text, /ONE SHOT/);
  const restartedWorker = bridgeHarness(store);
  await restartedWorker.bridge.handleMalformedMessage({ ...msg, clientActionId: 'chatgpt:message:next-turn' }, sender);
  assert.equal(restartedWorker.injected.length, 0, 'worker reload does not re-nudge the same tab');
  await restartedWorker.bridge.handleMalformedMessage({ ...msg, providerId: 'muse' }, sender);
  await restartedWorker.bridge.handleMalformedMessage({ ...msg, code: 'FORGED_UNKNOWN_CODE' }, sender);
  assert.equal(restartedWorker.injected.length, 0, 'wrong provider and arbitrary reasons cannot inject a prompt');
});

test('negative browser acknowledgement never causes automatic replay', async () => {
  const store = new Map(), h = bridgeHarness(store, false);
  const sender = { tab: { id: 93, url: 'https://chatgpt.com/c/eve' } };
  const msg = { type: 'dex_provider_command_malformed', providerId: 'chatgpt',
    clientActionId: 'chatgpt:message:fail-turn', code: 'TRAILING_TEXT' };
  await h.bridge.handleMalformedMessage(msg, sender);
  await h.bridge.handleMalformedMessage(msg, sender);
  assert.equal(h.injected.length, 1);
  assert.equal(h.bridge.diagnostics().repairNudgesRejected, 1);
  assert.equal(h.bridge.diagnostics().repairNudgesAccepted, 0);
  assert.match(h.bridge.diagnostics().lastDeliveryError, /submission uncertain/);
});
