'use strict';

function createServerLocalMessaging({ safeSend, uiSockets, localTargets, dexRouting, getTargets }) {
  function selectedLocalTarget(ws) {
    if (!ws?.localTargetId) return null;
    return getTargets().find((target) => target.id === ws.localTargetId) || null;
  }
  function localStatusPayload(targetId) {
    return { type: 'local_target_status', targetId, status: localTargets.getLocalTargetStatus(targetId) };
  }
  function sendLocalStatus(ws, targetId = ws?.localTargetId) {
    return targetId ? safeSend(ws, localStatusPayload(targetId)) : false;
  }
  function sendLocalEvent(targetId, source, payload) {
    safeSend(source, payload);
    for (const peer of uiSockets) {
      if (peer === source || peer.localTargetId !== targetId) continue;
      if (dexRouting.allowLocalPeer(source, peer)) safeSend(peer, payload);
    }
  }
  function broadcastLocalStatus(targetId, source = null) {
    const payload = localStatusPayload(targetId);
    if (source?.clientKind === 'console') safeSend(source, payload);
    for (const peer of uiSockets) {
      if (peer === source || peer.localTargetId !== targetId || peer.clientKind !== 'console') continue;
      safeSend(peer, payload);
    }
  }
  function mirrorPromptToConsoles(targetId, source, msg, target) {
    for (const peer of uiSockets) {
      if (peer === source || peer.localTargetId !== targetId || peer.clientKind !== 'console') continue;
      safeSend(peer, {
        type: 'local_prompt_echo', requestId: msg.requestId, text: String(msg.text || ''),
        targetId, providerId: target.providerId, providerName: target.providerName
      });
    }
  }
  return { selectedLocalTarget, sendLocalStatus, sendLocalEvent, broadcastLocalStatus, mirrorPromptToConsoles };
}

module.exports = { createServerLocalMessaging };
