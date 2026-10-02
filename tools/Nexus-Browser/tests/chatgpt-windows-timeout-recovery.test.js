'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createAdapter } = require('../app-targets/chatgpt-windows');

const windowInfo = {
  hwnd: 501, pid: 9001, title: 'ChatGPT',
  x: 0, y: 0, width: 1200, height: 900
};

function tree(children) {
  return {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'root', type: 'Window', name: 'ChatGPT',
        x: 0, y: 0, width: 1200, height: 900,
        children: [
          ...children,
          {
            selector: 'compose', type: 'Edit', name: 'Do anything',
            x: 360, y: 790, width: 700, height: 72,
            isKeyboardFocusable: true, children: []
          }
        ]
      }]
    }]
  };
}

test('APP_RESPONSE_TIMEOUT recovers a complete non-generating prompt-owned reply instead of discarding it', async () => {
  let clock = 0;
  const prompt = 'LONG_TIMEOUT_RECOVERY_TEST';
  const final = [
    'Alpha. Beta line. Three clear words. Keep this intact.',
    'Preserve the spacing. Reject partial fragments.',
    'No paragraph should merge. No sentence should repeat.',
    'The first block stays first. The middle remains complete.',
    'The final block stays last.',
    'Temporary slices must disappear.',
    'The completed reply becomes authoritative.',
    'Every clean sentence appears exactly once.',
    'This is the final line of this test.'
  ].join('\n\n');

  const baseline = tree([]);
  const staged = tree([
    { selector: 'send', type: 'Button', name: 'Send',
      x: 1040, y: 800, width: 44, height: 44, children: [] }
  ]);
  const committed = tree([
    { selector: 'prompt', type: 'Text', name: prompt,
      x: 780, y: 250, width: 320, height: 42, children: [] }
  ]);
  const authoritative = tree([
    { selector: 'prompt', type: 'Text', name: prompt,
      x: 780, y: 120, width: 320, height: 42, children: [] },
    ...final.split(/\n\n/).map((name, index) => ({
      selector: 'reply-' + index, type: 'Paragraph', name,
      x: 330, y: 210 + index * 50, width: 520, height: 34, children: []
    })),
    { selector: 'timestamp', type: 'Text', name: '4:51 AM',
      x: 700, y: 700, width: 60, height: 18, children: [] }
  ]);

  const visible = [baseline, staged, committed];
  let fullCount = 0;
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'inspect') {
        if (!args.includes('--hide-offscreen')) {
          fullCount += 1;
          return { ok: true, json: authoritative, stdout: '', stderr: '' };
        }
        const json = visible.shift();
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
    responseTimeoutMs: 1
  });

  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'timeout-recovery',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });

  assert.equal(result.text, final);
  assert.equal(result.text.includes('4:51 AM'), false);
  assert.equal(fullCount, 1);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, final);
  assert.equal(events.at(-1).completenessHint, 'timeout-recovered');
  assert.equal(events.at(-1).detail.timeoutRecovered, true);
});

test('deadline recovery still fails closed while the app is actively generating', async () => {
  const { recoverAuthoritativeReply } = require('../app-targets/chatgpt-windows-timeout-recovery');
  const recovered = await recoverAuthoritativeReply({
    inspect: async () => ({ generating: true }),
    target: { windowHandle: 501, pid: 9001, title: 'ChatGPT' },
    baseline: new Set(),
    prompt: 'still working'
  });
  assert.equal(recovered, null);
});
