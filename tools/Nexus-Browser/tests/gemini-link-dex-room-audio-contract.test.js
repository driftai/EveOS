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

test('Dex room replay preserves every streamed Gemini PCM chunk before binding the player', () => {
  const previousDocument = global.document;
  const previousAudioApi = global.BrowserAiBridgeGeminiLinkAudio;
  const previousRoomApi = global.BrowserAiBridgeDexRoomView;
  const captured = [];

  function fakeNode(tagName = 'div') {
    return {
      tagName,
      children: [],
      className: '',
      textContent: '',
      isConnected: true,
      append(...nodes) { this.children.push(...nodes); },
      addEventListener() {},
      querySelector() { return null; }
    };
  }

  global.document = { createElement: fakeNode };
  global.BrowserAiBridgeGeminiLinkAudio = {
    attachManual(host, attachment, key) {
      captured.push({ host, attachment, key });
      return true;
    }
  };

  try {
    const modulePath = path.join(ROOT, 'tools', 'Nexus-Browser', 'public', 'dex-room-view.js');
    delete require.cache[require.resolve(modulePath)];
    const roomApi = require(modulePath);
    const room = {
      id: 'room-audio-test',
      members: [],
      messages: [{
        id: 'msg-agent-1', senderKind: 'agent', senderId: 'member-1',
        senderName: 'Marina', text: 'nya'
      }],
      finalReceipts: [{ requestId: 'dex-turn-audio-1', messageId: 'msg-agent-1' }]
    };
    const transcript = {
      scrollTop: 0,
      scrollHeight: 0,
      clientHeight: 200,
      children: [],
      replaceChildren() { this.children = []; this.scrollHeight = 0; },
      append(node) { this.children.push(node); this.scrollHeight += 40; }
    };
    const view = roomApi.createView({
      state: { rooms: [room], activeRoomId: room.id },
      el: { dexRoomList: fakeNode('section'), dexTranscript: transcript },
      protocol: { messageWrapper: (message) => message.text },
      onRoomSelect() {}
    });
    const event = (audio) => ({
      providerId: 'gemini-link-chat',
      type: 'response_audio',
      requestId: 'dex-turn-audio-1',
      audio,
      encoding: 'pcm_s16le',
      sampleRate: 24000,
      channels: 1,
      correlation: { roomId: room.id, requestId: 'dex-turn-audio-1' }
    });

    assert.equal(view.rememberRoomAudio(event('AQI=')), true);
    assert.equal(view.rememberRoomAudio(event('AwQ=')), true);
    view.renderTranscript(room);

    assert.equal(captured.length, 1);
    assert.deepEqual(captured[0].attachment.chunks, ['AQI=', 'AwQ=']);
    assert.equal(captured[0].attachment.autoplay, false);
    assert.equal(captured[0].key, 'dex:msg-agent-1');
  } finally {
    global.document = previousDocument;
    global.BrowserAiBridgeGeminiLinkAudio = previousAudioApi;
    global.BrowserAiBridgeDexRoomView = previousRoomApi;
  }
});

test('manual Gemini replay stays silent until clicked, consumes chunked attachments, and centers its glyph', () => {
  const start = audioUi.indexOf('function attachManual(');
  const end = audioUi.indexOf('\n  function handle(', start);
  assert.ok(start >= 0 && end > start, 'manual replay helper is missing');
  const manual = audioUi.slice(start, end);
  assert.doesNotMatch(manual, /schedulePcm\(/,
    'manual room replay must not schedule a second automatic PCM stream');
  assert.match(audioUi, /function manualBase64Chunks\(attachment = \{\}\)/);
  assert.match(manual, /const base64Chunks = manualBase64Chunks\(attachment\)/);
  assert.match(manual, /for \(const value of base64Chunks\)/,
    'manual replay must decode every PCM chunk from the Dex room attachment');
  assert.match(audioUi, /display:grid;place-items:center;padding:0;line-height:1;text-align:center;/);
  assert.match(audioUi, /BrowserAiBridgeGeminiLinkAudio = \{ handle, unlock, attachManual,/);
  assert.match(audioUi, /schedulePcm\(message, bytes\)/,
    'Base-mode Nexus ownership should retain its existing one-time automatic playback path');
});
