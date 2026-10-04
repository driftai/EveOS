'use strict';

const { WebSocket } = require('ws');
const { portFor } = require('../runtime-config');
const { createHistoryStore, targetEvent } = require('./service-chat-common');

const TARGET_ID = 'local:gemini-link-chat:default';
const TARGET_TYPE_ID = 'provider-workspace';
const histories = createHistoryStore();
let lastStatus = {
  running: false,
  busy: false,
  state: 'passive',
  message: 'Gemini Link mirrors the active EveOS Gemini workspace and never starts or replaces it.'
};

function publicTarget() {
  return {
    id: TARGET_ID,
    targetClassId: 'local-origin',
    targetTypeId: TARGET_TYPE_ID,
    targetTypeName: 'Eve-OS Bound Chats',
    providerId: 'gemini-link-chat',
    providerName: 'Gemini Link',
    title: 'Gemini Link Chat',
    detail: 'Port of the active EveOS Gemini Link workspace. Nexus inherits its Live session, system instruction, tools, context and agentic state.',
    transport: 'local-websocket-sidecar',
    sessionOrigin: 'eveos-bound',
    capabilities: {
      chat: true,
      audioOutput: true,
      boundWorkspace: true,
      captureLatest: false,
      activity: false,
      searchResults: false
    }
  };
}

function setupMessage() {
  // This handshake creates only the lightweight Nexus sidecar socket. The Gemini model,
  // voice, system instruction and tools remain owned by the existing EveOS Live session.
  return {
    sessionRole: 'nexus_chat',
    setup: {
      generationConfig: { responseModalities: ['AUDIO'] },
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Aoede' } } }
    },
    outputTranscriptionEnabled: true
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
    let textReply = '';
    let transcriptReply = '';
    const timer = setTimeout(() => finish(new Error('Gemini Link workspace turn timed out.')), timeoutMs);

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
    function partialText() {
      return String(transcriptReply || textReply || '');
    }

    socket.on('open', () => socket.send(JSON.stringify(setupMessage())));
    socket.on('message', (raw) => {
      let message;
      try { message = JSON.parse(String(raw)); } catch { return; }

      if (message.type === 'session_ready' && !requestSent) {
        if (message.workspace?.bound === false) {
          finish(new Error(message.workspace.message || 'Gemini Link has no active EveOS Live workspace.'));
          return;
        }
        requestSent = true;
        socket.send(JSON.stringify({
          type: 'nexus_workspace_request',
          requestId,
          text: String(text)
        }));
        lastStatus = {
          running: true,
          busy: true,
          state: 'streaming',
          workspace: message.workspace || null
        };
      } else if (message.type === 'nexus_workspace_bound' && message.requestId === requestId) {
        lastStatus = {
          running: true,
          busy: true,
          state: 'streaming',
          workspace: message.workspace || null
        };
      } else if (message.type === 'nexus_workspace_text' && message.requestId === requestId) {
        textReply += String(message.text || '');
        const partial = partialText();
        if (partial) emit?.(targetEvent(target, requestId, 'response_partial', { text: partial }));
      } else if (message.type === 'nexus_workspace_transcription' && message.requestId === requestId) {
        transcriptReply = String(message.text || '').trim();
        const partial = partialText();
        if (partial) emit?.(targetEvent(target, requestId, 'response_partial', { text: partial }));
      } else if (message.type === 'nexus_workspace_audio' && message.requestId === requestId) {
        if (message.audio) {
          emit?.(targetEvent(target, requestId, 'response_audio', {
            audio: String(message.audio),
            encoding: message.encoding || 'pcm_s16le',
            sampleRate: Number(message.sampleRate || 24000),
            channels: Number(message.channels || 1)
          }));
        }
      } else if (message.type === 'nexus_workspace_turn_complete' && message.requestId === requestId) {
        const reply = partialText() || 'Gemini Link completed the Live turn without a visible transcript.';
        emit?.(targetEvent(target, requestId, 'response_final', { text: reply }));
        finish(null, reply);
      } else if (message.type === 'nexus_workspace_interrupted' && message.requestId === requestId) {
        finish(new Error('Gemini Link Live turn was interrupted before completion.'));
      } else if (message.type === 'nexus_workspace_error'
        && (!message.requestId || message.requestId === requestId)) {
        finish(new Error(message.error || 'Gemini Link workspace request failed.'));
      } else if (message.is_error && !requestSent) {
        finish(new Error(message.text || 'Gemini Link is unavailable.'));
      }
    });
    socket.on('error', (error) => finish(new Error(`Gemini Link is unavailable: ${error.message}`)));
    socket.on('close', () => {
      if (!settled) finish(new Error('Gemini Link connector closed before the Live turn completed.'));
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
