(() => {
  function create({
    state, el, setMode = () => {}, renderAll = () => {},
    connect = () => {}, disconnect = () => {}
  } = {}) {
    function snapshot() {
      return {
        version: 1,
        activeRoomId: state.activeRoomId,
        mode: document.body.dataset.bridgeMode || 'base',
        draft: el.dexPrompt?.value || '',
        scrollTop: Number(el.dexTranscript?.scrollTop || 0)
      };
    }
    function restore(value = {}) {
      if (value.activeRoomId && state.rooms.some((room) => room.id === value.activeRoomId)) {
        state.activeRoomId = value.activeRoomId;
      }
      if (typeof value.draft === 'string' && el.dexPrompt) el.dexPrompt.value = value.draft;
      setMode(value.mode === 'dex' ? 'dex' : 'base');
      renderAll();
      if (Number.isFinite(Number(value.scrollTop))) {
        requestAnimationFrame(() => { if (el.dexTranscript) el.dexTranscript.scrollTop = Number(value.scrollTop); });
      }
    }
    return { snapshot, restore, resume: connect, suspend: disconnect };
  }

  const api = { create };
  globalThis.BrowserAiBridgeDexWorkspace = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
