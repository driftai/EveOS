'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const returns = require('../extension/content/chatgpt-return');
const content = fs.readFileSync(path.resolve(__dirname, '../extension/content/dex-provider-control.js'), 'utf8');
const command = 'Finished. [[DEX:CMD {"action":"send","text":"Unrequested follow-up","relay":true}]]';
function node(id) {
  return { getAttribute(name) { return name === 'data-chatgpt-selection-message-id' ? id : null; },
    innerText: command, closest() { return this; } };
}
test('a HEADSUP response cannot chain a provider command, but the next independent manual turn can', () => {
  let now = 1000, nodes = [node('old')], observed, scheduled = [], sent = [];
  const answer = { latestAssistantText: () => command, assistantNodes: () => nodes };
  const before = returns.baseline(nodes);
  nodes = [...nodes, node('notification-reply')];
  returns.rememberNotificationReply(answer, command, before);
  assert.equal(returns.isNotificationReply(answer, command), true);
  const ctx = {
    window: {}, document: { body: {} }, Date: { now: () => now },
    MutationObserver: class { constructor(fn) { observed = fn; } observe() {} },
    setTimeout(fn) { scheduled.push(fn); return scheduled.length; },
    chrome: { runtime: { onMessage: { addListener() {} },
      sendMessage(payload) { sent.push(payload); return Promise.resolve({ ok: true }); } } },
    BrowserAiBridgeChatGptReturn: returns,
    BrowserAiBridgeChatGptAnswer: answer,
    BrowserAiBridgeChatGptInput: { generationLooksActive: () => false },
    BrowserAiBridgeChatGptRuntime: { responsePending: () => false }
  };
  vm.runInNewContext(content, ctx);
  assert.equal(typeof observed, 'function');
  scheduled.shift()();
  assert.equal(sent.length, 0, 'notification response must not trigger a provider action');
  assert.equal(ctx.BrowserAiBridgeDexProviderControlContent.diagnostics().phase,
    'notification-command-suppressed');
  nodes = [node('old'), node('manual-reply')];
  assert.equal(returns.isNotificationReply(answer, command), false);
  observed();
  scheduled.shift()();
  now += 600;
  scheduled.shift()();
  assert.equal(sent.length, 1, 'an independent subsequent command remains available');
  assert.equal(sent[0].type, 'dex_provider_command');
  assert.equal(sent[0].command.action, 'send');
});
