'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromInspect } = require('../app-targets/chatgpt-windows');
const { latestAssistantReply, activeConversationTitle, conversationAnchorDigests, completedAssistantTurns,
  completedAssistantTurnForPrompt, preferExpandedReply, normalizeSyntheticFragmentBreaks } = require('../app-targets/chatgpt-windows-conversation');

test('native reply aggregation preserves multi-paragraph ChatGPT answers and ignores progress chrome', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 100, y: 20, width: 1200, height: 900 };
  const prompt = 'wait can you see the other chat?';
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'pn-root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
          { selector: 'lbl-yousaid', type: 'Text', name: 'You said', x: 300, y: 120, width: 1, height: 1, children: [] },
          { selector: 'txt-user', type: 'Text', name: prompt, x: 920, y: 140, width: 250, height: 30, children: [] },
          { selector: 'lbl-chatgptsaid', type: 'Text', name: 'ChatGPT said', x: 300, y: 210, width: 1, height: 1, children: [] },
          { selector: 'txt-a1', type: 'Text', name: 'Yeah — but not like I have the other chat window open beside me.', x: 300, y: 230, width: 560, height: 30, children: [] },
          { selector: 'txt-a2', type: 'Text', name: 'I can retrieve context from your other recent ChatGPT conversations when it is relevant.', x: 300, y: 275, width: 620, height: 42, children: [] },
          { selector: 'txt-progress', type: 'Text', name: 'ChatGPT is responding', x: 300, y: 330, width: 160, height: 20, children: [] },
          { selector: 'txt-a3', type: 'Text', name: 'I cannot literally watch the other conversation update live.', x: 300, y: 355, width: 520, height: 30, children: [] },
          { selector: 'txt-footer', type: 'Text', name: 'ChatGPT is AI and can make mistakes. Check important info.', x: 500, y: 850, width: 400, height: 18, children: [] }
        ]
      }]
    }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  const reply = latestAssistantReply(snapshot, { baseline: new Set(), prompt });
  assert.equal(reply?.partCount, 3);
  assert.equal(reply?.text, [
    'Yeah — but not like I have the other chat window open beside me.',
    'I can retrieve context from your other recent ChatGPT conversations when it is relevant.',
    'I cannot literally watch the other conversation update live.'
  ].join('\n\n'));
  assert.doesNotMatch(reply?.text || '', /ChatGPT is responding|make mistakes/);
});

test('native reply aggregation preserves accessible line breaks inside one reply node', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
          { selector: 'role', type: 'Text', name: 'ChatGPT said', x: 280, y: 200, width: 1, height: 1, children: [] },
          { selector: 'reply', type: 'Text', name: 'ONE\nTWO\nTHREE', x: 280, y: 220, width: 240, height: 70, children: [] }
        ]
      }]
    }]
  };
  const reply = latestAssistantReply(snapshotFromInspect({ windowInfo, json }));
  assert.equal(reply?.text, 'ONE\nTWO\nTHREE');
});


test('native full-reply reconstruction can include offscreen paragraphs after fast visible polling', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
          { selector: 'role', type: 'Text', name: 'ChatGPT said', x: 280, y: 120, width: 1, height: 1, children: [] },
          { selector: 'reply-a', type: 'Paragraph', name: 'ALPHA first paragraph that scrolled above the visible viewport.',
            x: 280, y: -120, width: 620, height: 70, isOffscreen: true, children: [] },
          { selector: 'reply-b', type: 'Paragraph', name: 'BETA second paragraph remains visible.',
            x: 280, y: 260, width: 520, height: 50, children: [] }
        ]
      }]
    }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  assert.equal(latestAssistantReply(snapshot)?.text, 'BETA second paragraph remains visible.');

  const expanded = latestAssistantReply(snapshot, { includeOffscreen: true });
  assert.equal(expanded?.partCount, 2);
  assert.equal(expanded?.text, [
    'ALPHA first paragraph that scrolled above the visible viewport.',
    'BETA second paragraph remains visible.'
  ].join('\n\n'));
});

