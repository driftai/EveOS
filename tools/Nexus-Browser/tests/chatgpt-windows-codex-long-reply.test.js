'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromInspect, createAdapter } = require('../app-targets/chatgpt-windows');
const { responseForPrompt } = require('../app-targets/chatgpt-windows-conversation');
const { mergeReplyProgress } = require('../app-targets/chatgpt-windows-reply-progress');

const windowInfo = {
  hwnd: 501, pid: 9001, title: 'ChatGPT',
  x: 0, y: 0, width: 1200, height: 900
};

function codexTree({ prompt = 'test', answer = '', generating = false, send = false,
  composerValue = 'Do anything' } = {}) {
  const children = [
    { selector: 'mode-codex', type: 'Text', name: 'Codex',
      x: 160, y: 105, width: 80, height: 22, children: [] },
    { selector: 'thread-title', type: 'Heading', name: 'Merger Work and Stabilization - Greet',
      x: 385, y: 72, width: 420, height: 28, children: [] },
    { selector: 'user-prompt', type: 'Text', name: prompt,
      x: 900, y: 330, width: 180, height: 42, children: [] },
    ...(answer ? [{
      selector: 'assistant-answer', type: 'Paragraph', name: answer,
      x: 360, y: 410, width: 520, height: 120, children: []
    }] : []),
    ...(generating ? [{
      selector: 'stop', type: 'Button', name: 'Stop generating',
      x: 1040, y: 800, width: 44, height: 44, children: []
    }] : []),
    ...(send ? [{
      selector: 'send-codex', type: 'Button', name: 'Send',
      x: 1040, y: 800, width: 44, height: 44, children: []
    }] : []),
    { selector: 'compose-codex', type: 'Edit', name: composerValue,
      x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
  ];
  return {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Window', name: 'ChatGPT',
      x: 0, y: 0, width: 1200, height: 900, children
    }] }]
  };
}

test('offscreen-inclusive Codex reconstruction restores the full long reply above the viewport', () => {
  const prompt = 'Ok we made it back, try the long reply again?';
  const head = 'Yes—this is the longer Nova reply test after Eve’s App-Origin identity fix.';
  const middle = 'Nexus should keep the current Codex conversation bound throughout this response while generation continues.';
  const tail = 'If this full reply reaches Nexus intact and the target remains connected afterward, both fixes are cooperating.';
  const json = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root-window', type: 'Window', name: 'ChatGPT',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'codex-prompt', type: 'Text', name: prompt,
          x: 780, y: -260, width: 320, height: 90, isOffscreen: true, children: [] },
        { selector: 'reply-head', type: 'Paragraph', name: head,
          x: 330, y: -170, width: 540, height: 70, isOffscreen: true, children: [] },
        { selector: 'reply-middle', type: 'Paragraph', name: middle,
          x: 330, y: -70, width: 540, height: 90, isOffscreen: true, children: [] },
        { selector: 'reply-tail', type: 'Paragraph', name: tail,
          x: 330, y: 430, width: 540, height: 90, isOffscreen: false, children: [] },
        { selector: 'compose-codex', type: 'Edit', name: 'Do anything',
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  const observed = responseForPrompt(snapshot, { prompt, includeOffscreen: true });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, [head, middle, tail].join('\n\n'));
  assert.equal(observed.nativeTurn?.text, [head, middle, tail].join('\n\n'));
});

test('Codex reply progress grows monotonically across viewport slices without duplication', () => {
  const first = 'Paragraph one stays stored even after it scrolls away.';
  const second = 'Paragraph two arrives later and must append after paragraph one.';
  const third = 'Paragraph three is the final visible tail of the same reply.';
  let stored = '';
  stored = mergeReplyProgress(stored, first);
  stored = mergeReplyProgress(stored, second);
  stored = mergeReplyProgress(stored, second + '\n\n' + third);
  stored = mergeReplyProgress(stored, first);
  assert.equal(stored, [first, second, third].join('\n\n'));
});

