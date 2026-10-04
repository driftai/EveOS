'use strict';

const serviceWorkspaceBridge = require('../service-workspace-bridge');

const TARGET_TYPE_ID = 'provider-workspace';
const LOCAL_MOE_ID = 'local:local-moe-chat:default';
const TLO_ID = 'local:tlo-chat:default';

function target(id, providerId, providerName, title, detail) {
  return {
    id,
    targetClassId: 'local-origin',
    targetTypeId: TARGET_TYPE_ID,
    targetTypeName: 'Eve-OS Bound Chats',
    providerId,
    providerName,
    title,
    detail,
    transport: 'search-monitor-workspace',
    sessionOrigin: 'shared-search-monitor-workspace',
    capabilities: { chat: true, captureLatest: false, activity: false, searchResults: false }
  };
}

function targets() {
  return [
    target(
      LOCAL_MOE_ID,
      'local-moe-chat',
      'Local MoE',
      'Local MoE Chat',
      'The exact Chat Sandbox already open inside Search Monitor. Nexus never creates a parallel Local MoE history.'
    ),
    target(
      TLO_ID,
      'tlo-chat',
      'TLO',
      'TLO Chat',
      'The exact TLO conversation already open inside Search Monitor, including its scoped history and UI state.'
    )
  ];
}

function ownsTarget(targetId) {
  return targetId === LOCAL_MOE_ID || targetId === TLO_ID;
}

function status(targetId) {
  return serviceWorkspaceBridge.snapshot(targetId);
}

async function sendPrompt({ requestId, text, target: selectedTarget, emit }) {
  return serviceWorkspaceBridge.sendPrompt({
    requestId,
    text,
    target: selectedTarget,
    emit
  });
}

module.exports = {
  TARGET_TYPE_ID,
  LOCAL_MOE_ID,
  TLO_ID,
  listTargets: async () => targets(),
  ownsTarget,
  status,
  sendPrompt
};
