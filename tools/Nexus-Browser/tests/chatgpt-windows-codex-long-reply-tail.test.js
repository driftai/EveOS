'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../app-targets/chatgpt-windows');

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

test('final offscreen Codex reconstruction replaces stitched thin-sentence progress', async () => {
  let clock = 0;
  const prompt = 'THIN_SENTENCE_FINAL_TEST';
  const fullLines = [
    'One.',
    'Two words.',
    'A thin line.',
    'Still very short.',
    'This one is narrow.',
    'A little more text here.',
    'Tiny gaps should remain.',
    'Wrapped text should not split.',
    'Separate blocks should stay separate.',
    'No sentence should disappear.',
    'No blocks should merge together.',
    'The spacing must remain consistent.',
    'This line is slightly longer than the others.',
    'The opening and ending should both survive.',
    'This is the final thin sentence.'
  ];
  const expected = fullLines.join('\n\n');

  const noisyVisible = [
    'words.',
    'line.',
    'very short.',
    'one is narrow.',
    'more text here.',
    'gaps should remain.',
    'not split.',
    'blocks stay separate.',
    'sentence disappear.',
    'merge toge'
  ].join('\n\n');

  const visibleTree = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Window', name: 'ChatGPT',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'prompt', type: 'Text', name: prompt,
          x: 780, y: 160, width: 320, height: 42, children: [] },
        ...noisyVisible.split(/\n\n/).map((name, index) => ({
          selector: 'v' + index, type: 'Text', name,
          x: 330, y: 240 + index * 34, width: 420, height: 20, children: []
        })),
        { selector: 'composer', type: 'Edit', name: 'Do anything',
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };

  const fullTree = {
    windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Window', name: 'ChatGPT',
      x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'prompt', type: 'Text', name: prompt,
          x: 780, y: -180, width: 320, height: 42, isOffscreen: true, children: [] },
        ...fullLines.map((name, index) => ({
          selector: 'f' + index, type: 'Text', name,
          x: 330, y: 100 + index * 38, width: 460, height: 20,
          isOffscreen: index < 2, children: []
        })),
        { selector: 'composer', type: 'Edit', name: 'Do anything',
          x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
      ]
    }] }]
  };

  const sequence = [
    codexTree({ prompt: 'older prompt', answer: 'Older reply.' }),
    codexTree({ prompt, answer: '', send: true, composerValue: prompt }),
    visibleTree,
    visibleTree,
    ...Array(8).fill(fullTree)
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
    requestId: 'thin-sentence-final',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });

  assert.equal(result.text, expected);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, expected);
  assert.equal(result.text.split(/\n{2,}/).includes('merge toge'), false);
});


test('long Codex finalization waits for late tail paragraphs after an apparently stable body', async () => {
  let clock = 0;
  const prompt = 'LATE_TAIL_THIN_LINE_TEST';
  const lines = [
    'Remove clipped fragments.',
    'Do not merge these lines.',
    'Do not duplicate this text.',
    'Earlier content should remain.',
    'Later content should stay ordered.',
    'The full response should replace drafts.',
    'Every paragraph should appear only once.',
    'The opening must not be truncated.',
    'The ending must not overwrite the middle.',
    'This completes another thin-line test.'
  ];
  const body = lines.slice(0, 8).join('\n\n');
  const complete = lines.join('\n\n');
  const partialTree = codexTree({ prompt, answer: body });
  const fullTree = codexTree({ prompt, answer: complete });
  const sequence = [
    codexTree({ prompt: 'older prompt', answer: 'Older reply.' }),
    codexTree({ prompt, answer: '', send: true, composerValue: prompt }),
    codexTree({ prompt, answer: '' }),
    partialTree,
    partialTree,
    partialTree,
    fullTree,
    fullTree,
    fullTree,
    fullTree,
    fullTree,
    fullTree,
    fullTree
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
    now: () => { clock += 3000; return clock; },
    pollMs: 0, settleMs: 0, shortReplySettleMs: 0, responseTimeoutMs: 120000
  });
  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'late-tail-thin-line',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  assert.equal(result.text, complete);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, complete);
  assert.equal((result.text.match(/The ending must not overwrite the middle\./g) || []).length, 1);
  assert.equal((result.text.match(/This completes another thin-line test\./g) || []).length, 1);
});
