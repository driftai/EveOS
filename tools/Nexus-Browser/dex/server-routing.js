function createDexServerRouting({ uiSockets, safeSend }) {
  let pendingDexSelection = null;
  let primaryDex = null;

  function isDexRequest(msg) {
    return String(msg?.requestId || '').startsWith('dex-');
  }

  function noteUiCommand(ws, msg) {
    if (ws?.clientKind !== 'dex' || msg?.type !== 'select_target') return;
    pendingDexSelection = {
      tabId: Number(msg.tabId),
      at: Date.now()
    };
  }

  function dexClient() {
    if (primaryDex && uiSockets.has(primaryDex) && primaryDex.clientKind === 'dex') return primaryDex;
    primaryDex = [...uiSockets].find((peer) => peer.clientKind === 'dex') || null;
    return primaryDex;
  }

  function registerDex(ws) {
    if (ws?.clientKind !== 'dex') return false;
    if (!dexClient()) primaryDex = ws;
    return primaryDex === ws;
  }

  function claimPrimaryDex(ws) {
    if (ws?.clientKind !== 'dex' || !uiSockets.has(ws)) return false;
    const previous = dexClient();
    if (previous === ws) {
      safeSend(ws, { type: 'dex_runtime_role', role: 'primary' });
      return true;
    }
    primaryDex = ws;
    if (previous && uiSockets.has(previous)) safeSend(previous, { type: 'dex_runtime_role', role: 'standby' });
    safeSend(ws, { type: 'dex_runtime_role', role: 'primary' });
    return true;
  }

  function unregisterDex(ws) {
    if (primaryDex !== ws) return false;
    primaryDex = null;
    const next = dexClient();
    if (next) safeSend(next, { type: 'dex_runtime_role', role: 'primary' });
    return true;
  }

  function isPrimaryDex(ws) {
    return ws?.clientKind === 'dex' && dexClient() === ws;
  }

  function sendToKind(kind, payload) {
    if (kind === 'dex') {
      const target = dexClient();
      if (target) safeSend(target, payload);
      return;
    }
    for (const peer of uiSockets) if (peer.clientKind === kind) safeSend(peer, payload);
  }

  function broadcastExtensionEvent(msg) {
    if (isDexRequest(msg)) {
      sendToKind('dex', msg);
      return;
    }

    if (msg?.type === 'target_selected' && pendingDexSelection) {
      const matches = Number(msg.target?.id) === pendingDexSelection.tabId;
      const fresh = Date.now() - pendingDexSelection.at < 10000;
      if (matches && fresh) {
        sendToKind('dex', msg);
        pendingDexSelection = null;
        return;
      }
      if (!fresh) pendingDexSelection = null;
    }

    for (const peer of uiSockets) safeSend(peer, msg);
  }

  function allowLocalPeer(source, peer) {
    if (source?.clientKind !== 'dex') return true;
    return peer?.clientKind !== 'browser';
  }

  return {
    isDexRequest,
    noteUiCommand,
    broadcastExtensionEvent,
    allowLocalPeer,
    dexClient,
    registerDex,
    claimPrimaryDex,
    unregisterDex,
    isPrimaryDex
  };
}

module.exports = { createDexServerRouting };