test('expanded native reply replaces a visible tail only when it safely contains that tail', () => {
  const visible = 'BETA second paragraph remains visible.';
  const expanded = [
    'ALPHA first paragraph that scrolled above the visible viewport.',
    visible
  ].join('\n\n');
  assert.equal(preferExpandedReply(visible, expanded), expanded);
  assert.equal(preferExpandedReply(visible, 'UNRELATED assistant text'), visible);
  assert.equal(preferExpandedReply('', expanded), expanded);
});


test('native conversation anchors remain valid as later turns are appended', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const build = (includeLater) => snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'u1-role', type: 'Text', name: 'You said', x: 300, y: 100, width: 1, height: 1, children: [] },
        { selector: 'u1', type: 'Text', name: 'APP_ORIGIN_TEST_003 — Reply exactly with: NATIVE_EVE_OK', x: 850, y: 120, width: 280, height: 30, children: [] },
        { selector: 'a1-role', type: 'Text', name: 'ChatGPT said', x: 300, y: 170, width: 1, height: 1, children: [] },
        { selector: 'a1', type: 'Text', name: 'NATIVE_EVE_OK', x: 300, y: 190, width: 180, height: 28, children: [] },
        ...(includeLater ? [
          { selector: 'u2-role', type: 'Text', name: 'You said', x: 300, y: 250, width: 1, height: 1, children: [] },
          { selector: 'u2', type: 'Text', name: 'Another unique native prompt for the same conversation', x: 820, y: 270, width: 310, height: 30, children: [] },
          { selector: 'a2-role', type: 'Text', name: 'ChatGPT said', x: 300, y: 320, width: 1, height: 1, children: [] },
          { selector: 'a2', type: 'Text', name: 'Another unique native answer in the same conversation', x: 300, y: 340, width: 420, height: 30, children: [] }
        ] : [])
      ]
    }] }] }
  });

  const first = conversationAnchorDigests(build(false));
  const later = conversationAnchorDigests(build(true));
  assert.equal(first.length, 1);
  assert.equal(later.length, 2);
  assert.ok(later.includes(first[0]), 'bound conversation anchor must survive later messages');
  assert.match(first[0], /^[a-f0-9]{64}$/);
});

test('completed native assistant turns have stable ordered fingerprints even when text repeats', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const pair = (prefix, y) => [
    { selector: `${prefix}-u-role`, type: 'Text', name: 'You said', x: 300, y, width: 1, height: 1, children: [] },
    { selector: `${prefix}-u`, type: 'Text', name: 'repeat this exact prompt', x: 820, y: y + 20, width: 280, height: 30, children: [] },
    { selector: `${prefix}-a-role`, type: 'Text', name: 'ChatGPT said', x: 300, y: y + 60, width: 1, height: 1, children: [] },
    { selector: `${prefix}-a`, type: 'Text', name: 'same exact answer', x: 300, y: y + 80, width: 280, height: 30, children: [] }
  ];
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900,
      children: [...pair('one', 100), ...pair('two', 300)]
    }] }] }
  });
  const turns = completedAssistantTurns(snapshot);
  assert.equal(turns.length, 2);
  assert.equal(turns[0].text, 'same exact answer');
  assert.equal(turns[1].text, 'same exact answer');
  assert.match(turns[0].fingerprint, /^[a-f0-9]{64}$/);
  assert.match(turns[1].fingerprint, /^[a-f0-9]{64}$/);
  assert.notEqual(turns[0].fingerprint, turns[1].fingerprint);
});

test('native conversation identity prefers the active main header over sidebar labels', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 100, y: 20, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
          { selector: 'sidebar', type: 'Text', name: 'Projects', x: 120, y: 90, width: 90, height: 20, children: [] },
          { selector: 'chat-title', type: 'Heading', name: 'Test response', x: 330, y: 72, width: 220, height: 28, children: [] },
          { selector: 'reply', type: 'Text', name: 'hello', x: 330, y: 260, width: 200, height: 30, children: [] }
        ]
      }]
    }]
  };
  const snapshot = snapshotFromInspect({ windowInfo, json });
  assert.equal(activeConversationTitle(snapshot)?.text, 'Test response');
});


