'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('headed control marker waits for the authoritative ChatGPT reply to finalize', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../extension/content/dex-provider-control.js'), 'utf8');
  const commandText = '[[DEX:CMD {"action":"status","room":"eve-astro"}]]';
  let now = 1000, pending = true;
  const queued = [], requests = [];
  const message = { getAttribute(name) { return name === 'data-chatgpt-selection-message-id' ? 'assistant-1' : null; } };
  const latest = { innerText: commandText, closest: () => message };
  const context = {
    // Browser export is guarded by window; expose it in this isolated VM.
    window: {},
    BrowserAiBridgeChatGptAnswer: {
      latestAssistantText: () => commandText,
      assistantNodes: () => [latest]
    },
    BrowserAiBridgeChatGptInput: { generationLooksActive: () => false },
    BrowserAiBridgeChatGptRuntime: { responsePending: () => pending },
    Date: { now: () => now },
    chrome: { runtime: {
      sendMessage(value) { requests.push(value); return Promise.resolve(); },
      onMessage: { addListener() {} }
    } },
    document: { body: {} },
    MutationObserver: class { observe() {} },
    setTimeout(fn, delay) { queued.push({ fn, delay }); return queued.length; }
  };
  vm.runInNewContext(src, context);
  function flush() {
    const next = queued.shift();
    assert.ok(next);
    now += next.delay + 1;
    next.fn();
  }
  flush(); // first stable sample
  flush(); // marker is stable but the reply is still in flight
  assert.equal(requests.length, 0);
  pending = false;
  flush();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].command.action, 'status');
  assert.equal(requests[0].clientActionId, 'chatgpt:message:assistant-1');
  assert.equal(context.BrowserAiBridgeDexProviderControlContent.diagnostics().phase, 'handed-to-background');
});
