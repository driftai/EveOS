'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../app-targets/chatgpt-windows');
const progress = require('../app-targets/chatgpt-windows-reply-progress');
const conversation = require('../app-targets/chatgpt-windows-conversation');

const windowInfo = {
  hwnd: 501, pid: 9001, title: 'ChatGPT',
  x: 0, y: 0, width: 1200, height: 900
};

function normalTree({ prompt = '', answer = '', status = '', commentaryComplete = false, followup = '', complete = false, completeAction = 'Copy', composer = 'Ask ChatGPT', send = false } = {}) {
  const children = [
    ...(prompt ? [
      { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
      { selector: 'user-text', type: 'Text', name: prompt, x: 760, y: 175, width: 340, height: 48, children: [] }
    ] : []),
    ...(answer ? [
      { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said:', x: 280, y: 240, width: 1, height: 2, children: [] },
      { selector: 'assistant-text', type: 'Paragraph', name: answer, x: 280, y: 270, width: 650, height: 90, children: [] }
    ] : []),
    ...(commentaryComplete ? [{ selector: 'copy-commentary', type: 'Button', name: 'Copy',
      x: 280, y: 362, width: 36, height: 28, children: [] }] : []),
    ...(status ? [{ selector: 'tool-status', type: 'Text', name: status,
      x: 280, y: 405, width: 420, height: 28, children: [] }] : []),
    ...(followup ? [
      { selector: 'assistant-role-2', type: 'Text', name: 'ChatGPT said:', x: 280, y: 380, width: 1, height: 2, children: [] },
      { selector: 'assistant-text-2', type: 'Paragraph', name: followup, x: 280, y: 410, width: 650, height: 90, children: [] }
    ] : []),
    ...(complete ? [{ selector: 'copy-response', type: 'Button', name: completeAction,
      x: 280, y: followup ? 515 : 375, width: 36, height: 28, children: [] }] : []),
    { selector: 'composer', type: 'Document', name: composer, automationId: 'prompt-textarea',
      x: 320, y: 790, width: 800, height: 64, isKeyboardFocusable: true, children: [] },
    ...(send ? [{ selector: 'send', type: 'Button', name: 'Send',
      x: 1060, y: 800, width: 42, height: 42, children: [] }] : [])
  ];
  return { windows: [{ ...windowInfo, elements: [{
    selector: 'root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children
  }] }] };
}

test('authoritative role-owned ChatGPT turn exits Codex accumulation mode', () => {
  let state = 'replace';
  state = progress.transitionProgressMode(state, { progressMode: 'accumulate', nativeTurn: null });
  assert.equal(state, 'accumulate');
  state = progress.transitionProgressMode(state, {
    progressMode: 'replace',
    nativeTurn: { fingerprint: 'f'.repeat(64), text: 'Final app reply' }
  });
  assert.equal(state, 'role');
  state = progress.transitionProgressMode(state, { progressMode: 'accumulate', nativeTurn: null });
  assert.equal(state, 'role');
  assert.equal(progress.mergeReplyProgress('Draft reply', 'Final app reply'),
    'Draft reply\n\nFinal app reply');
});

test('substantial role-marked ChatGPT reply waits for repeated authoritative stability before finalizing', async () => {
  let clock = 0;
  const prompt = 'give me a structured stress reply';
  const opening = 'Opening paragraph intentionally exceeds the quick-finalization threshold so Nexus must not treat this first visible block as the complete answer. '.repeat(2).trim();
  const final = opening + '\n\nCAPTURE_OK\n\nSecond paragraph with "quotes", <angle brackets>, [square brackets], and an emoji 😈.\n\nEND_OF_RESPONSE_TEST';

  const visible = [
    normalTree(),
    normalTree({ composer: prompt, send: true }),
    normalTree({ prompt }),
    normalTree({ prompt, answer: opening }),
    normalTree({ prompt, answer: opening }),
    normalTree({ prompt, answer: opening }),
    normalTree({ prompt, answer: final, complete: true }),
    normalTree({ prompt, answer: final, complete: true }),
    normalTree({ prompt, answer: final, complete: true }),
    normalTree({ prompt, answer: final, complete: true })
  ];
  const full = [
    normalTree({ prompt, answer: opening }),
    normalTree({ prompt, answer: opening }),
    normalTree({ prompt, answer: final, complete: true }),
    normalTree({ prompt, answer: final, complete: true }),
    normalTree({ prompt, answer: final, complete: true })
  ];

  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'inspect') {
        const pool = args.includes('--hide-offscreen') ? visible : full;
        const json = pool.shift();
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
    firstPollMs: 0,
    pollMs: 0,
    settleMs: 0,
    shortReplySettleMs: 0,
    responseTimeoutMs: 60000
  });
  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'role-long-stability',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });

  assert.equal(result.text, final);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, final);
  assert.match(result.text, /CAPTURE_OK/);
  assert.match(result.text, /END_OF_RESPONSE_TEST$/);
  assert.equal(result.text.includes('Opening paragraph') && result.text.includes('Second paragraph'), true);
});


