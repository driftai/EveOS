'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const conversation = require('../app-targets/chatgpt-windows-conversation');
const { snapshotFromInspect } = require('../app-targets/chatgpt-windows-uia');

const windowInfo = { hwnd: 501, pid: 9001, title: 'ChatGPT', x: 0, y: 0, width: 1200, height: 900 };

function snapshot({ statusY = 300, answerY = 350 } = {}) {
  const prompt = 'finish the relay smoke';
  const answer = 'FINAL_RELAY_CAPTURE_OK\n\nThe complete provider reply is now visible.';
  const json = { windows: [{ ...windowInfo, elements: [{
    selector: 'root', type: 'Pane', x: 0, y: 0, width: 1200, height: 900,
    children: [
      { selector: 'user-role', type: 'Text', name: 'You said:', x: 850, y: 150, width: 1, height: 2, children: [] },
      { selector: 'prompt', type: 'Text', name: prompt, x: 760, y: 175, width: 340, height: 48, children: [] },
      { selector: 'assistant-role', type: 'Text', name: 'ChatGPT said:', x: 280, y: 240, width: 1, height: 2, children: [] },
      { selector: 'tool-status', type: 'Text', name: 'Worked for 46s', automationId: 'tool-status', x: 280, y: statusY, width: 240, height: 28, children: [] },
      { selector: 'assistant-final', type: 'Paragraph', name: answer, x: 280, y: answerY, width: 650, height: 90, children: [] },
      { selector: 'composer', type: 'Document', name: 'Ask ChatGPT', automationId: 'prompt-textarea', x: 320, y: 790, width: 800, height: 64, isKeyboardFocusable: true, children: [] }
    ]
  }] }] };
  return { prompt, answer, value: snapshotFromInspect({ windowInfo, json }) };
}

test('stale tool status above a later final role reply does not keep capture provisional', () => {
  const input = snapshot({ statusY: 300, answerY: 350 });
  const observed = conversation.responseForPrompt(input.value, { prompt: input.prompt });
  assert.equal(observed.nativeTurn?.text, input.answer);
  assert.equal(observed.activityHint, false);
  assert.equal(observed.provisional, false);
});

test('tool activity below the current assistant reply still keeps capture provisional', () => {
  const input = snapshot({ statusY: 480, answerY: 350 });
  const observed = conversation.responseForPrompt(input.value, { prompt: input.prompt });
  assert.equal(observed.nativeTurn?.text, input.answer);
  assert.equal(observed.activityHint, true);
  assert.equal(observed.provisional, true);
});
