'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const { summarize } = require(path.join(__dirname, '..', 'Nexus-Browser', 'scripts', 'app-uia-info'));

const prompt = 'NOVA_CODEX_TEST_002 — Reply exactly with: NOVA_CODEX_OK_002';
const answer = 'NOVA_CODEX_OK_002';

const target = {
  hwnd: 7217254,
  pid: 120608,
  title: 'ChatGPT · verified native conversation'
};

const json = {
  windows: [{
    hwnd: 7217254,
    pid: 120608,
    title: 'ChatGPT',
    width: 526,
    height: 844,
    elements: [{
      selector: 'win-chatgpt-654d',
      type: 'Window',
      name: 'ChatGPT',
      x: 1392,
      y: 13,
      width: 526,
      height: 844,
      children: [
        {
          selector: 'user-prompt',
          type: 'Text',
          name: prompt,
          x: 1611,
          y: 198,
          width: 257,
          height: 42,
          children: []
        },
        {
          selector: 'assistant-answer',
          type: 'Text',
          name: answer,
          x: 1470,
          y: 299,
          width: 141,
          height: 20,
          children: []
        }
      ]
    }]
  }]
};

const report = summarize({
  windowInfo: target,
  json,
  contains: ['NOVA_'],
  includeOffscreen: true
});

assert.deepEqual(report.window.frame, { x: 1392, y: 13, width: 526, height: 844 });
assert.equal(report.nodes.length, 2);

const promptNode = report.nodes.find((node) => node.text === prompt);
const answerNode = report.nodes.find((node) => node.text === answer);
assert.ok(promptNode);
assert.ok(answerNode);
assert.ok(promptNode.xRatio > 0.60 && promptNode.xRatio < 0.75);
assert.ok(answerNode.xRatio > 0.20 && answerNode.xRatio < 0.40);
assert.ok(answerNode.yRatio > promptNode.yRatio);

console.log('NEXUS_APP_UIA_INFO_SMOKE_OK');
