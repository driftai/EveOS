'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { latestCandidate, createAdapter, snapshotFromInspect } = require('../app-targets/chatgpt-windows');
const { preferExpandedReply, responseForPrompt } = require('../app-targets/chatgpt-windows-conversation');

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

test('native completion chrome is excluded and full reconstruction heals split UIA chunks', () => {
  assert.equal(
    latestCandidate(['LIVE_NATIVE_OK_002', 'Response complete'], {
      baseline: new Set(), prompt: 'Testing LIVE_APP_ORIGIN_002'
    }),
    'LIVE_NATIVE_OK_002'
  );
  assert.equal(
    preferExpandedReply('LIVE_\n\nNA', 'LIVE_NATIVE_OK_002'),
    'LIVE_NATIVE_OK_002'
  );
});

test('prompt-owned reader ignores an old long answer and expands fragmented current UIA text', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const prompt = 'test LIVE_APP_ORIGIN_003 — Reply exactly with: LIVE_NATIVE_OK_003';
  const json = { windows: [{ ...windowInfo, elements: [{
    elementId: 'RootWebArea', controlType: 'Document', name: 'LIVE_NATIVE_OK_003',
    x: 0, y: 0, width: 1200, height: 900, children: [
      { elementId: 'old-user-role', controlType: 'Text', name: 'You said:', x: 250, y: 100, width: 60, height: 20, children: [] },
      { elementId: 'old-user', controlType: 'Text', name: 'older prompt', x: 700, y: 120, width: 140, height: 20, children: [] },
      { elementId: 'old-ai-role', controlType: 'Text', name: 'ChatGPT said:', x: 250, y: 160, width: 90, height: 20, children: [] },
      { elementId: 'old-ai', controlType: 'Text', name: 'This is a very long historical answer that must never win current-turn correlation.', x: 250, y: 185, width: 600, height: 40, children: [] },
      { elementId: 'new-user-role', controlType: 'Text', name: 'You said:', x: 250, y: 300, width: 60, height: 20, children: [] },
      { elementId: 'new-user', controlType: 'Text', name: prompt, x: 620, y: 325, width: 480, height: 40, children: [] },
      { elementId: 'new-ai-role', controlType: 'Text', name: 'ChatGPT said:', x: 250, y: 390, width: 90, height: 20, children: [] },
      { elementId: 'new-ai-a', controlType: 'Text', name: 'LIVE_', x: 250, y: 420, width: 45, height: 20, children: [] },
      { elementId: 'new-ai-b', controlType: 'Text', name: 'NATIV', x: 300, y: 420, width: 45, height: 20, children: [] }
    ]
  }] }] };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  const observed = responseForPrompt(snapshot, { prompt });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, 'LIVE_NATIVE_OK_003');
  assert.equal(observed.nativeTurn?.text, 'LIVE_NATIVE_OK_003');
  assert.match(observed.nativeTurn?.fingerprint || '', /^[a-f0-9]{64}$/);
});

test('ChatGPT Windows adapter waits past You said chrome for the real native answer', async () => {
  let clock = 0;
  const inspectSequence = [
    tree({ text: ['Old answer'] }),
    tree({ composer: 'hello from nexus', text: ['Old answer'], send: true }),
    tree({ text: ['You said:', 'hello from nexus', 'ChatGPT said:'] }),
    tree({ text: ['You said:', 'hello from nexus', 'ChatGPT said:', 'actual native answer'] }),
    tree({ text: ['You said:', 'hello from nexus', 'ChatGPT said:', 'actual native answer'] })
  ];
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'inspect') {
        const json = inspectSequence.length > 1 ? inspectSequence.shift() : inspectSequence[0];
        if (!json) throw new Error('Missing inspect fixture');
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
    shortReplySettleMs: 0,
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