test('active Codex long reply emits monotonic accumulated partials and finalizes the complete ordered turn', async () => {
  let clock = 0;
  const prompt = 'LONG_STORAGE_TEST';
  const first = 'Paragraph one stays stored even after it scrolls away.';
  const second = 'Paragraph two arrives later and must append after paragraph one.';
  const third = 'Paragraph three is the final visible tail of the same reply.';
  const firstTwo = [first, second].join('\n\n');
  const expected = [first, second, third].join('\n\n');
  const sequence = [
    codexTree({ prompt: 'old visible prompt', answer: 'Older Nova answer.' }),
    codexTree({ prompt, answer: '', send: true, composerValue: prompt }),
    codexTree({ prompt, answer: first, generating: true }),
    codexTree({ prompt, answer: second, generating: true }),
    codexTree({ prompt, answer: second + '\n\n' + third, generating: true }),
    codexTree({ prompt, answer: third, generating: false }),
    codexTree({ prompt, answer: third, generating: false })
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
  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'codex-monotonic-storage',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  const partials = events.filter((event) => event.type === 'response_partial').map((event) => event.text);
  assert.deepEqual(partials.slice(0, 3), [first, firstTwo, expected]);
  assert.equal(partials.some((text) => text === second), false);
  assert.equal(partials.some((text) => text === third), false);
  assert.equal(result.text, expected);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, expected);
  assert.equal((result.text.match(/Paragraph one/g) || []).length, 1);
  assert.equal((result.text.match(/Paragraph two/g) || []).length, 1);
  assert.equal((result.text.match(/Paragraph three/g) || []).length, 1);
});


test('long Codex prompt continuation fragments never become assistant reply content', () => {
  const prefix = 'From eve, [Send this to Nova Hey Nova — quick sync. I pulled the local EveOS checkout forward and preserve the working App-Origin transport.';
  const continuation = 'while the newer Codex long-reply coverage also remains green. You have 26/26 focused tests passing across normal ChatGPT, Codex markerless capture, collapsed prompts, progress chrome, and long/offscreen response reconstruction, followed by.';
  const prompt = prefix + ' ' + continuation + ' Continue from the current codebase as-is.]';
  const answer = [
    'This is the final long-response Nexus qualification for the live Nova/Codex App-Origin path.',
    'Both paragraphs should arrive once, in order, without duplicated fragments or prompt text.'
  ].join('\n\n');

  const json = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Window', name: 'ChatGPT',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'prompt-prefix', type: 'Text', name: prefix + '…',
          x: 760, y: 180, width: 330, height: 120, children: [] },
        { selector: 'prompt-continuation', type: 'Text', name: continuation,
          x: 500, y: 315, width: 500, height: 130, children: [] },
        { selector: 'show-more', type: 'Text', name: 'Show more',
          x: 920, y: 450, width: 75, height: 20, children: [] },
        { selector: 'assistant-answer', type: 'Paragraph', name: answer,
          x: 330, y: 505, width: 540, height: 150, children: [] },
        { selector: 'compose-codex', type: 'Edit', name: 'Do anything',
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };

  const snapshot = snapshotFromInspect({ windowInfo, json });
  const observed = responseForPrompt(snapshot, { prompt, includeOffscreen: true });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, answer);
  assert.equal(observed.text.includes('26/26 focused tests'), false);
  assert.equal(observed.nativeTurn?.text, answer);
});


test('plain Codex Text siblings preserve visual paragraph spacing without splitting wrapped lines', () => {
  const prompt = 'PARAGRAPH_SPACING_TEST';
  const firstLine = 'The first paragraph starts here and ends with a complete sentence.';
  const wrappedContinuation = 'This tightly stacked continuation still belongs to that first paragraph.';
  const second = 'The second paragraph is visually separated and must begin after one blank line.';
  const third = 'The third paragraph is also separated and should remain its own block.';
  const expected = [
    firstLine + ' ' + wrappedContinuation,
    second,
    third
  ].join('\n\n');

  const json = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Window', name: 'ChatGPT',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'user-prompt', type: 'Text', name: prompt,
          x: 780, y: 180, width: 320, height: 42, children: [] },
        { selector: 'reply-line-1', type: 'Text', name: firstLine,
          x: 330, y: 250, width: 540, height: 42, children: [] },
        { selector: 'reply-line-2', type: 'Text', name: wrappedContinuation,
          x: 330, y: 296, width: 520, height: 20, children: [] },
        { selector: 'reply-paragraph-2', type: 'Text', name: second,
          x: 330, y: 342, width: 540, height: 48, children: [] },
        { selector: 'reply-paragraph-3', type: 'Text', name: third,
          x: 330, y: 414, width: 540, height: 48, children: [] },
        { selector: 'compose-codex', type: 'Edit', name: 'Do anything',
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };

  const snapshot = snapshotFromInspect({ windowInfo, json });
  const observed = responseForPrompt(snapshot, { prompt, includeOffscreen: true });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, expected);
  assert.equal(observed.nativeTurn?.text, expected);
});


