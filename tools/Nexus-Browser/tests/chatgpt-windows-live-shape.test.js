'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { latestCandidate, createAdapter } = require('../app-targets/chatgpt-windows');

function tree({ composer = 'Ask ChatGPT', text = [], send = false } = {}) {
  const children = [
    ...text.map((value, index) => ({
      elementId: `txt-${index}`, controlType: 'Text', name: value, children: []
    })),
    {
      elementId: 'doc-compose',
      controlType: 'Document',
      name: composer,
      automationId: 'prompt-textarea',
      isKeyboardFocusable: true,
      children: []
    }
  ];
  if (send) children.push({
    elementId: 'btn-send', controlType: 'Button', name: 'Send', children: []
  });
  return {
    windows: [{
      hwnd: 501, pid: 9001, title: 'ChatGPT',
      elements: [{ elementId: 'root', controlType: 'Pane', name: '', children }]
    }]
  };
}

test('native role labels never become fallback assistant output', () => {
  const baseline = new Set(['Old answer']);
  assert.equal(
    latestCandidate(['Old answer', 'hello from nexus', 'You said:', 'ChatGPT said:'], {
      baseline, prompt: 'hello from nexus'
    }),
    ''
  );
  assert.equal(
    latestCandidate(['Old answer', 'hello from nexus', 'You said:', 'actual native answer'], {
      baseline, prompt: 'hello from nexus'
    }),
    'actual native answer'
  );
});

test('ChatGPT Windows adapter waits past You said chrome for the real native answer', async () => {
  let clock = 0;
  const inspectSequence = [
    tree({ text: ['Old answer'] }),
    tree({ composer: 'hello from nexus', text: ['Old answer'], send: true }),
    tree({ text: ['Old answer', 'hello from nexus', 'You said:'] }),
    tree({ text: ['Old answer', 'hello from nexus', 'You said:', 'actual native answer'] })
  ];
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'inspect') {
        const json = inspectSequence.shift();
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
    runner,
    platform: 'win32',
    sleepFn: async () => {},
    now: () => { clock += 1000; return clock; },
    pollMs: 0,
    settleMs: 0,
    responseTimeoutMs: 30000
  });
  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'role-chrome-live-shape',
    text: 'hello from nexus',
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  assert.equal(result.text, 'actual native answer');
  assert.equal(events.some((event) => event.text === 'You said:'), false);
  assert.equal(events.at(-1).text, 'actual native answer');
});
