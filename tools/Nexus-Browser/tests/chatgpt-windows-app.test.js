const test = require('node:test');
const assert = require('node:assert/strict');

const {
  windowsFromEnvelope,
  pickMainWindow,
  snapshotFromInspect,
  latestResponseCandidate,
  latestCandidate,
  createAdapter
} = require('../app-targets/chatgpt-windows');

function tree({
  hwnd = 501,
  pid = 9001,
  title = 'ChatGPT',
  composer = 'Ask ChatGPT',
  text = [],
  send = false,
  stop = false
} = {}) {
  const children = [
    { elementId: 'txt-sidebar', controlType: 'Text', name: 'New chat', children: [] },
    ...text.map((value, index) => ({
      elementId: `txt-${index}`,
      controlType: 'Text',
      name: value,
      children: []
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
  if (send) children.push({ elementId: 'btn-send', controlType: 'Button', name: 'Send', children: [] });
  if (stop) children.push({ elementId: 'btn-stop', controlType: 'Button', name: 'Stop generating', children: [] });
  return {
    windows: [{
      hwnd,
      pid,
      title,
      elements: [{ elementId: 'root', controlType: 'Pane', name: '', children }]
    }]
  };
}

test('App adapter extracts and ranks the main ChatGPT window', () => {
  const windows = windowsFromEnvelope({
    windows: [
      { hwnd: 1, pid: 11, title: 'Tiny helper', width: 100, height: 80 },
      { hwnd: 2, pid: 12, title: 'ChatGPT', width: 1200, height: 800 }
    ]
  });
  assert.equal(windows.length, 2);
  assert.equal(pickMainWindow(windows).hwnd, 2);
});

test('App adapter discovers composer, Send and accessible conversation text', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT' };
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: tree({ text: ['Earlier answer'], send: true })
  });
  assert.equal(snapshot.composerSelector, 'doc-compose');
  assert.equal(snapshot.sendSelector, 'btn-send');
  assert.deepEqual(snapshot.texts, ['Earlier answer']);
  assert.equal(snapshot.generating, false);
});

test('App adapter prefers the active-chat composer over sidebar search controls', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'pn-root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
          { selector: 'txt-sidebar-search', type: 'Edit', name: 'Search', x: 30, y: 120, width: 230, height: 40, isKeyboardFocusable: true, children: [] },
          { selector: 'doc-active-compose', type: 'Document', name: '', x: 320, y: 790, width: 800, height: 64, isKeyboardFocusable: true, children: [] }
        ]
      }]
    }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  assert.equal(snapshot.composerSelector, 'doc-active-compose');
});

test('App adapter never mistakes a top navigation arrow for Send', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'pn-root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
          { selector: 'btn-back-arrow', type: 'Button', name: '', x: 18, y: 18, width: 42, height: 42, children: [] },
          { selector: 'doc-compose', type: 'Document', name: 'Ask ChatGPT', x: 320, y: 790, width: 800, height: 64, isKeyboardFocusable: true, children: [] },
          { selector: 'btn-send-arrow', type: 'Button', name: '', x: 1060, y: 800, width: 42, height: 42, children: [] }
        ]
      }]
    }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  assert.equal(snapshot.sendSelector, 'btn-send-arrow');
  assert.notEqual(snapshot.sendSelector, 'btn-back-arrow');
});

test('App adapter fails closed when only unrelated buttons are visible', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'pn-root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
          { selector: 'btn-back-arrow', type: 'Button', name: '', x: 18, y: 18, width: 42, height: 42, children: [] },
          { selector: 'btn-menu', type: 'Button', name: 'Menu', x: 70, y: 18, width: 42, height: 42, children: [] },
          { selector: 'doc-compose', type: 'Document', name: 'Ask ChatGPT', x: 320, y: 790, width: 800, height: 64, isKeyboardFocusable: true, children: [] }
        ]
      }]
    }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  assert.equal(snapshot.sendSelector, '');
});

test('App adapter recovers unnamed live composer and send arrow through typed UIA search', async () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'inspect') {
        return {
          ok: true,
          json: { windows: [{ ...windowInfo, elements: [
            { selector: 'txt-title', type: 'Text', name: 'Where should we begin?', x: 470, y: 360, width: 300, height: 40, children: [] }
          ] }] },
          stderr: '', stdout: ''
        };
      }
      if (args[1] === 'search') {
        const query = String(args[2]);
        if (['Edit', 'TextBox', 'Document'].includes(query)) {
          return {
            ok: true,
            json: { matches: [
              { selector: 'doc-compose-live', type: 'Document', name: '', x: 320, y: 790, width: 800, height: 64, isKeyboardFocusable: true }
            ] },
            stderr: '', stdout: ''
          };
        }
        if (query === 'Button') {
          return {
            ok: true,
            json: { matches: [
              { selector: 'btn-back-live', type: 'Button', name: '', x: 18, y: 18, width: 42, height: 42 },
              { selector: 'btn-send-live', type: 'Button', name: '', x: 1060, y: 800, width: 42, height: 42 }
            ] },
            stderr: '', stdout: ''
          };
        }
        return { ok: false, json: { matchCount: 0 }, stderr: '', stdout: '' };
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };
  const adapter = createAdapter({ runner, platform: 'win32' });
  const snapshot = await adapter.probeControls(windowInfo);
  assert.equal(snapshot.composerSelector, 'doc-compose-live');
  assert.equal(snapshot.sendSelector, 'btn-send-live');
  assert.equal(snapshot.recoveredComposer, true);
  assert.equal(snapshot.recoveredSend, true);
});

