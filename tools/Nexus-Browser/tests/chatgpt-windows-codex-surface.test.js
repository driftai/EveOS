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

function codexTree({ prompt = 'test', answer = '', progress = '', generating = false, send = false,
  promptX = 900, promptWidth = 180, composerValue = 'Do anything' } = {}) {
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
      x: promptX, y: 330, width: promptWidth, height: 42, children: [] },
    ...(progress ? [{
      selector: 'work-status', type: 'Text', name: progress,
      x: 360, y: 392, width: 160, height: 24, children: []
    }] : []),
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
    { selector: 'compose-codex', type: 'Custom', name: composerValue,
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

test('short right-edge Codex prompts retain their markerless assistant turn', () => {
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: codexTree({ prompt: 'again', answer: 'Alpha.', promptX: 1040, promptWidth: 56 })
  });
  const observed = responseForPrompt(snapshot, { prompt: 'again', includeOffscreen: true });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, 'Alpha.');
  assert.equal(observed.nativeTurn?.text, 'Alpha.');
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
    codexTree({ prompt: 'test', answer: '', send: true, composerValue: 'test' }),
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


test('Codex exact prompt wins over unrelated role markers elsewhere in the UIA tree', () => {
  const prompt = 'NOVA_CODEX_TEST_003 — Reply exactly with: NOVA_CODEX_OK_003';
  const answer = 'NOVA_CODEX_OK_003';
  const json = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', name: '',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'stale-user-role', type: 'Text', name: 'You said:',
          x: 250, y: 120, width: 80, height: 20, children: [] },
        { selector: 'stale-user-text', type: 'Text', name: 'old normal chat prompt',
          x: 760, y: 150, width: 250, height: 30, children: [] },
        { selector: 'stale-assistant-role', type: 'Text', name: 'ChatGPT said:',
          x: 250, y: 190, width: 110, height: 20, children: [] },
        { selector: 'stale-assistant-text', type: 'Text', name: 'old normal chat reply',
          x: 350, y: 220, width: 280, height: 30, children: [] },
        { selector: 'codex-mode', type: 'Text', name: 'Codex',
          x: 160, y: 105, width: 80, height: 22, children: [] },
        { selector: 'codex-prompt', type: 'Text', name: prompt,
          x: 780, y: 360, width: 320, height: 54, children: [] },
        { selector: 'codex-answer', type: 'Text', name: answer,
          x: 360, y: 450, width: 300, height: 36, children: [] },
        { selector: 'compose-codex', type: 'Edit', name: 'Do anything',
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


test('Codex completion announcement is chrome and does not duplicate the visible Nova reply', () => {
  const prompt = 'NOVA_CODEX_TEST_004 — Reply exactly with: NOVA_CODEX_OK_004';
  const answer = 'NOVA_CODEX_OK_004';
  const json = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', name: '',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'user-role', type: 'Text', name: 'You said:',
          x: 780, y: 300, width: 90, height: 24, children: [] },
        { selector: 'codex-prompt', type: 'Text', name: prompt,
          x: 780, y: 330, width: 320, height: 54, children: [] },
        { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said:',
          x: 350, y: 390, width: 110, height: 20, children: [] },
        { selector: 'completion-live-region', type: 'Text',
          name: 'Response complete: ' + answer,
          x: 350, y: 410, width: 420, height: 26, children: [] },
        { selector: 'codex-answer', type: 'Text', name: answer,
          x: 350, y: 450, width: 300, height: 36, children: [] },
        { selector: 'answer-time', type: 'Text', name: '9:03 PM',
          x: 350, y: 490, width: 50, height: 18, children: [] },
        { selector: 'compose-codex', type: 'Edit', name: 'Do anything',
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  const observed = responseForPrompt(snapshot, { prompt });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, answer);
  assert.equal(observed.nativeTurn?.text, answer);

  const turns = completedAssistantTurns(snapshot);
  assert.equal(turns.length, 1);
  assert.equal(turns[0].text, answer);
});


test('Codex Working/Worked duration banners are transient chrome, not assistant replies', () => {
  for (const progress of ['Working for 5s', 'Worked for 6s', 'Working for 3m 24s']) {
    const snapshot = snapshotFromInspect({
      windowInfo,
      json: codexTree({ prompt: 'long turn', progress })
    });
    const observed = responseForPrompt(snapshot, { prompt: 'long turn' });
    assert.equal(observed.correlated, true);
    assert.equal(observed.text, '');
    assert.equal(observed.nativeTurn, null);
  }
});

test('active long Codex turn waits through Working/Worked banners for the real answer', async () => {
  let clock = 0;
  const prompt = 'long Nova handoff';
  const answer = 'Synced. I will preserve the working App-Origin transport and continue from the current checkout.';
  const sequence = [
    codexTree({ prompt: 'old visible prompt', answer: 'Older Nova answer.' }),
    codexTree({ prompt, answer: '', send: true, composerValue: prompt }),
    codexTree({ prompt, progress: 'Working for 5s' }),
    codexTree({ prompt, progress: 'Worked for 6s' }),
    codexTree({ prompt, answer }),
    codexTree({ prompt, answer })
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
    requestId: 'codex-long-active',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  assert.equal(result.text, answer);
  assert.equal(events.some((event) => /^(?:Working|Worked) for /i.test(event.text || '')), false);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, answer);
});


test('collapsed long Codex prompt prefix still owns the final reply', () => {
  const prompt = 'From eve, [Send this to Nova Hey Nova — quick sync. I pulled the local EveOS checkout forward and this intentionally keeps going so the live app collapses the user bubble behind Show more. Preserve the working transport and inspect the current codebase as-is before continuing.]';
  const visiblePrompt = prompt.slice(0, 145) + '…';
  const answer = 'Synced. I will preserve the working App-Origin transport and continue from the current checkout.';
  const json = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', name: '',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'codex-prompt', type: 'Text', name: visiblePrompt,
          x: 760, y: 300, width: 330, height: 120, children: [] },
        { selector: 'show-more', type: 'Text', name: 'Show more',
          x: 920, y: 425, width: 75, height: 20, children: [] },
        { selector: 'work-status', type: 'Text', name: 'Worked for 3m 5s',
          x: 360, y: 470, width: 150, height: 24, children: [] },
        { selector: 'codex-answer', type: 'Paragraph', name: answer,
          x: 350, y: 520, width: 520, height: 90, children: [] },
        { selector: 'compose-codex', type: 'Edit', name: 'Do anything',
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

test('active long collapsed Codex prompt waits through Show more and progress chrome for the real answer', async () => {
  let clock = 0;
  const prompt = 'From eve, [Send this to Nova Hey Nova — quick sync. I pulled the local EveOS checkout forward and this intentionally keeps going so the live app collapses the user bubble behind Show more. Preserve the working transport and inspect the current codebase as-is before continuing.]';
  const visiblePrompt = prompt.slice(0, 145) + '…';
  const answer = 'Synced. I will preserve the working App-Origin transport and continue from the current checkout.';
  const tree = ({ progress = '', answerText = '', send = false, composerValue = 'Do anything' } = {}) => ({
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', name: '',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'codex-prompt', type: 'Text', name: visiblePrompt,
          x: 760, y: 300, width: 330, height: 120, children: [] },
        { selector: 'show-more', type: 'Text', name: 'Show more',
          x: 920, y: 425, width: 75, height: 20, children: [] },
        ...(progress ? [{ selector: 'work-status', type: 'Text', name: progress,
          x: 360, y: 470, width: 150, height: 24, children: [] }] : []),
        ...(answerText ? [{ selector: 'codex-answer', type: 'Paragraph', name: answerText,
          x: 350, y: 520, width: 520, height: 90, children: [] }] : []),
        ...(send ? [{ selector: 'send-codex', type: 'Button', name: 'Send',
          x: 1040, y: 800, width: 44, height: 44, children: [] }] : []),
        { selector: 'compose-codex', type: 'Edit', name: composerValue,
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  });
  const sequence = [
    codexTree({ prompt: 'old visible prompt', answer: 'Older Nova answer.' }),
    tree({ send: true, composerValue: prompt }),
    tree({ progress: 'Working for 5s' }),
    tree({ progress: 'Worked for 3m 5s' }),
    tree({ answerText: answer }),
    tree({ answerText: answer })
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
    requestId: 'codex-long-collapsed',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  assert.equal(result.text, answer);
  assert.equal(events.some((event) => /^(?:Working|Worked) for /i.test(event.text || '')), false);
  assert.equal(events.some((event) => /^Show more$/i.test(event.text || '')), false);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, answer);
});
