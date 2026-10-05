'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const read = (...parts) => fs.readFileSync(path.join(ROOT, ...parts), 'utf8');

const uiSocket = read('tools', 'Nexus-Browser', 'public', 'ui-socket.js');
const roomView = read('tools', 'Nexus-Browser', 'public', 'dex-room-view.js');
const audioUi = read('tools', 'Nexus-Browser', 'public', 'gemini-link-audio.js');

test('Dex Gemini audio is routed to the room viewer without claiming autoplay ownership', () => {
  assert.match(uiSocket, /const GEMINI_ROOM_AUDIO_EVENT = 'nexus-gemini-link-room-audio'/);
  assert.match(uiSocket, /isGeminiAudio && clientKind === 'dex'/);
  assert.match(uiSocket, /new CustomEvent\(GEMINI_ROOM_AUDIO_EVENT, \{ detail: message \}\)/);

  const dexBranch = uiSocket.indexOf("if (isGeminiAudio && clientKind === 'dex')");
  const dexReturn = uiSocket.indexOf('            return;', dexBranch);
  const autoplayHandler = uiSocket.indexOf('BrowserAiBridgeGeminiLinkAudio?.handle?.(message)', dexBranch);
  assert.ok(dexBranch >= 0 && dexReturn > dexBranch && autoplayHandler > dexReturn,
    'Dex audio must leave through the room event before the Base-mode autoplay handler runs');
});

test('Dex room replay binds audio to the exact committed request receipt', () => {
  assert.match(roomView, /message\.providerId !== 'gemini-link-chat'/);
  assert.match(roomView, /const roomId = String\(correlation\.roomId \|\| ''\)/);
  assert.match(roomView, /const requestId = String\(message\.requestId \|\| ''\)/);
  assert.match(roomView, /correlatedRequestId !== requestId/);
  assert.match(roomView, /room\?\.finalReceipts \|\| \[\]/);
  assert.match(roomView, /entry\.messageId === message\?\.id/);
  assert.match(roomView, /roomAudio\.get\(audioKey\(room\.id, receipt\.requestId\)\)/);
  assert.match(roomView, /audioApi\.attachManual\(host, attachment, `dex:\$\{messageId\}`\)/);
  assert.match(roomView, /autoplay: false/);
});

test('manual Gemini replay stays silent until clicked and centers its play-pause glyph', () => {
  const start = audioUi.indexOf('function attachManual(');
  const end = audioUi.indexOf('\n  function handle(', start);
  assert.ok(start >= 0 && end > start, 'manual replay helper is missing');
  const manual = audioUi.slice(start, end);
  assert.doesNotMatch(manual, /schedulePcm\(/,
    'manual room replay must not schedule a second automatic PCM stream');
  assert.match(audioUi, /display:grid;place-items:center;padding:0;line-height:1;text-align:center;/);
  assert.match(audioUi, /BrowserAiBridgeGeminiLinkAudio = \{ handle, unlock, attachManual,/);
  assert.match(audioUi, /schedulePcm\(message, bytes\)/,
    'Base-mode Nexus ownership should retain its existing one-time automatic playback path');
});