test('native reply extraction ignores Latest response chrome and right-aligned user bubbles', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'pn-root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
          { selector: 'txt-old', type: 'Text', name: 'Older assistant answer', x: 300, y: 300, width: 420, height: 28, children: [] },
          { selector: 'txt-user', type: 'Text', name: 'test', x: 930, y: 430, width: 150, height: 32, children: [] },
          { selector: 'txt-assistant', type: 'Text', name: 'Test received, Drift. Eve\'s here 😋', x: 300, y: 510, width: 520, height: 34, children: [] },
          { selector: 'txt-latest-status', type: 'Text', name: 'Latest response', x: 300, y: 560, width: 140, height: 22, children: [] },
          { selector: 'doc-compose', type: 'Document', name: 'Ask ChatGPT', x: 320, y: 790, width: 800, height: 64, isKeyboardFocusable: true, children: [] }
        ]
      }]
    }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  const candidate = latestResponseCandidate(snapshot, {
    baseline: new Set(['Older assistant answer']),
    prompt: 'test'
  });
  assert.equal(candidate?.text, "Test received, Drift. Eve's here 😋");
  assert.equal(snapshot.latestResponseText, "Test received, Drift. Eve's here 😋");
});

test('native reply extraction ignores the Windows app disclaimer footer', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'pn-root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
          { selector: 'txt-assistant', type: 'Text', name: 'NATIVE_EVE_OK', x: 300, y: 510, width: 160, height: 30, children: [] },
          { selector: 'txt-footer', type: 'Text', name: 'ChatGPT is AI and can make mistakes. Check important info.', x: 420, y: 820, width: 400, height: 18, children: [] },
          { selector: 'doc-compose', type: 'Document', name: 'Ask ChatGPT', x: 320, y: 790, width: 800, height: 64, isKeyboardFocusable: true, children: [] }
        ]
      }]
    }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  assert.equal(snapshot.latestResponseText, 'NATIVE_EVE_OK');
});

test('reply delta ignores baseline and the exact user prompt', () => {
  const baseline = new Set(['Old answer']);
  assert.equal(
    latestCandidate(['Old answer', 'hello from nexus', 'fresh app reply'], {
      baseline,
      prompt: 'hello from nexus'
    }),
    'fresh app reply'
  );
});

test('ChatGPT Windows adapter drives prompt into app and returns settled reply', async () => {
  let clock = 0;
  const inspectSequence = [
    tree({ text: ['Old answer'] }),
    tree({ composer: 'hello from nexus', text: ['Old answer'], send: true }),
    tree({ text: ['Old answer', 'hello from nexus'], stop: true }),
    tree({ text: ['Old answer', 'hello from nexus', 'Draft reply'], stop: true }),
    tree({ text: ['Old answer', 'hello from nexus', 'Final app reply'] }),
    tree({ text: ['Old answer', 'hello from nexus', 'Final app reply'] })
  ];
  const calls = [];
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      calls.push(args);
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
  const target = {
    id: 'app-chatgpt-windows',
    title: 'ChatGPT',
    windowHandle: 501,
    pid: 9001
  };

  const result = await adapter.sendPrompt({
    requestId: 'app-turn-1',
    text: 'hello from nexus',
    target,
    emit: (event) => events.push(event)
  });

  assert.equal(result.text, 'Final app reply');
  assert.ok(calls.some((args) => args[1] === 'set-value' && args.includes('hello from nexus')));
  assert.ok(calls.some((args) => args[1] === 'invoke' && args.includes('btn-send')
    && args.includes('--action') && args.includes('invoke')));
  assert.deepEqual(events.map((event) => event.type), [
    'prompt_accepted',
    'response_partial',
    'response_partial',
    'response_final'
  ]);
  assert.equal(events.at(-1).text, 'Final app reply');
  assert.equal(events.at(-1).targetClassId, 'app-origin');
  assert.ok(Number.isFinite(events.at(-1).detail?.adapterSettleMs));
  assert.ok(Number.isFinite(events.at(-1).detail?.totalResponseMs));
  assert.ok(Number.isFinite(events.at(-1).detail?.timeToFirstResponseMs));
  assert.ok(Number(events.at(-1).detail?.pollCount) >= 1);
});

