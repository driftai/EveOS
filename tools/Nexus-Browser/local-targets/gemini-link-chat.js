'use strict';

const { WebSocket } = require('ws');
const { portFor } = require('../runtime-config');
const { createHistoryStore, targetEvent } = require('./service-chat-common');

const TARGET_ID = 'local:gemini-link-chat:default';
const TARGET_TYPE_ID = 'provider-workspace';
const histories = createHistoryStore();
let lastStatus = { running: false, busy: false, state: 'passive', message: 'Gemini Link is not auto-started by Nexus.' };

function publicTarget() {
  return {
    id: TARGET_ID,
    targetClassId: 'local-origin',
    targetTypeId: TARGET_TYPE_ID,
    targetTypeName: 'Provider Workspace Chat',
    providerId: 'gemini-link-chat',
    providerName: 'Gemini Link',
    title: 'Gemini Link Chat',
    detail: 'Text chat through the existing Gemini Link backend, isolated from the live voice session.',
    transport: 'local-websocket',
    sessionOrigin: 'shared-service',
    capabilities: { chat: true, captureLatest: false, activity: false, searchResults: false }
  };
}

function setupMessage() {
  return {
    sessionRole: 'nexus_chat',
    setup: {
      generationConfig: { responseModalities: ['AUDIO'] },
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
    },
    outputTranscriptionEnabled: false
  };
}

function status() { return { ...lastStatus }; }

function sendPrompt({ requestId, text, target = publicTarget(), emit, WebSocketImpl = WebSocket, timeoutMs = 180000 }) {
  if (!requestId || !String(text || '').trim()) throw new Error('Gemini Link prompt is empty.');
  const wsUrl = `ws://127.0.0.1:${portFor('GEMINI_WS_PORT')}`;
  lastStatus = { running: true, busy: true, state: 'connecting' };
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(wsUrl);
    let settled = false;
    let requestSent = false;
    const timer = setTimeout(() => finish(new Error('Gemini Link chat timed out.')), timeoutMs);

    function close() { try { socket.close(); } catch {} }
    function finish(error, reply = '') {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      close();
      if (error) {
        lastStatus = { running: false, busy: false, state: 'unavailable', message: error.message };
        reject(error);
        return;
      }
      histories.complete(target.id, text, reply);
      lastStatus = { running: true, busy: false, state: 'ready' };
      resolve(reply);
    }

    socket.on('open', () => socket.send(JSON.stringify(setupMessage())));
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }
      if (message.type === 'session_ready' && !requestSent) {
        requestSent = true;
        socket.send(JSON.stringify({
          type: 'text_brain_request',
          requestId,
          text: String(text),
          history: histories.get(target.id).map((entry) => ({
            role: entry.role === 'assistant' ? 'model' : 'user', text: entry.content
          }))
        }));
        lastStatus = { running: true, busy: true, state: 'streaming' };
      } else if (message.type === 'text_brain_response' && message.requestId === requestId) {
        const reply = String(message.text || '') || 'Gemini Link completed without a visible response.';
        emit?.(targetEvent(target, requestId, 'response_partial', { text: reply }));
        emit?.(targetEvent(target, requestId, 'response_final', { text: reply }));
        finish(null, reply);
      } else if (message.type === 'text_brain_error' && message.requestId === requestId) {
        finish(new Error(message.error || 'Gemini Link chat failed.'));
      } else if (message.is_error && !requestSent) {
        finish(new Error(message.text || 'Gemini Link is unavailable.'));
      }
    });
    socket.on('error', (error) => finish(new Error(`Gemini Link is unavailable: ${error.message}`)));
    socket.on('close', () => {
      if (!settled) finish(new Error('Gemini Link closed before returning a response.'));
    });
  });
}

module.exports = {
  TARGET_ID,
  TARGET_TYPE_ID,
  publicTarget,
  setupMessage,
  status,
  sendPrompt,
  _histories: histories
};
