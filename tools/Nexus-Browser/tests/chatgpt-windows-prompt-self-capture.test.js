'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromInspect } = require('../app-targets/chatgpt-windows');
const { responseForPrompt } = require('../app-targets/chatgpt-windows-conversation');

const windowInfo = {
  hwnd: 501,
  pid: 9001,
  title: 'ChatGPT',
  x: 100,
  y: 20,
  width: 1200,
  height: 900
};

const prompt = [
  'lets try this again from nexus',
  'NEXUS_RETURN_BEGIN',
  'P1: Return capture intact.',
  'P2: Unicode ✓ → λ 漢字 😈',
  'P3: DUP_OK',
  'P3: DUP_OK',
  'NEXUS_RETURN_SENTINEL_9C71AF',
  'NEXUS_RETURN_END'
].join(' ');

const expectedReply = [
  'NEXUS_RETURN_BEGIN',
  'P1: Return capture intact.',
  'P2: Unicode ✓ → λ 漢字 😈',
  'P3: DUP_OK',
  'P3: DUP_OK',
  'P4: Checking the implementation is ordinary text, not tool activity.',
  'P5: C:\\Nexus\\Test\\File.txt | a=b&c|d',
  'NEXUS_RETURN_SENTINEL_9C71AF',
  'NEXUS_RETURN_END'
].join('\n\n');

function buildSnapshot({ withAssistant = false } = {}) {
  const children = [
    { selector: 'u-role', type: 'Text', name: 'You said:', x: 280, y: 120, width: 1, height: 2, children: [] },
    { selector: 'u-full', type: 'Text', name: prompt, x: 800, y: 145, width: 390, height: 70, children: [] },
    {
      selector: 'u-quoted-false-reply',
      type: 'Text',
      name: 'NEXUS_RETURN_END NEXUS_RETURN_BEGIN  P2: Unicode ✓ → λ 漢字 😈',
      x: 300,
      y: 225,
      width: 420,
      height: 52,
      children: []
    }
  ];

  if (withAssistant) {
    children.push(
      { selector: 'a-role', type: 'Text', name: 'ChatGPT said:', x: 280, y: 320, width: 1, height: 2, children: [] },
      { selector: 'a0', type: 'Text', name: 'NEXUS_RETURN_BEGIN', x: 300, y: 345, width: 180, height: 22, children: [] },
      { selector: 'a1', type: 'Text', name: 'P1: Return capture intact.', x: 300, y: 377, width: 240, height: 22, children: [] },
      { selector: 'a2', type: 'Text', name: 'P2: Unicode ✓ → λ 漢字 😈', x: 300, y: 409, width: 260, height: 22, children: [] },
      { selector: 'a3a', type: 'Text', name: 'P3: DUP_OK', x: 300, y: 441, width: 120, height: 22, children: [] },
      { selector: 'a3b', type: 'Text', name: 'P3: DUP_OK', x: 300, y: 473, width: 120, height: 22, children: [] },
      {
        selector: 'a4',
        type: 'Text',
        name: 'P4: Checking the implementation is ordinary text, not tool activity.',
        x: 300,
        y: 505,
        width: 560,
        height: 22,
        children: []
      },
      { selector: 'a5', type: 'Text', name: 'P5: C:\\Nexus\\Test\\File.txt | a=b&c|d', x: 300, y: 537, width: 360, height: 22, children: [] },
      { selector: 'a6', type: 'Text', name: 'NEXUS_RETURN_SENTINEL_9C71AF', x: 300, y: 569, width: 280, height: 22, children: [] },
      { selector: 'a7', type: 'Text', name: 'NEXUS_RETURN_END', x: 300, y: 601, width: 180, height: 22, children: [] }
    );
  }

  return snapshotFromInspect({
    windowInfo,
    json: {
      windows: [{
        ...windowInfo,
        elements: [{
          selector: 'root',
          type: 'Pane',
          x: 100,
          y: 20,
          width: 1200,
          height: 900,
          children
        }]
      }]
    }
  });
}

test('role-owned current prompt suppresses markerless self-capture before assistant role appears', () => {
  const observed = responseForPrompt(buildSnapshot(), {
    prompt,
    baseline: new Set(),
    includeOffscreen: true
  });

  assert.equal(observed.text, '');
  assert.equal(observed.correlated, true);
  assert.equal(observed.progressMode, 'replace');
  assert.equal(observed.nativeTurn, null);
});

test('matching ChatGPT role reply becomes authoritative after quoted prompt text', () => {
  const observed = responseForPrompt(buildSnapshot({ withAssistant: true }), {
    prompt,
    baseline: new Set(),
    includeOffscreen: true
  });

  assert.equal(observed.correlated, true);
  assert.equal(observed.progressMode, 'replace');
  assert.ok(observed.nativeTurn);
  assert.equal(
    observed.text.replace(/\s+/g, ' ').trim(),
    expectedReply.replace(/\s+/g, ' ').trim()
  );
  assert.equal((observed.text.match(/P3: DUP_OK/g) || []).length, 2);
  assert.ok(observed.text.endsWith('NEXUS_RETURN_END'));
  assert.doesNotMatch(observed.text, /^NEXUS_RETURN_END NEXUS_RETURN_BEGIN/);
});