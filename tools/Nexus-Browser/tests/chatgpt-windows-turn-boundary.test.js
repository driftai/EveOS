'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromInspect } = require('../app-targets/chatgpt-windows');
const { responseForPrompt } = require('../app-targets/chatgpt-windows-conversation');

const windowInfo = {
  hwnd: 501, pid: 9001, title: 'ChatGPT',
  x: 0, y: 0, width: 1200, height: 900
};

function snapshot() {
  return snapshotFromInspect({
    windowInfo,
    json: {
      windows: [{ ...windowInfo, elements: [{
        selector: 'root', type: 'Pane', name: '',
        x: 0, y: 0, width: 1200, height: 900, children: [
          { selector: 'first-prompt', type: 'Text', name: 'test 2',
            x: 1010, y: 260, width: 70, height: 32, children: [] },
          { selector: 'later-prompt', type: 'Text', name: 'new app-local request',
            x: 810, y: 390, width: 270, height: 44, children: [] },
          { selector: 'later-answer', type: 'Paragraph', name: 'Reply to the later request only.',
            x: 340, y: 470, width: 520, height: 48, children: [] },
          { selector: 'composer', type: 'Edit', name: 'Do anything',
            x: 360, y: 790, width: 700, height: 72, isKeyboardFocusable: true, children: [] }
        ]
      }] }]
    }
  });
}

test('a later native user turn terminates an unanswered markerless request', () => {
  const observed = responseForPrompt(snapshot(), {
    prompt: 'test 2', includeOffscreen: true
  });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, '');
  assert.equal(observed.nativeTurn, null);
});

test('the later native user turn still owns its own assistant reply', () => {
  const observed = responseForPrompt(snapshot(), {
    prompt: 'new app-local request', includeOffscreen: true
  });
  assert.equal(observed.correlated, true);
  assert.equal(observed.text, 'Reply to the later request only.');
  assert.equal(observed.nativeTurn?.text, 'Reply to the later request only.');
});
