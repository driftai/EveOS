'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromInspect } = require('../app-targets/chatgpt-windows');
const { latestAssistantReply, activeConversationTitle, preferExpandedReply } = require('../app-targets/chatgpt-windows-conversation');

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
