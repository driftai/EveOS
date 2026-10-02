'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  snapshotFromInspect, createAdapter
} = require('../app-targets/chatgpt-windows');
const {
  responseForPrompt, latestAssistantReply, completedAssistantTurns, conversationAnchorDigests
} = require('../app-targets/chatgpt-windows-conversation');

const windowInfo = {
  hwnd: 501, pid: 9001, title: 'ChatGPT',
  x: 0, y: 0, width: 1200, height: 900
};

function codexTree({ prompt = 'test', answer = '', generating = false, send = false } = {}) {
  const children = [
    { selector: 'mode-chatgpt', type: 'Text', name: 'ChatGPT',
      x: 160, y: 70, width: 100, height: 22, children: [] },
    { selector: 'mode-codex', type: 'Text', name: 'Codex',
      x: 160, y: 105, width: 80, height: 22, children: [] },
    { selector: 'thread-title', type: 'Heading', name: 'Merger Work and Stabilization - Greet',
      x: 385, y: 72, width: 420, height: 28, children: [] },
    { selector: 'today', type: 'Text', name: 'Today',
      x: 585, y: 250, width: 55, height: 20, children: [] },
    { selector: 'time', type: 'Text', name: '12:29 AM',
      x: 565, y: 275, width: 90, height: 20, children: [] },
    { selector: 'user-prompt', type: 'Text', name: prompt,
      x: 900, y: 330, width: 180, height: 42, children: [] },
    ...(answer ? [{
      selector: 'assistant-answer', type: 'Paragraph', name: answer,
      x: 360, y: 410, width: 520, height: 60, children: []
    }] : []),
    ...(generating ? [{
      selector: 'stop', type: 'Button', name: 'Stop generating',
      x: 1040, y: 800, width: 44, height: 44, children: []
    }] : []),
    ...(send ? [{
      selector: 'send-codex', type: 'Button', name: 'Send',
      x: 1040, y: 800, width: 44, height: 44, children: []
    }] : []),
    { selector: 'compose-codex', type: 'Custom', name: 'Do anything',
      x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
  ];
  return {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', name: '',
      x: 0, y: 0, width: 1200, height: 900, children
    }] }]
  };
}

test('Codex markerless prompt correlation ignores timestamp chrome and returns Nova reply', () => {
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: codexTree({ answer: 'Received—everything is working.' })
  });
  const observed = responseForPrompt(snapshot, { prompt: 'test' });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, 'Received—everything is working.');
  assert.notEqual(observed.text, '12:29 AM');
  assert.match(observed.nativeTurn?.fingerprint || '', /^[a-f0-9]{64}$/);
});

test('Codex prompt with no reply yet stays correlated and never emits the timestamp as a response', () => {
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: codexTree({ answer: '' })
  });
  const observed = responseForPrompt(snapshot, { prompt: 'test' });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, '');
  assert.equal(observed.nativeTurn, null);
});

test('Codex latest capture and passive turn enumeration share the same markerless reply', () => {
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: codexTree({ answer: 'Received—everything is working.' })
  });
  assert.equal(latestAssistantReply(snapshot)?.text, 'Received—everything is working.');
  const turns = completedAssistantTurns(snapshot);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, 'Received—everything is working.');
  assert.match(turns[0].fingerprint, /^[a-f0-9]{64}$/);
  const anchors = conversationAnchorDigests(snapshot);
  assert.equal(anchors.length, 1);
  assert.match(anchors[0], /^[a-f0-9]{64}$/);
});

test('active Codex send waits past markerless timestamp chrome for the real Nova answer', async () => {
  let clock = 0;
  const sequence = [
    codexTree({ prompt: 'old visible prompt', answer: 'Older Nova answer.' }),
    codexTree({ prompt: 'test', answer: '', send: true }),
    codexTree({ prompt: 'test', answer: '', generating: true }),
    codexTree({ prompt: 'test', answer: 'Received—everything is working.', generating: false }),
    codexTree({ prompt: 'test', answer: 'Received—everything is working.', generating: false }),
    codexTree({ prompt: 'test', answer: 'Received—everything is working.', generating: false })
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
    requestId: 'codex-active',
    text: 'test',
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  assert.equal(result.text, 'Received—everything is working.');
  assert.equal(events.some((event) => event.text === '12:29 AM'), false);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, 'Received—everything is working.');
  assert.equal(result.nativeTurn?.text, 'Received—everything is working.');
});


test('Codex correlation follows visual geometry when UIA flattening lists the answer before the prompt', () => {
  const prompt = 'NOVA_CODEX_TEST_001 — Reply exactly with: NOVA_CODEX_OK';
  const answer = 'NOVA_CODEX_OK';
  const json = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', name: '',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'mode-codex', type: 'Text', name: 'Codex',
          x: 160, y: 105, width: 80, height: 22, children: [] },
        { selector: 'assistant-answer', type: 'Paragraph', name: answer,
          x: 360, y: 430, width: 320, height: 46, children: [] },
        { selector: 'time', type: 'Text', name: '12:41 AM',
          x: 565, y: 280, width: 90, height: 20, children: [] },
        { selector: 'user-prompt', type: 'Text', name: prompt,
          x: 760, y: 340, width: 330, height: 64, children: [] },
        { selector: 'compose-codex', type: 'Custom', name: 'Do anything',
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  const observed = responseForPrompt(snapshot, { prompt });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, answer);
  assert.equal(observed.nativeTurn?.text, answer);
});
