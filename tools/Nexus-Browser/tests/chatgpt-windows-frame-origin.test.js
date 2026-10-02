'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { snapshotFromInspect, relativeGeometry } = require('../app-targets/chatgpt-windows-uia');
const markerless = require('../app-targets/chatgpt-windows-markerless');

const target = {
  hwnd: 7217254,
  pid: 120608,
  title: 'ChatGPT · verified native conversation'
};

const prompt = 'NOVA_CODEX_TEST_002 — Reply exactly with: NOVA_CODEX_OK_002';
const answer = 'NOVA_CODEX_OK_002';

function realDumpShape() {
  return {
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
            selector: 'lbl-novacodextest00-c2b1',
            type: 'Text',
            name: prompt,
            x: 1611,
            y: 198,
            width: 257,
            height: 42,
            isOffscreen: false,
            children: []
          },
          {
            selector: 'lbl-1248am-c2b2',
            type: 'Text',
            name: '12:48 AM',
            x: 1771,
            y: 261,
            width: 51,
            height: 17,
            isOffscreen: false,
            children: []
          },
          {
            selector: 'lbl-novacodexok002-c3b9',
            type: 'Text',
            name: answer,
            x: 1470,
            y: 299,
            width: 141,
            height: 20,
            isOffscreen: false,
            children: []
          },
          {
            selector: 'txt-doanything-b4f9',
            type: 'Edit',
            name: 'Do anything',
            x: 1472,
            y: 753,
            width: 414,
            height: 44,
            isOffscreen: false,
            children: []
          }
        ]
      }]
    }]
  };
}

test('inspect root Window supplies the desktop origin when target metadata omitted x/y', () => {
  const snapshot = snapshotFromInspect({ windowInfo: target, json: realDumpShape() });
  assert.deepEqual(
    {
      x: snapshot.windowInfo.x,
      y: snapshot.windowInfo.y,
      width: snapshot.windowInfo.width,
      height: snapshot.windowInfo.height
    },
    { x: 1392, y: 13, width: 526, height: 844 }
  );

  const reply = snapshot.elements.find((element) => element.name === answer);
  const geometry = relativeGeometry(reply, snapshot.windowInfo);
  assert.ok(geometry.xRatio > 0.20 && geometry.xRatio < 0.40, geometry.xRatio);
  assert.ok(geometry.yRatio > 0.30 && geometry.yRatio < 0.45, geometry.yRatio);
});

test('real Codex dump shape produces markerless records and the exact Nova reply', () => {
  const snapshot = snapshotFromInspect({ windowInfo: target, json: realDumpShape() });
  const records = markerless.records(snapshot, { includeOffscreen: true });
  assert.ok(records.some((record) => record.text === prompt));
  assert.ok(records.some((record) => record.text === answer));

  const exact = markerless.answerAfterPrompt(snapshot, prompt, { includeOffscreen: true });
  assert.equal(exact.foundPrompt, true);
  assert.equal(exact.text, answer);
});