test('native conversation identity accepts the real app header when exposed as a button', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 100, y: 20, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
          { selector: 'btn-back', type: 'Button', name: 'Back', x: 112, y: 42, width: 36, height: 36, children: [] },
          { selector: 'btn-chat-title', type: 'Button', name: 'Test response', x: 310, y: 58, width: 210, height: 32,
            automationId: 'conversation-title', children: [] },
          { selector: 'btn-share', type: 'Button', name: 'Share', x: 1080, y: 58, width: 70, height: 32, children: [] },
          { selector: 'reply', type: 'Text', name: 'hello', x: 330, y: 260, width: 200, height: 30, children: [] }
        ]
      }]
    }]
  };
  const title = activeConversationTitle(snapshotFromInspect({ windowInfo, json }));
  assert.equal(title?.text, 'Test response');
  assert.equal(title?.selector, 'btn-chat-title');
});


test('synthetic UIA blank-line fragmentation is collapsed into normal readable prose', () => {
  assert.equal(normalizeSyntheticFragmentBreaks('TEST_\n\n123_\n\nOK'), 'TEST_123_OK');
  assert.equal(
    normalizeSyntheticFragmentBreaks('Good —\n\nthat’s\n\nthe\n\nsignal\n\nI\n\nwanted.'),
    'Good — that’s the signal I wanted.'
  );
});

test('semantic paragraph boundaries remain paragraphs while short accessibility fragments collapse', () => {
  const text = [
    'This is a complete first paragraph with enough semantic content to stand on its own.',
    'This is a complete second paragraph that should remain visually separate.'
  ].join('\n\n');
  assert.equal(normalizeSyntheticFragmentBreaks(text), text);
});


test('legitimate short sibling Text fragments are never dropped by substring de-duplication', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'role', type: 'Text', name: 'ChatGPT said', x: 280, y: 180, width: 1, height: 1, children: [] },
        { selector: 'p1', type: 'Text', name: 'This', x: 280, y: 210, width: 40, height: 20, children: [] },
        { selector: 'p2', type: 'Text', name: 'is', x: 324, y: 210, width: 16, height: 20, children: [] },
        { selector: 'p3', type: 'Text', name: 'a', x: 344, y: 210, width: 10, height: 20, children: [] },
        { selector: 'p4', type: 'Text', name: 'path', x: 358, y: 210, width: 34, height: 20, children: [] },
        { selector: 'p5', type: 'Text', name: 'of', x: 396, y: 210, width: 18, height: 20, children: [] },
        { selector: 'p6', type: 'Text', name: 'work.', x: 418, y: 210, width: 46, height: 20, children: [] }
      ]
    }] }] }
  });
  assert.equal(latestAssistantReply(snapshot)?.text, 'This is a path of work.');
});

test('equivalent document aggregate cannot flatten better role-group paragraph formatting', () => {
  const conversation = require('../app-targets/chatgpt-windows-conversation');
  const group = {
    parts: [
      'First complete sentence that belongs to the first paragraph.',
      'Second complete sentence that belongs to the next paragraph.'
    ],
    types: ['Text', 'Text']
  };
  const grouped = conversation.groupedMessageText(group);
  assert.match(grouped, /paragraph\.\n\nSecond/);
  const snapshot = {
    elements: [{
      type: 'Document',
      selector: 'doc',
      name: 'First complete sentence that belongs to the first paragraph. Second complete sentence that belongs to the next paragraph.'
    }]
  };
  assert.equal(conversation.expandedGroupedMessageText(snapshot, group), grouped);
});


