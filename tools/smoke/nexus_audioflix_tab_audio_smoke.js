#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..', '..');
const extension = path.join(root, 'tools', 'Nexus-Browser', 'extension');
const read = (name) => fs.readFileSync(path.join(extension, name), 'utf8');

const manifest = JSON.parse(read('manifest.json'));
for (const permission of ['activeTab', 'offscreen', 'tabCapture']) {
  assert(manifest.permissions.includes(permission), `manifest requires ${permission}`);
}
assert.equal(manifest.action?.default_popup, 'popup.html', 'main extension popup is exposed');
assert(manifest.host_permissions.includes('file:///*'), 'file mode is declared for AudioFlix slider sync');

const fileScript = manifest.content_scripts.find(entry => entry.matches?.includes('file:///*'));
assert(fileScript, 'file-mode AudioFlix bridge is registered');
assert(fileScript.js.includes('content/audioflix-tab-audio.js'), 'file-mode bridge script is loaded');
assert.equal(fileScript.all_frames, false, 'AudioFlix bridge only runs in the top frame');

const entry = read('service-worker-entry.js');
assert(entry.includes("importScripts('audioflix-tab-audio.js');"), 'service worker loads tab-audio controller');

const controller = read('audioflix-tab-audio.js');
assert(controller.includes('chrome.tabCapture.getMediaStreamId'), 'controller requests an explicit tab stream id');
assert(controller.includes("reasons: ['USER_MEDIA']"), 'offscreen document is created for user media');
assert(controller.includes('audioflix-offscreen.html'), 'controller owns an offscreen audio document');
assert(controller.includes('sender?.tab?.id'), 'page-driven gain updates are bound to their sender tab');
assert(controller.includes('tabId !== current.tabId'), 'other EveOS tabs cannot change the active captured tab gain');

const offscreen = read('audioflix-offscreen.js');
assert(offscreen.includes("chromeMediaSource: 'tab'"), 'offscreen route consumes tab capture');
assert(offscreen.includes('createMediaStreamSource'), 'captured audio becomes a Web Audio source');
assert(offscreen.includes('createGain()'), 'captured audio passes through a GainNode');
assert(offscreen.includes('context.destination'), 'captured audio is reconnected to speakers');

const content = read('content/audioflix-tab-audio.js');
assert(content.includes('.audioflix-volume-slider'), 'existing AudioFlix volume slider drives captured-tab gain');
assert(content.includes('eve.audioflix.tabAudio.setVolume'), 'slider updates reach the extension bridge');
assert(content.includes("getAttribute?.('max')"), 'slider normalization only uses an explicitly declared max');

const popup = read('popup.html');
assert(popup.includes('AudioFlix Tab Audio'), 'main extension popup contains the AudioFlix panel');
assert(popup.includes('audioToggle'), 'popup exposes explicit enable/stop control');
assert(popup.includes('audioGain'), 'popup exposes captured-tab gain');

console.log('NEXUS_AUDIOFLIX_TAB_AUDIO_SMOKE_OK');
