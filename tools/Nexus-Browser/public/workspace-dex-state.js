(() => {
  function create({
    state, el, setMode = () => {}, renderAll = () => {},
    connect = () => {}, disconnect = () => {}
  } = {}) {
    let pendingRoomId = null;
    function applyPendingRoom() {
      if (!pendingRoomId || !state.rooms.some((room) => room.id === pendingRoomId)) return false;
      state.activeRoomId = pendingRoomId;
      pendingRoomId = null;
      return true;
    }
    function snapshot() {
      return {
        version: 1,
        activeRoomId: pendingRoomId || state.activeRoomId,
        mode: document.body.dataset.bridgeMode || 'base',
        draft: el.dexPrompt?.value || '',
        scrollTop: Number(el.dexTranscript?.scrollTop || 0)
      };
    }
    function restore(value = {}) {
      pendingRoomId = typeof value.activeRoomId === 'string' ? value.activeRoomId : null;
      applyPendingRoom();
      if (typeof value.draft === 'string' && el.dexPrompt) el.dexPrompt.value = value.draft;
      setMode(value.mode === 'dex' ? 'dex' : 'base');
      renderAll();
      if (Number.isFinite(Number(value.scrollTop))) {
        requestAnimationFrame(() => { if (el.dexTranscript) el.dexTranscript.scrollTop = Number(value.scrollTop); });
      }
    }
    function afterStateSync() {
      const changed = applyPendingRoom();
      if (changed) renderAll();
      return changed;
    }
    return { snapshot, restore, afterStateSync, resume: connect, suspend: disconnect };
  }

  const api = { create };
  globalThis.BrowserAiBridgeDexWorkspace = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
