'use strict';

const serviceWorkspaceBridge = require('../service-workspace-bridge');

const TARGET_TYPE_ID = 'provider-workspace';
const LOCAL_MOE_ID = 'local:local-moe-chat:default';
const TLO_ID = 'local:tlo-chat:default';
let exclusiveTloRoute = null;

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

async function targets() {
  const result = [
    target(
      LOCAL_MOE_ID,
      'local-moe-chat',
      'Local MoE',
      'Local MoE Chat',
      'The exact Chat Sandbox already open inside Search Monitor. Nexus never creates a parallel Local MoE history.'
    )
  ];
  if (exclusiveTloRoute) {
    const routed = await exclusiveTloRoute.listTargets();
    if (routed.length > 1 || (routed[0] && routed[0].id !== TLO_ID)) {
      throw new Error('Exclusive TLO route returned an invalid canonical target set.');
    }
    if (routed[0]) result.push(routed[0]);
  } else {
    result.push(target(
      TLO_ID,
      'tlo-chat',
      'TLO',
      'TLO Chat',
      'The exact TLO conversation already open inside Search Monitor, including its scoped history and UI state.'
    ));
  }
  return result;
}

function ownsTarget(targetId) {
  return targetId === LOCAL_MOE_ID || targetId === TLO_ID;
}

function status(targetId) {
  if (targetId === TLO_ID && exclusiveTloRoute) return exclusiveTloRoute.status();
  return serviceWorkspaceBridge.snapshot(targetId);
}

async function sendPrompt(input) {
  const { requestId, text, target: selectedTarget, emit } = input;
  if (selectedTarget?.id === TLO_ID && exclusiveTloRoute) {
    return exclusiveTloRoute.sendPrompt(input);
  }
  return serviceWorkspaceBridge.sendPrompt({
    requestId,
    text,
    target: selectedTarget,
    emit
  });
}

function configureExclusiveTloRoute(route = null) {
  if (route !== null && (!route || !['listTargets', 'status', 'sendPrompt']
    .every((key) => typeof route[key] === 'function'))) {
    throw new TypeError('Exclusive TLO route is invalid.');
  }
  exclusiveTloRoute = route;
}

module.exports = {
  TARGET_TYPE_ID,
  LOCAL_MOE_ID,
  TLO_ID,
  listTargets: targets,
  ownsTarget,
  status,
  sendPrompt,
  configureExclusiveTloRoute
};