test('real noisy collapsed prompt fragment owns all five live Codex paragraphs', () => {
  const prompt = 'ok its working now, next is the next test, [Worked for 4m 25s YES fixed that last presentation issue too and this continues as a deliberately long prompt with enough unique words to stay safely correlated.]';
  const paragraphs = [
    'This is the paragraph-spacing qualification for the Nexus markerless Codex formatter. This opening paragraph contains several sentences that should remain together as ordinary prose even if UI Automation exposes them as multiple tightly stacked Text nodes. Nexus should join wrapped fragments with normal spaces while preserving the paragraph as a single block.',
    'This is the second paragraph. It is intentionally separated from the first by a blank line, and that separation should survive inside the captured reply itself rather than being simulated by Nexus styling.',
    'The third paragraph is another independent text block in the same assistant column. Nexus should use the meaningful vertical gap between blocks as supporting evidence that this is a new paragraph, while continuing to treat tightly wrapped lines inside this block as one continuous piece of prose.',
    'This fourth paragraph confirms that the completed reply should preserve both content and structure across the normal App-Origin result, Capture Latest, passive capture, and eventually Dex. None of those paths should need to reconstruct paragraph spacing differently after the reply has already been captured.',
    'This is the final paragraph. If Nexus displays five distinct paragraphs with exactly one blank line between each, no collapsed giant block, and no artificial line break inside the sentences, then the live formatter behavior matches the new regression coverage.'
  ];
  const realWindow = { hwnd: 3880200, pid: 95192, title: 'ChatGPT', x: 1384, y: 13, width: 534, height: 831 };
  const json = {
    windows: [{ ...realWindow, elements: [{
      selector: 'root-window', type: 'Window', name: 'ChatGPT',
      x: 1384, y: 13, width: 534, height: 831, children: [
        { selector: 'prompt-fragment', type: 'Text',
          name: 'andok its working now, next is the next test, [Worked for 4m 25s',
          x: 1605, y: -471, width: 246, height: 42, isOffscreen: true, children: [] },
        { selector: 'p1', type: 'Text', name: paragraphs[0],
          x: 1462, y: 71, width: 424, height: 134, children: [] },
        { selector: 'p2', type: 'Text', name: paragraphs[1],
          x: 1462, y: 222, width: 408, height: 65, children: [] },
        { selector: 'p3', type: 'Text', name: paragraphs[2],
          x: 1462, y: 304, width: 422, height: 111, children: [] },
        { selector: 'p4', type: 'Text', name: paragraphs[3],
          x: 1462, y: 432, width: 414, height: 111, children: [] },
        { selector: 'p5', type: 'Text', name: paragraphs[4],
          x: 1462, y: 560, width: 417, height: 88, children: [] },
        { selector: 'composer', type: 'Edit', name: 'Do anything',
          x: 1464, y: 740, width: 422, height: 44, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };
  const snapshot = snapshotFromInspect({ windowInfo: realWindow, json });
  const observed = responseForPrompt(snapshot, { prompt, includeOffscreen: true });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, paragraphs.join('\n\n'));
  assert.equal(observed.nativeTurn?.text, paragraphs.join('\n\n'));
});

test('active finalization expands a visible tail into the full noisy-fragment Codex turn', async () => {
  let clock = 0;
  const prompt = 'ok its working now, next is the next test, [Worked for 4m 25s YES fixed that last presentation issue too and this continues as a deliberately long prompt with enough unique words to stay safely correlated.]';
  const paragraphs = [
    'Opening paragraph survives even when the visible poll only retains the tail.',
    'Second paragraph remains part of the same assistant turn.',
    'Third paragraph remains ordered after the second.',
    'Fourth paragraph is restored by the offscreen-inclusive reconstruction.',
    'Final paragraph is the only paragraph visible in the fast polling snapshot.'
  ];
  const tailOnly = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Window', name: 'ChatGPT',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'tail', type: 'Text', name: paragraphs[4],
          x: 330, y: 430, width: 540, height: 48, children: [] },
        { selector: 'composer', type: 'Edit', name: 'Do anything',
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };
  const full = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Window', name: 'ChatGPT',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'prompt-fragment', type: 'Text',
          name: 'andok its working now, next is the next test, [Worked for 4m 25s',
          x: 760, y: -180, width: 330, height: 52, isOffscreen: true, children: [] },
        ...paragraphs.map((name, index) => ({
          selector: 'p' + index, type: 'Text', name,
          x: 330, y: 120 + index * 110, width: 540, height: 72,
          isOffscreen: index < 1, children: []
        })),
        { selector: 'composer', type: 'Edit', name: 'Do anything',
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };
  const sequence = [
    codexTree({ prompt: 'older prompt', answer: 'Older reply.' }),
    codexTree({ prompt, answer: '', send: true, composerValue: prompt }),
    tailOnly,
    tailOnly,
    ...Array(8).fill(full)
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
  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'real-noisy-fragment-final',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  const expected = paragraphs.join('\n\n');
  assert.equal(result.text, expected);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, expected);
  assert.equal((result.text.match(/Final paragraph/g) || []).length, 1);
});