test('tool-like wording in the user prompt is never mistaken for tool activity', () => {
  const conversation = require('../app-targets/chatgpt-windows-conversation');
  const { snapshotFromInspect } = require('../app-targets/chatgpt-windows-uia');
  const prompt = 'inspect the implementation and then answer';
  const json = normalTree({ prompt, answer: 'Plain final answer.', complete: true });
  const snapshot = snapshotFromInspect({ windowInfo, json });
  const observed = conversation.responseForPrompt(snapshot, { prompt });
  assert.equal(observed.nativeTurn?.text, 'Plain final answer.');
  assert.equal(observed.activityHint, false);
  assert.equal(observed.provisional, false);
});

test('role reconstruction never appends the live composer draft to the assistant reply', () => {
  const prompt = 'exact user prompt';
  const snapshot = {
    composerSelector: 'composer',
    windowInfo,
    elements: [
      { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2 },
      { selector: 'user-text', type: 'Text', name: prompt, x: 760, y: 175, width: 340, height: 48 },
      { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said:', x: 280, y: 240, width: 1, height: 2 },
      { selector: 'assistant-text', type: 'Paragraph', name: 'Exact assistant reply.', x: 280, y: 270, width: 650, height: 90 },
      { selector: 'composer', type: 'Document', name: 'unsent native draft', x: 320, y: 790, width: 800, height: 64 }
    ]
  };
  const observed = conversation.responseForPrompt(snapshot, { prompt });
  assert.equal(observed.nativeTurn?.text, 'Exact assistant reply.');
});

test('Read aloud is completion evidence rather than live tool activity', () => {
  const conversation = require('../app-targets/chatgpt-windows-conversation');
  const { snapshotFromInspect } = require('../app-targets/chatgpt-windows-uia');
  const prompt = 'return the short acknowledgement';
  const json = normalTree({
    prompt,
    answer: 'SHORT_ACK_OK',
    complete: true,
    completeAction: 'Read aloud'
  });
  const snapshot = snapshotFromInspect({ windowInfo, json });
  const observed = conversation.responseForPrompt(snapshot, { prompt });
  assert.equal(observed.nativeTurn?.text, 'SHORT_ACK_OK');
  assert.equal(observed.nativeTurn?.completeHint, true);
  assert.equal(observed.activityHint, false);
  assert.equal(observed.provisional, false);
});

test('role response is explicitly provisional while tool activity remains below it', () => {
  const conversation = require('../app-targets/chatgpt-windows-conversation');
  const { snapshotFromInspect } = require('../app-targets/chatgpt-windows-uia');
  const prompt = 'inspect the implementation and then answer';
  const json = normalTree({
    prompt,
    answer: 'I am checking the implementation before I give you the final result.',
    status: 'Checking the implementation',
    commentaryComplete: true
  });
  const snapshot = snapshotFromInspect({ windowInfo, json });
  const observed = conversation.responseForPrompt(snapshot, { prompt });
  assert.equal(observed.provisional, true);
  assert.equal(observed.nativeTurn?.completeHint, false);
});

test('tool status metadata stays provisional even when wording is provider-specific', () => {
  const tree = normalTree({
    prompt: 'use a tool',
    answer: 'Commentary before tool work.',
    status: 'Consulting connected source',
    commentaryComplete: true
  });
  const root = tree.windows[0].elements[0];
  const status = root.children.find((entry) => entry.selector === 'tool-status');
  assert.equal(require('../app-targets/chatgpt-windows-role-turns').isToolActivityElement(
    status, (element) => element.name || ''
  ), true);
});

test('tool commentary stays provisional until the later assistant role segment arrives', async () => {
  let clock = 0;
  const prompt = 'inspect the implementation and then answer';
  const commentary = 'I am checking the implementation before I give you the final result.';
  const final = 'FINAL_CAPTURE_OK\n\nThe tool-backed answer arrived after the commentary and must replace it.';

  const visible = [
    normalTree(),
    normalTree({ composer: prompt, send: true }),
    normalTree({ prompt }),
    normalTree({ prompt, answer: commentary, status: 'Checking the implementation', commentaryComplete: true }),
    normalTree({ prompt, answer: commentary, status: 'Checking the implementation', commentaryComplete: true }),
    normalTree({ prompt, answer: commentary, status: 'Checking the implementation', commentaryComplete: true }),
    normalTree({ prompt, answer: commentary, status: 'Checking the implementation', commentaryComplete: true, followup: final, complete: true })
  ];
  const full = [
    normalTree({ prompt, answer: commentary, status: 'Checking the implementation', commentaryComplete: true }),
    normalTree({ prompt, answer: commentary, status: 'Checking the implementation', commentaryComplete: true, followup: final, complete: true })
  ];
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'inspect') {
        const pool = args.includes('--hide-offscreen') ? visible : full;
        const json = pool.length > 1 ? pool.shift() : pool[0];
        if (!json) throw new Error('Unexpected inspect');
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
    firstPollMs: 0, pollMs: 0, settleMs: 0, shortReplySettleMs: 0,
    responseTimeoutMs: 60000
  });
  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'tool-commentary-final',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  assert.equal(result.text, final);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, final);
  assert.ok(events.some((event) => event.type === 'response_partial' && event.text.includes(commentary)));
  assert.equal(events.filter((event) => event.type === 'response_final').length, 1);
});
