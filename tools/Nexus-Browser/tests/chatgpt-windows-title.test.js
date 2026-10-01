'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromInspect } = require('../app-targets/chatgpt-windows');
const titleResolver = require('../app-targets/chatgpt-windows-title');

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