test('native conversation identity rejects sidebar chrome and keeps the real Codex thread heading', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 100, y: 20, width: 1200, height: 900 };
  const json = {
    windows: [{
      ...windowInfo,
      elements: [{
        selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
          { selector: 'show-sidebar', type: 'Button', name: 'Show sidebar',
            x: 112, y: 42, width: 110, height: 32, children: [] },
          { selector: 'thread-title', type: 'Heading', name: 'Merger Work and Stabilization - Greet',
            x: 360, y: 58, width: 420, height: 32, children: [] },
          { selector: 'reply', type: 'Text', name: 'NOVA_CODEX_OK_005',
            x: 330, y: 260, width: 220, height: 30, children: [] }
        ]
      }]
    }]
  };
  const title = activeConversationTitle(snapshotFromInspect({ windowInfo, json }));
  assert.equal(title?.text, 'Merger Work and Stabilization - Greet');
});


test('native conversation identity ignores window controls such as Minimize', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 100, y: 20, width: 1200, height: 900 };
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
        { selector: 'window-minimize', type: 'Button', name: 'Minimize',
          x: 1180, y: 32, width: 42, height: 32, children: [] },
        { selector: 'thread-title', type: 'Heading', name: 'Merger Work and Stabilization - Greet',
          x: 360, y: 58, width: 420, height: 32, children: [] }
      ]
    }] }] }
  });
  assert.equal(activeConversationTitle(snapshot)?.text, 'Merger Work and Stabilization - Greet');
});


test('repeated inline-code text at distinct native positions is preserved twice', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const token = 'NEXUS_DUPLICATION_PROBE_X42';
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900, children: [
        { selector: 'role', type: 'Text', name: 'ChatGPT said', x: 280, y: 180, width: 1, height: 1, children: [] },
        { selector: 'p1', type: 'Text', name: 'Occurrence one:', x: 280, y: 210, width: 120, height: 20, children: [] },
        { selector: 'code-1', type: 'Text', name: token, x: 410, y: 210, width: 240, height: 20, children: [] },
        { selector: 'p2', type: 'Text', name: 'Occurrence two:', x: 280, y: 250, width: 120, height: 20, children: [] },
        { selector: 'code-2', type: 'Text', name: token, x: 410, y: 250, width: 240, height: 20, children: [] }
      ]
    }] }] }
  });
  const text = latestAssistantReply(snapshot)?.text || '';
  assert.equal((text.match(/NEXUS_DUPLICATION_PROBE_X42/g) || []).length, 2);
});

test('role expansion rejects a root document aggregate that contains the current user prompt', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };
  const prompt = 'NEXUS recursive transcript audit';
  const json = { windows: [{ ...windowInfo, elements: [{
    selector: 'RootWebArea', type: 'Document',
    name: prompt + ' OLD NEXUS LOG Good final NEXUS_INLINE_X',
    x: 0, y: 0, width: 1200, height: 900, children: [
      { selector: 'u-role', type: 'Text', name: 'You said', x: 300, y: 140, width: 1, height: 1, children: [] },
      { selector: 'u', type: 'Text', name: prompt, x: 760, y: 160, width: 330, height: 30, children: [] },
      { selector: 'a-role', type: 'Text', name: 'ChatGPT said', x: 300, y: 220, width: 1, height: 1, children: [] },
      { selector: 'a1', type: 'Text', name: 'Good final', x: 300, y: 245, width: 120, height: 20, children: [] },
      { selector: 'a2', type: 'Text', name: 'NEXUS_INLINE_X', x: 430, y: 245, width: 160, height: 20, children: [] }
    ]
  }] }] };
  const turn = completedAssistantTurnForPrompt(snapshotFromInspect({ windowInfo, json }), prompt);
  assert.equal(turn?.text, 'Good final NEXUS_INLINE_X');
  assert.doesNotMatch(turn?.text || '', /OLD NEXUS LOG|recursive transcript audit/);
});


test('native conversation identity rejects generic More action chrome', () => {
  const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 100, y: 20, width: 1200, height: 900 };
  const snapshot = snapshotFromInspect({
    windowInfo,
    json: { windows: [{ ...windowInfo, elements: [{
      selector: 'root', type: 'Pane', x: 100, y: 20, width: 1200, height: 900, children: [
        { selector: 'more', type: 'Button', name: 'More', x: 570, y: 48, width: 70, height: 30, children: [] }
      ]
    }] }] }
  });
  assert.equal(activeConversationTitle(snapshot), null);
});
