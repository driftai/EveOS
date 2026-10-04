'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromInspect, createAdapter } = require('../app-targets/chatgpt-windows');

const windowInfo = {
  hwnd: 501, pid: 9001, title: 'ChatGPT',
  x: 0, y: 0, width: 1200, height: 900
};

function inspectTree({ composerName = 'Do anything', composerType = 'Custom', focusable = true,
  text = [], send = false } = {}) {
  const children = [
    ...text.map((name, index) => ({
      selector: 'txt-' + index, type: 'Text', name,
      x: 280, y: 300 + index * 35, width: 640, height: 28, children: []
    })),
    {
      selector: 'compose-live', type: composerType, name: composerName,
      x: 320, y: 790, width: 760, height: 64,
      isKeyboardFocusable: focusable, children: []
    }
  ];
  if (send) children.push({
    selector: 'send-live', type: 'Button', name: 'Send',
    x: 1030, y: 800, width: 42, height: 42, children: []
  });
  return {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', name: '',
      x: 0, y: 0, width: 1200, height: 900, children
    }] }]
  };
}

test('new ChatGPT Do anything focusable shell is accepted as the composer', () => {
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: inspectTree()
  });
  assert.equal(snapshot.composerSelector, 'compose-live');
});

test('static Do anything text cannot become the composer', () => {
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: inspectTree({ composerType: 'Text', focusable: false })
  });
  assert.equal(snapshot.composerSelector, '');
});

test('typed recovery searches the new Do anything composer shape', async () => {
  const calls = [];
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      calls.push(args);
      if (args[1] === 'inspect') {
        return {
          ok: true,
          json: { windows: [{ ...windowInfo, elements: [{
            selector: 'headline', type: 'Text', name: 'Ready',
            x: 450, y: 300, width: 200, height: 30, children: []
          }] }] },
          stderr: '', stdout: ''
        };
      }
      if (args[1] === 'search' && args[2] === 'Do anything') {
        return {
          ok: true,
          json: { matches: [{
            selector: 'compose-recovered', type: 'Custom', name: 'Do anything',
            x: 320, y: 790, width: 760, height: 64, isKeyboardFocusable: true
          }] },
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
  const snapshot = await adapter.probeControls(windowInfo, {
    recoverComposer: true, recoverSend: false
  });
  assert.equal(snapshot.composerSelector, 'compose-recovered');
  assert.ok(calls.some((args) => args[1] === 'search' && args[2] === 'Do anything'));
});

test('Do anything reset counts as a cleared composer after submit', async () => {
  let clock = 0;
  const sequence = [
    inspectTree(),
    inspectTree({ composerName: 'hello shape', send: true }),
    inspectTree({ composerName: 'Do anything' }),
    inspectTree({ composerName: 'Do anything', text: ['hello shape', 'SHAPE_OK'] }),
    inspectTree({ composerName: 'Do anything', text: ['hello shape', 'SHAPE_OK'] }),
    inspectTree({ composerName: 'Do anything', text: ['hello shape', 'SHAPE_OK'] })
  ];
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'inspect') {
        const json = sequence.shift();
        if (!json) throw new Error('Unexpected extra inspect');
        return { ok: true, json, stderr: '', stdout: '' };
      }
      if (args[1] === 'set-value' || args[1] === 'invoke') {
        return { ok: true, json: { ok: true }, stderr: '', stdout: '' };
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };
  const adapter = createAdapter({
    runner, platform: 'win32', sleepFn: async () => {},
    now: () => { clock += 1000; return clock; },
    pollMs: 0, settleMs: 0, shortReplySettleMs: 0, responseTimeoutMs: 30000
  });
  const result = await adapter.sendPrompt({
    requestId: 'shape-submit',
    text: 'hello shape',
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: () => {}
  });
  assert.equal(result.text, 'SHAPE_OK');
});
