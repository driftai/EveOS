'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('Gemini Link preserves live audio and exposes replay with the shared waveform treatment', () => {
  const target = read('local-targets/gemini-link-chat.js');
  const common = read('local-targets/service-chat-common.js');
  const socket = read('public/ui-socket.js');
  const audio = read('public/gemini-link-audio.js');

  assert.match(target, /'response_audio'/);
  assert.match(target, /targetEvent\(target, requestId, 'response_audio'/);
  assert.match(common, /providerId: target\.providerId/);
  assert.match(socket, /gemini-link-audio\.js/);
  assert.match(socket, /BrowserAiBridgeGeminiLinkAudio\?\.handle/);

  // Keep the existing immediate Gemini voice stream while also retaining the same PCM
  // chunks for explicit user replay from the normal assistant message bubble.
  assert.match(audio, /schedulePcm\(message, bytes\)/);
  assert.match(audio, /state\.chunks\.push\(bytes\)/);
  assert.match(audio, /nexus-gemini-audio-player/);
  assert.match(audio, /Replay Gemini voice reply/);

  // Match Gemini Link's normal voice-player visual language: 16 live analyser bars and
  // the same purple waveform accent used by the existing Gemini audio player.
  assert.match(audio, /BAR_COUNT = 16/);
  assert.match(audio, /WAVE_ACCENT = '#b39dff'/);
  assert.match(audio, /getByteFrequencyData/);
  assert.match(audio, /requestAnimationFrame/);
});
