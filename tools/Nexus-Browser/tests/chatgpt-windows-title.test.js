'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromInspect } = require('../app-targets/chatgpt-windows');
const titleResolver = require('../app-targets/chatgpt-windows-title');
const conversation = require('../app-targets/chatgpt-windows-conversation');

function baseWindow() {
  return { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 100, y: 20, width: 1200, height: 900 };
}

test('native title resolver recovers a header exposed only through UIA search', async () => {
  const windowInfo = baseWindow();
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
        { selector: 'reply', type: 'Text', name: 'A normal assistant sentence near the top.',
          x: 330, y: 200, width: 420, height: 28, children: [] }
      ]
    }] }] }
  });
  const runner = {
    async runJson(args) {
      const query = String(args[2]);
      if (!['Heading', 'Button', 'Text', 'title', 'header'].includes(query)) {
        return { ok: false, json: { matches: [] }, stdout: '', stderr: '' };
      }
      return {
        ok: true,
        json: { matches: [
          { selector: 'btn-chat-title-live', type: 'Button', name: 'Test response',
            automationId: 'conversation-title', x: 310, y: 58, width: 210, height: 32 },
          { selector: 'sidebar-old', type: 'Text', name: 'Older chat',
            x: 120, y: 92, width: 130, height: 24 }
        ] },
        stdout: '', stderr: ''
      };
    }
  };
  const result = await titleResolver.resolve({ runner, snapshot });
  assert.equal(result?.text, 'Test response');
  assert.equal(result?.selector, 'btn-chat-title-live');
  assert.equal(result?.source, 'uia-search:title');
});

test('native title resolver does not mistake ordinary conversation text for the title', async () => {
  const windowInfo = baseWindow();
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
        { selector: 'assistant', type: 'Text', name: 'NATIVE_EVE_OK',
          x: 330, y: 240, width: 180, height: 28, children: [] }
      ]
    }] }] }
  });
  const runner = {
    async runJson() {
      return { ok: true, json: { matches: [
        { selector: 'assistant-copy', type: 'Text', name: 'NATIVE_EVE_OK',
          x: 330, y: 240, width: 180, height: 28 }
      ] }, stdout: '', stderr: '' };
    }
  };
  assert.equal(await titleResolver.resolve({ runner, snapshot }), null);
});

test('native title resolver prefers direct inspect identity without extra UIA searches', async () => {
  const windowInfo = baseWindow();
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
        { selector: 'heading-live', type: 'Heading', name: 'Test response',
          x: 330, y: 60, width: 210, height: 30, children: [] }
      ]
    }] }] }
  });
  let searches = 0;
  const result = await titleResolver.resolve({
    runner: { async runJson() { searches += 1; throw new Error('should not search'); } },
    snapshot
  });
  assert.equal(result?.text, 'Test response');
  assert.equal(result?.source, 'inspect');
  assert.equal(searches, 0);
});


test('active conversation title rejects ordinary response Text even inside header geometry', () => {
  const windowInfo = baseWindow();
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
        { selector: 'reply-near-top', type: 'Text', name: 'Yeah — those two scripts',
          x: 330, y: 58, width: 320, height: 30, children: [] }
      ]
    }] }] }
  });
  assert.equal(conversation.activeConversationTitle(snapshot), null);
});

test('active conversation title rejects native status chrome even when exposed as a Heading', () => {
  const windowInfo = baseWindow();
  for (const name of ['Worked for 46s', 'Working for 12s', 'ChatGPT is responding', 'Generating']) {
    const snapshot = snapshotFromInspect({
      windowInfo,
      json: { windows: [{ ...windowInfo, elements: [{
        selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
          { selector: 'status', type: 'Heading', name,
            x: 330, y: 58, width: 260, height: 30, children: [] }
        ]
      }] }] }
    });
    assert.equal(conversation.activeConversationTitle(snapshot), null, name);
  }
});

test('active conversation title rejects malformed response fragments', () => {
  const windowInfo = baseWindow();
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
        { selector: 'bad-fragment', type: 'Heading', name: ', expected=',
          x: 330, y: 58, width: 180, height: 30, children: [] }
      ]
    }] }] }
  });
  assert.equal(conversation.activeConversationTitle(snapshot), null);
});

test('active conversation title accepts semantic title Text without trusting generic Text', () => {
  const windowInfo = baseWindow();
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
        { selector: 'semantic-title', type: 'Text', name: 'Merger Work and Stabilization - Greet',
          automationId: 'conversation-title', x: 330, y: 58, width: 420, height: 30, children: [] }
      ]
    }] }] }
  });
  assert.equal(conversation.activeConversationTitle(snapshot)?.text,
    'Merger Work and Stabilization - Greet');
});
