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
      { selector: 'reply-tail', type: 'Paragraph', name: 'BETA visible tail.', x: 280, y: 300, width: 450, height: 35, children: [] },
      { selector: 'copy-response', type: 'Button', name: 'Copy', x: 280, y: 350, width: 36, height: 28, children: [] }
    ]),
    snapshot([
      { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
      { selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] },
      { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said', x: 280, y: 210, width: 1, height: 2, children: [] },
      { selector: 'reply-tail', type: 'Paragraph', name: 'BETA visible tail.', x: 280, y: 300, width: 450, height: 35, children: [] },
      { selector: 'copy-response', type: 'Button', name: 'Copy', x: 280, y: 350, width: 36, height: 28, children: [] }
    ])
  ];
  const fullInspect = snapshot([
    { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
    { selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] },
    { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said', x: 280, y: 210, width: 1, height: 2, children: [] },
    { selector: 'reply-head', type: 'Paragraph', name: 'ALPHA offscreen beginning.', x: 280, y: -140, width: 500, height: 45, isOffscreen: true, children: [] },
    { selector: 'reply-tail', type: 'Paragraph', name: 'BETA visible tail.', x: 280, y: 300, width: 450, height: 35, children: [] },
      { selector: 'copy-response', type: 'Button', name: 'Copy', x: 280, y: 350, width: 36, height: 28, children: [] }
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


test('completed offscreen role turn replaces a damaged visible fragment authoritatively', async () => {
  let clock = 0;
  const prompt = 'tool-backed live capture';
  const damaged = 'FINAL_BEGIN backed test passed on my side. Remote eve/nexus-machine-spaces is still:';
  const fullText = [
    'TEST_FINAL_BEGIN',
    'Tool-backed test passed on my side. Remote eve/nexus-machine-spaces is still:',
    '2b04438c450f54da6b849211290a2c404dfd39a5',
    'LIVE_TOOL_CAPTURE_OK',
    'TEST_FINAL_END'
  ].join('\n\n');
  const visibleInspects = [
    snapshot([{ selector: 'old', type: 'Text', name: 'Old answer', x: 300, y: 300, width: 300, height: 30, children: [] }]),
    snapshot([
      { selector: 'old', type: 'Text', name: 'Old answer', x: 300, y: 300, width: 300, height: 30, children: [] },
      { selector: 'send', type: 'Button', name: 'Send', x: 1060, y: 800, width: 42, height: 42, children: [] }
    ]),
    snapshot([{ selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] }]),
    snapshot([
      { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
      { selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] },
      { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said', x: 280, y: 210, width: 1, height: 2, children: [] },
      { selector: 'reply-visible', type: 'Paragraph', name: damaged, x: 280, y: 250, width: 650, height: 80, children: [] },
      { selector: 'copy-response', type: 'Button', name: 'Copy', x: 280, y: 350, width: 36, height: 28, children: [] }
    ])
  ];
  const fullInspect = snapshot([
    { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
    { selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] },
    { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said', x: 280, y: 210, width: 1, height: 2, children: [] },
    { selector: 'reply-full', type: 'Paragraph', name: fullText, x: 280, y: 240, width: 650, height: 360, children: [] },
    { selector: 'copy-response', type: 'Button', name: 'Copy', x: 280, y: 620, width: 36, height: 28, children: [] }
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
    runner, platform: 'win32', sleepFn: async () => {},
    now: () => { clock += 1000; return clock; },
    firstPollMs: 0, pollMs: 0, settleMs: 0, shortReplySettleMs: 0,
    responseTimeoutMs: 30000
  });
  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'authoritative-full-role',
    text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  assert.equal(result.text, fullText);
  assert.equal(events.at(-1).type, 'response_final');
  assert.equal(events.at(-1).text, fullText);
  assert.ok(events.some((event) => event.type === 'response_partial' && event.text === damaged));
  assert.ok(events.some((event) => event.type === 'response_partial' && event.text === fullText));
  assert.equal(fullInspectCount, 1);
});


test('final role reconstruction escalates inspect depth for Chromium-style nested replies', async () => {
  let clock = 0;
  const prompt = 'deep nested final';
  const commentary = 'Testing Nexus GitHub Branch Access';
  const finalText = 'NEXUS_LIVE_TEST_BEGIN\n\nFULL_CAPTURE_CHECK_A\n\nFULL_CAPTURE_CHECK_B\n\nNEXUS_LIVE_TEST_END';
  const shallow = snapshot([
    { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
    { selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] },
    { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said', x: 280, y: 210, width: 1, height: 2, children: [] },
    { selector: 'commentary', type: 'Paragraph', name: commentary, x: 280, y: 250, width: 420, height: 40, children: [] },
    { selector: 'copy-commentary', type: 'Button', name: 'Copy', x: 280, y: 305, width: 36, height: 28, children: [] }
  ]);
  const deep = snapshot([
    { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
    { selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] },
    { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said', x: 280, y: 210, width: 1, height: 2, children: [] },
    { selector: 'final-deep', type: 'Paragraph', name: finalText, x: 280, y: 250, width: 650, height: 260, children: [] },
    { selector: 'copy-response', type: 'Button', name: 'Copy', x: 280, y: 530, width: 36, height: 28, children: [] }
  ]);
  const initial = [
    snapshot([{ selector: 'old', type: 'Text', name: 'Old answer', x: 300, y: 300, width: 300, height: 30, children: [] }]),
    snapshot([
      { selector: 'old', type: 'Text', name: 'Old answer', x: 300, y: 300, width: 300, height: 30, children: [] },
      { selector: 'send', type: 'Button', name: 'Send', x: 1060, y: 800, width: 42, height: 42, children: [] }
    ]),
    snapshot([{ selector: 'prompt', type: 'Text', name: prompt, x: 780, y: 175, width: 320, height: 30, children: [] }]),
    shallow
  ];
  const inspectDepths = [];
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'inspect') {
        const depth = Number(args[args.indexOf('--depth') + 1] || 0);
        inspectDepths.push(depth);
        if (!args.includes('--hide-offscreen')) return { ok: true, json: depth >= 32 ? deep : shallow, stdout: '', stderr: '' };
        const json = initial.shift();
        if (!json) return { ok: true, json: shallow, stdout: '', stderr: '' };
        return { ok: true, json, stdout: '', stderr: '' };
      }
      if (args[1] === 'set-value' || args[1] === 'invoke') return { ok: true, json: { ok: true }, stdout: '', stderr: '' };
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };
  const adapter = createAdapter({
    runner, platform: 'win32', sleepFn: async () => {},
    now: () => { clock += 1000; return clock; },
    firstPollMs: 0, pollMs: 0, settleMs: 0, shortReplySettleMs: 0,
    responseTimeoutMs: 30000
  });
  const events = [];
  const result = await adapter.sendPrompt({
    requestId: 'deep-role-final', text: prompt,
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });
  assert.equal(result.text, finalText);
  assert.equal(events.at(-1).text, finalText);
  assert.ok(inspectDepths.includes(32), 'authoritative finalization must inspect deeper than the polling tree');
});
