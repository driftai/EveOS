'use strict';

const { WebSocket } = require('ws');
const { portFor } = require('../runtime-config');
const { createHistoryStore, targetEvent } = require('./service-chat-common');

const TARGET_ID = 'local:gemini-link-chat:default';
const TARGET_TYPE_ID = 'provider-workspace';
const DEFAULT_TIMEOUT_MS = 180000;
const DEFAULT_LATE_REPLY_GRACE_MS = 2500;
const histories = createHistoryStore();
let lastStatus = {
  running: false,
  busy: false,
  state: 'passive',
  message: 'Gemini Link mirrors the active EveOS Gemini workspace and never starts or replaces it.'
};

function normalizeId(value) {
  return String(value || '').trim();
}

function normalizeCorrelation(input = {}, requestId = '') {
  return {
    roomId: normalizeId(input.roomId || input.room_id),
    turnId: normalizeId(input.turnId || input.turn_id || requestId),
    requestId: normalizeId(input.requestId || input.request_id || requestId),
    sourceMessageId: normalizeId(input.sourceMessageId || input.source_message_id)
  };
}

function correlationMatches(message = {}, expected = {}) {
  if (normalizeId(message.requestId || message.request_id) !== expected.requestId) return false;
  const actual = normalizeCorrelation(message.correlation || {}, message.requestId || message.request_id);
  for (const key of ['roomId', 'turnId', 'requestId', 'sourceMessageId']) {
    if (expected[key] && actual[key] !== expected[key]) return false;
  }
  return true;
}

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

function sendPrompt({
  requestId,
  text,
  target = publicTarget(),
  emit,
  correlation = {},
  WebSocketImpl = WebSocket,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  lateReplyGraceMs = DEFAULT_LATE_REPLY_GRACE_MS
}) {
  if (!requestId || !String(text || '').trim()) throw new Error('Gemini Link prompt is empty.');
  const wsUrl = `ws://127.0.0.1:${portFor('GEMINI_WS_PORT')}`;
  const expectedCorrelation = normalizeCorrelation(correlation, requestId);
  const graceMs = Math.max(0, Number(lateReplyGraceMs) || 0);
  const baseTimeoutMs = Math.max(1, Number(timeoutMs) || DEFAULT_TIMEOUT_MS);
  const totalTimeoutMs = baseTimeoutMs + graceMs;
  lastStatus = { running: true, busy: true, state: 'connecting' };
  return new Promise((resolve, reject) => {
    const socket = new WebSocketImpl(wsUrl);
    let settled = false;
    let requestSent = false;
    let textReply = '';
    let transcriptReply = '';
    let graceTimer = null;
    const finalTimer = setTimeout(() => {
      const error = new Error('Gemini Link workspace turn timed out after the late-reply grace window.');
      finish(error);
    }, totalTimeoutMs);

    if (graceMs > 0) {
      graceTimer = setTimeout(() => {
        if (settled || !requestSent) return;
        lastStatus = {
          ...lastStatus,
          running: true,
          busy: true,
          state: 'late-reply-grace'
        };
        emit?.(targetEvent(target, requestId, 'response_activity', {
          event: 'late_reply_grace',
          isGenerating: true,
          correlation: expectedCorrelation
        }));
      }, baseTimeoutMs);
    }

    function close() { try { socket.close(); } catch {} }
    function finish(error, reply = '') {
      if (settled) return;
      settled = true;
      clearTimeout(finalTimer);
      if (graceTimer) clearTimeout(graceTimer);
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
    function correlated(message) {
      return correlationMatches(message, expectedCorrelation);
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
          text: String(text),
          correlation: expectedCorrelation,
          timeoutMs: totalTimeoutMs
        }));
        lastStatus = {
          running: true,
          busy: true,
          state: 'streaming',
          workspace: message.workspace || null
        };
      } else if (message.type === 'nexus_workspace_bound' && correlated(message)) {
        lastStatus = {
          running: true,
          busy: true,
          state: 'streaming',
          workspace: message.workspace || null
        };
      } else if (message.type === 'nexus_workspace_text' && correlated(message)) {
        textReply += String(message.text || '');
        const partial = partialText();
        if (partial) emit?.(targetEvent(target, requestId, 'response_partial', {
          text: partial,
          correlation: expectedCorrelation
        }));
      } else if (message.type === 'nexus_workspace_transcription' && correlated(message)) {
        transcriptReply = String(message.text || '').trim();
        const partial = partialText();
        if (partial) emit?.(targetEvent(target, requestId, 'response_partial', {
          text: partial,
          correlation: expectedCorrelation
        }));
      } else if (message.type === 'nexus_workspace_audio' && correlated(message)) {
        if (message.audio) {
          emit?.(targetEvent(target, requestId, 'response_audio', {
            audio: String(message.audio),
            encoding: message.encoding || 'pcm_s16le',
            sampleRate: Number(message.sampleRate || 24000),
            channels: Number(message.channels || 1),
            audioOwner: 'nexus-browser',
            correlation: expectedCorrelation
          }));
        }
      } else if (message.type === 'nexus_workspace_turn_complete' && correlated(message)) {
        const reply = partialText() || 'Gemini Link completed the Live turn without a visible transcript.';
        emit?.(targetEvent(target, requestId, 'response_final', {
          text: reply,
          correlation: expectedCorrelation
        }));
        finish(null, reply);
      } else if (message.type === 'nexus_workspace_interrupted' && correlated(message)) {
        finish(new Error('Gemini Link Live turn was interrupted before completion.'));
      } else if (message.type === 'nexus_workspace_error' && correlated(message)) {
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
  DEFAULT_TIMEOUT_MS,
  DEFAULT_LATE_REPLY_GRACE_MS,
  normalizeCorrelation,
  correlationMatches,
  publicTarget,
  setupMessage,
  status,
  sendPrompt,
  _histories: histories
};