'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../app-targets/chatgpt-windows');

const windowInfo = {
  hwnd: 501, pid: 9001, title: 'ChatGPT',
  x: 0, y: 0, width: 1200, height: 900
};

function snapshot(children) {
  return {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'root', type: 'Pane',
        x: 0, y: 0, width: 1200, height: 900,
        children: [
          ...children,
          {
            selector: 'doc-compose', type: 'Document', name: 'Ask ChatGPT',
            automationId: 'prompt-textarea', isKeyboardFocusable: true,
            x: 320, y: 790, width: 800, height: 64, children: []
          }
        ]
      }]
    }]
  };
}

test('native send finalizes from one offscreen-inclusive reconstruction without slowing polling', async () => {
  let clock = 0;
  const prompt = 'give me a long answer';
  const visibleInspects = [
    snapshot([{ selector: 'old', type: 'Text', name: 'Old answer', x: 300, y: 300, width: 300, height: 30, children: [] }]),
    snapshot([
      { selector: 'old', type: 'Text', name: 'Old answer', x: 300, y: 300, width: 300, height: 30, children: [] },
      { selector: 'send', type: 'Button', name: 'Send', x: 1060, y: 800, width: 42, height: 42, children: [] }
    ]),
    snapshot([
      { selector: 'old', type: 'Text', name: 'Old answer', x: 300, y: 300, width: 300, height: 30, children: [] },
      { selector: 'prompt', type: 'Text', name: prompt, x: 870, y: 450, width: 250, height: 30, children: [] }
    ]),
    snapshot([
      { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
      { selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] },
      { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said', x: 280, y: 210, width: 1, height: 2, children: [] },
      { selector: 'reply-tail', type: 'Paragraph', name: 'BETA visible tail.', x: 280, y: 300, width: 450, height: 35, children: [] }
    ]),
    snapshot([
      { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
      { selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] },
      { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said', x: 280, y: 210, width: 1, height: 2, children: [] },
      { selector: 'reply-tail', type: 'Paragraph', name: 'BETA visible tail.', x: 280, y: 300, width: 450, height: 35, children: [] }
    ])
  ];
  const fullInspect = snapshot([
    { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
    { selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] },
    { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said', x: 280, y: 210, width: 1, height: 2, children: [] },
    { selector: 'reply-head', type: 'Paragraph', name: 'ALPHA offscreen beginning.', x: 280, y: -140, width: 500, height: 45, isOffscreen: true, children: [] },
    { selector: 'reply-tail', type: 'Paragraph', name: 'BETA visible tail.', x: 280, y: 300, width: 450, height: 35, children: [] }
  ]);
  let fullInspectCount = 0;
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'inspect') {
        if (!args.includes('--hide-offscreen')) {
          fullInspectCount += 1;
          return { ok: true, json: fullInspect, stdout: '', stderr: '' };
        }
        const json = visibleInspects.shift();
        if (!json) throw new Error('Unexpected extra visible inspect');
        return { ok: true, json, stdout: '', stderr: '' };
      }
      if (args[1] === 'set-value' || args[1] === 'invoke') {
        return { ok: true, json: { ok: true }, stdout: '', stderr: '' };
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };
  const adapter = createAdapter({
    runner,
    platform: 'win32',
    sleepFn: async () => {},
    now: () => { clock += 1000; return clock; },
    firstPollMs: 0,
    pollMs: 0,
    settleMs: 0,
    shortReplySettleMs: 0,
    responseTimeoutMs: 30000
  });
  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'full-native-reply',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  const expected = 'ALPHA offscreen beginning.\n\nBETA visible tail.';
  assert.equal(result.text, expected);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, expected);
  assert.ok(events.some((event) => event.type === 'response_partial' && event.text === 'BETA visible tail.'));
  assert.ok(events.some((event) => event.type === 'response_partial' && event.text === expected));
  assert.equal(fullInspectCount, 1, 'full offscreen UIA tree should be fetched only once at finalization');
});
