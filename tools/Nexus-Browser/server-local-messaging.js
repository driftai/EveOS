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
  function isDexGeminiAudio(source, payload) {
    return source?.clientKind === 'dex'
      && payload?.type === 'response_audio'
      && payload?.providerId === 'gemini-link-chat';
  }
  function sendLocalEvent(targetId, source, payload) {
    safeSend(source, payload);
    const mirrorDexAudio = isDexGeminiAudio(source, payload);
    for (const peer of uiSockets) {
      if (peer === source) continue;

      // The scheduler already delivers each Dex transport event to the authoritative
      // primary Dex socket. Gemini Live audio is presentation-only state, though, so
      // passive/standby Dex viewers need the same exact correlated PCM chunks or they
      // can render the committed transcript without ever receiving its replay audio.
      // Mirror only that audio to non-primary Dex observers; do not create a second
      // playback/model path and do not duplicate the scheduler-owned primary delivery.
      if (mirrorDexAudio && peer?.clientKind === 'dex') {
        if (!dexRouting.isPrimaryDex(peer)) safeSend(peer, payload);
        continue;
      }

      if (peer.localTargetId !== targetId) continue;
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
