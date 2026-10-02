'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../app-targets/chatgpt-windows');

test('ChatGPT Windows adapter falls back to a hashed conversation anchor when the native title is unavailable', async () => {
  const windowInfo = { hwnd: 778, pid: 4243, title: 'ChatGPT', x: 0, y: 0, width: 1000, height: 700 };
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'list-windows') {
        return { ok: true, json: { windows: [windowInfo] }, stderr: '', stdout: '' };
      }
      if (args[1] === 'inspect') {
        return {
          ok: true,
          json: { windows: [{ ...windowInfo, elements: [{
            selector: 'root', type: 'Pane', x: 0, y: 0, width: 1000, height: 700, children: [
              { selector: 'u-role', type: 'Text', name: 'You said', x: 220, y: 140, width: 1, height: 1, children: [] },
              { selector: 'u', type: 'Text', name: 'APP_ORIGIN_TEST_003 — Reply exactly with: NATIVE_EVE_OK',
                x: 690, y: 160, width: 260, height: 32, children: [] },
              { selector: 'a-role', type: 'Text', name: 'ChatGPT said', x: 220, y: 220, width: 1, height: 1, children: [] },
              { selector: 'a', type: 'Text', name: 'NATIVE_EVE_OK',
                x: 220, y: 240, width: 180, height: 28, children: [] }
            ]
          }] }] },
          stderr: '', stdout: ''
        };
      }
      if (args[1] === 'search') {
        return { ok: false, json: { matches: [] }, stderr: '', stdout: '' };
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };

  const adapter = createAdapter({ runner, platform: 'win32' });
  const targets = await adapter.listTargets();
  assert.equal(targets.length, 1);
  const identity = targets[0].concreteTargetIdentity;
  assert.equal(identity.conversationTitle, undefined);
  assert.match(identity.conversationAnchor, /^[a-f0-9]{64}$/);
  assert.ok(identity.conversationAnchors.includes(identity.conversationAnchor));
  assert.equal(targets[0].capabilities.exactConversationIdentity, true);
  assert.match(targets[0].title, /verified native conversation/);
});

test('ChatGPT Windows adapter advertises exact app process and active conversation title when available', async () => {
  const windowInfo = { hwnd: 777, pid: 4242, title: 'ChatGPT', x: 0, y: 0, width: 1000, height: 700 };
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'list-windows') {
        return { ok: true, json: { windows: [windowInfo] }, stderr: '', stdout: '' };
      }
      if (args[1] === 'inspect') {
        return {
          ok: true,
          json: { windows: [{ ...windowInfo, elements: [{
            selector: 'root', type: 'Pane', x: 0, y: 0, width: 1000, height: 700, children: [
              { selector: 'chat-title', type: 'Heading', name: 'Native Eve Test',
                x: 180, y: 45, width: 240, height: 26, children: [] }
            ]
          }] }] },
          stderr: '', stdout: ''
        };
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };

  const adapter = createAdapter({ runner, platform: 'win32' });
  const targets = await adapter.listTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, 'app-chatgpt-windows');
  assert.equal(targets[0].providerId, 'chatgpt-desktop');
  assert.equal(targets[0].transport, 'windows-uia-winapp');
  assert.equal(targets[0].concreteTargetIdentity.windowHandle, 777);
  assert.equal(targets[0].concreteTargetIdentity.conversationTitle, 'Native Eve Test');
  assert.match(targets[0].title, /Native Eve Test/);
});


test('ChatGPT Windows adapter resolves the real thread title even when anchors exist and shallow UI only exposes Minimize', async () => {
  const windowInfo = { hwnd: 779, pid: 4244, title: 'ChatGPT', x: 100, y: 20, width: 1000, height: 700 };
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'list-windows') {
        return { ok: true, json: { windows: [windowInfo] }, stderr: '', stdout: '' };
      }
      if (args[1] === 'inspect') {
        return {
          ok: true,
          json: { windows: [{ ...windowInfo, elements: [{
            selector: 'root', type: 'Pane', x: 100, y: 20, width: 1000, height: 700, children: [
              { selector: 'minimize', type: 'Button', name: 'Minimize',
                x: 1020, y: 28, width: 34, height: 28, children: [] },
              { selector: 'u', type: 'Text', name: 'NOVA_CODEX_TEST',
                x: 760, y: 220, width: 230, height: 32, children: [] },
              { selector: 'a', type: 'Text', name: 'NOVA_CODEX_OK',
                x: 240, y: 290, width: 180, height: 28, children: [] }
            ]
          }] }] },
          stderr: '', stdout: ''
        };
      }
      if (args[1] === 'search') {
        const query = String(args[2]);
        if (['conversation', 'thread', 'chat title', 'title', 'header', 'Heading', 'Button', 'Text'].includes(query)) {
          return { ok: true, json: { matches: [{
            selector: 'thread-title-live', type: 'Heading',
            name: 'Merger Work and Stabilization - Greet',
            x: 330, y: 58, width: 420, height: 32
          }] }, stderr: '', stdout: '' };
        }
        return { ok: false, json: { matches: [] }, stderr: '', stdout: '' };
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };

  const adapter = createAdapter({ runner, platform: 'win32' });
  const targets = await adapter.listTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].concreteTargetIdentity.conversationTitle, 'Merger Work and Stabilization - Greet');
  assert.match(targets[0].concreteTargetIdentity.conversationAnchor, /^[a-f0-9]{64}$/);
  assert.match(targets[0].title, /Merger Work and Stabilization - Greet/);
  assert.doesNotMatch(targets[0].title, /Minimize/);
});