test('ChatGPT Windows adapter uses a fast first poll and short post-generation settle', async () => {
  let clock = 0;
  const sleeps = [];
  const inspectSequence = [
    tree({ text: ['Old answer'] }),
    tree({ composer: 'speed test', text: ['Old answer'], send: true }),
    tree({ text: ['Old answer', 'speed test'], stop: true }),
    tree({ text: ['Old answer', 'speed test', 'Fast reply'], stop: true }),
    tree({ text: ['Old answer', 'speed test', 'Fast reply'] })
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
    sleepFn: async (ms) => { sleeps.push(ms); clock += ms; },
    now: () => clock,
    responseTimeoutMs: 30000
  });
  const result = await adapter.sendPrompt({
    requestId: 'app-speed-1',
    text: 'speed test',
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: () => {}
  });
  assert.equal(result.text, 'Fast reply');
  assert.equal(sleeps[0], 250);
  assert.equal(sleeps[1], 100);
  assert.ok(sleeps.slice(2).every((ms) => ms === 250));
});

test('ChatGPT Windows adapter focuses the recovered composer before keyboard fallback', async () => {
  let clock = 0, setAttempts = 0;
  const inspectSequence = [
    tree({ text: ['Old answer'] }),
    tree({ composer: 'hello fallback', text: ['Old answer'], send: true }),
    tree({ text: ['Old answer', 'hello fallback'], stop: true }),
    tree({ text: ['Old answer', 'hello fallback', 'Fallback reply'] })
  ];
  const calls = [];
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      calls.push(args);
      if (args[1] === 'inspect') {
        const json = inspectSequence.shift();
        if (!json) throw new Error('Unexpected extra inspect');
        return { ok: true, json, stderr: '', stdout: '' };
      }
      if (args[1] === 'set-value') {
        setAttempts += 1;
        return { ok: false, json: { error: { code: 'pattern_not_supported' } }, stderr: 'pattern_not_supported', stdout: '' };
      }
      if (args[1] === 'search') {
        return {
          ok: true,
          json: { matches: [{
            selector: 'doc-compose',
            type: 'Document',
            name: 'Ask ChatGPT',
            automationId: 'prompt-textarea',
            isKeyboardFocusable: true
          }] },
          stderr: '', stdout: ''
        };
      }
      if (args[1] === 'focus' || args[1] === 'send-keys' || args[1] === 'invoke') {
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
    requestId: 'app-turn-fallback',
    text: 'hello fallback',
    target: { id: 'app-chatgpt-windows', title: 'ChatGPT', windowHandle: 501, pid: 9001 },
    emit: (event) => events.push(event)
  });

  assert.equal(result.text, 'Fallback reply');
  assert.equal(setAttempts, 1);
  const focusIndex = calls.findIndex((args) => args[1] === 'focus' && args.includes('doc-compose'));
  const keysIndex = calls.findIndex((args) => args[1] === 'send-keys' && args.includes('hello fallback'));
  assert.ok(focusIndex >= 0 && keysIndex > focusIndex, 'keyboard fallback must focus ChatGPT before injecting text');
  assert.equal(events.at(-1).type, 'response_final');
});

test('ChatGPT Windows adapter advertises exact app process and active conversation identity', async () => {
  const windowInfo = { hwnd: 777, pid: 4242, title: 'ChatGPT', x: 0, y: 0, width: 1000, height: 700 };
  const runner = {
    async availability() { return { available: true, command: 'winapp.exe' }; },
    async runJson(args) {
      if (args[1] === 'list-windows') {
        return { ok: true, json: { windows: [windowInfo] }, stderr: '', stdout: '' };
      }
      if (args[1] === 'inspect') {
        return {
          ok: true,
          json: { windows: [{ ...windowInfo, elements: [{
            selector: 'root', type: 'Pane', x: 0, y: 0, width: 1000, height: 700, children: [
              { selector: 'chat-title', type: 'Heading', name: 'Native Eve Test',
                x: 180, y: 45, width: 240, height: 26, children: [] }
            ]
          }] }] },
          stderr: '', stdout: ''
        };
      }
      throw new Error('Unexpected command: ' + args.join(' '));
    }
  };
  const adapter = createAdapter({ runner, platform: 'win32' });
  const targets = await adapter.listTargets();
  assert.equal(targets.length, 1);
  assert.equal(targets[0].id, 'app-chatgpt-windows');
  assert.equal(targets[0].providerId, 'chatgpt-desktop');
  assert.equal(targets[0].transport, 'windows-uia-winapp');
  assert.equal(targets[0].concreteTargetIdentity.windowHandle, 777);
  assert.equal(targets[0].concreteTargetIdentity.conversationTitle, 'Native Eve Test');
  assert.match(targets[0].title, /Native Eve Test/);
});
