(() => {
  function createController({ state, send, persist, roomMessage, renderAll, log } = {}) {
    let seq = 0;
    const requestId = () => `dex-control-${Date.now().toString(36)}-${++seq}`;

    function command(type, room, extra = {}) {
      if (!room?.id) return false;
      const ok = send?.({ type, requestId: requestId(), roomId: room.id, ...extra });
      if (!ok) log?.('Bridge socket is not connected.');
      return !!ok;
    }

    function startRelay(room, sourceMessage, budget = null) {
      if (!room?.members?.length) {
        roomMessage?.(room, 'system', null, 'Dex', 'Add at least one agent before sending to the room.');
        renderAll?.();
        return false;
      }
      if (!sourceMessage?.id) return false;
      if (sourceMessage.senderKind !== 'user') persist?.({ immediate: true });
      return command('dex_relay_start', room, {
        sourceMessageId: sourceMessage.id,
        sourceMessage: { ...sourceMessage },
        ...(budget == null ? {} : { budget })
      });
    }

    function stopRoom(room, reason = 'Stopped') {
      return command('dex_relay_stop', room, { reason });
    }

    function continueRelay(room, budget = null) {
      return command('dex_relay_continue', room, {
        ...(budget == null ? {} : { budget })
      });
    }

    function stopAllRelays(reason = 'Stopped') {
      let sent = 0;
      for (const room of state?.rooms || []) {
        if (!room?.relay?.active && !room?.relay?.waitingFor && !room?.recovery && !room?.pendingTurn) continue;
        if (stopRoom(room, reason)) sent += 1;
      }
      return sent;
    }

    function handleMessage(msg) {
      if (msg?.type !== 'dex_relay_result') return false;
      if (msg.result?.ok) return true;
      log?.(`${msg.result?.code || 'DEX_RELAY_ERROR'}: ${msg.result?.message || 'Relay command failed.'}`);
      return true;
    }

    return { startRelay, stopRoom, continueRelay, stopAllRelays, handleMessage };
  }

  const api = { createController };
  globalThis.BrowserAiBridgeDexRuntimeClient = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
