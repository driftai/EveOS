'use strict';

const { portFor } = require('../runtime-config');
const { createHistoryStore, sendSsePrompt } = require('./service-chat-common');

const TARGET_TYPE_ID = 'provider-workspace';
const LOCAL_MOE_ID = 'local:local-moe-chat:default';
const TLO_ID = 'local:tlo-chat:default';
const histories = createHistoryStore();
const states = new Map();

function origin(port) { return `http://127.0.0.1:${port}`; }
function localMoeOrigin() { return origin(portFor('LOCAL_MOE_HARNESS_PORT')); }
function eveosOrigin() { return origin(portFor('EVEOS_WEB_PORT')); }

function target(id, providerId, providerName, title, detail) {
  return {
    id,
    targetClassId: 'local-origin',
    targetTypeId: TARGET_TYPE_ID,
    targetTypeName: 'Provider Workspace Chat',
    providerId,
    providerName,
    title,
    detail,
    transport: 'local-http-sse',
    sessionOrigin: 'shared-service',
    capabilities: { chat: true, captureLatest: false, activity: false, searchResults: false }
  };
}

function targets() {
  return [
    target(LOCAL_MOE_ID, 'local-moe-chat', 'Local MoE', 'Local MoE Chat',
      'Private chat through the existing Local MoE Harness. Nexus never starts the model service.'),
    target(TLO_ID, 'tlo-chat', 'TLO', 'TLO Chat',
      'The same scoped TLO policy and Local MoE inference route used by Search Monitor.')
  ];
}

function ownsTarget(targetId) { return targetId === LOCAL_MOE_ID || targetId === TLO_ID; }

function status(targetId) {
  return states.get(targetId) || {
    running: false,
    busy: false,
    state: 'passive',
    message: 'The provider is passive until you send a message; services are never auto-started.'
  };
}

async function sendPrompt({ requestId, text, target: selectedTarget, emit, fetchImpl = fetch }) {
  if (!requestId || !String(text || '').trim()) throw new Error('Local provider prompt is empty.');
  const history = histories.get(selectedTarget.id);
  states.set(selectedTarget.id, { running: true, busy: true, state: 'streaming' });
  try {
    const isTlo = selectedTarget.id === TLO_ID;
    const url = isTlo
      ? `${eveosOrigin()}/api/eve-state/modular/tlo/chat/stream`
      : `${localMoeOrigin()}/api/chat/stream`;
    const body = isTlo
      ? { requestId, scopeId: 'default', message: String(text), history }
      : { message: String(text), history };
    const reply = await sendSsePrompt({
      target: selectedTarget, requestId, text, emit, url, body, fetchImpl
    });
    histories.complete(selectedTarget.id, text, reply);
    states.set(selectedTarget.id, { running: true, busy: false, state: 'ready' });
  } catch (error) {
    states.set(selectedTarget.id, {
      running: false, busy: false, state: 'unavailable', message: error.message
    });
    throw error;
  }
}

module.exports = {
  TARGET_TYPE_ID,
  LOCAL_MOE_ID,
  TLO_ID,
  listTargets: async () => targets(),
  ownsTarget,
  status,
  sendPrompt,
  _histories: histories
};
