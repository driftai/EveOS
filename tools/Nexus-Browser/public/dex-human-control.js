(() => {
  // UI-only editing gate. Agent provider-control commands still run independently.
  // Never persist this flag: every new page or asset reload starts agent-managed.
  const LOCKABLE = Object.freeze([
    'dexNewRoom', 'dexRoomName', 'dexUserName', 'dexAutoRelay', 'dexMaxTurns',
    'dexSaveRoom', 'dexClearChat', 'dexDeleteRoom',
    'dexMemberClass', 'dexMemberType', 'dexMemberTarget', 'dexMemberName',
    'dexMemberRelayEnabled', 'dexAddMember', 'dexCancelMemberEdit',
    'dexStopRelay', 'dexContinueRelay'
  ]);
  const ROOM_STRUCTURE = new Set([
    'dexRoomName', 'dexUserName', 'dexAutoRelay', 'dexMaxTurns',
    'dexSaveRoom', 'dexDeleteRoom',
    'dexMemberClass', 'dexMemberType', 'dexMemberTarget', 'dexMemberName',
    'dexMemberRelayEnabled', 'dexAddMember', 'dexCancelMemberEdit'
  ]);

  function gateStatus({ unlocked = false, connected = false, controller = false,
    hasRoom = false, busy = false, receiptPending = false, messageCount = 0, editing = false } = {}) {
    const ready = unlocked && connected && controller;
    const structural = ready && hasRoom && !busy;
    return {
      ready, structural,
      allowNewRoom: ready,
      allowClear: structural && !receiptPending && messageCount > 0,
      allowStop: ready && busy,
      allowContinue: structural && !receiptPending && messageCount > 0 && !editing
    };
  }

  function createController({ panel, label, hint, toggle, controls, onRelock, onChange } = {}) {
    if (!panel || !label || !hint || !toggle || !controls) {
      throw new Error('Dex human-input mode requires its banner and control references.');
    }
    let unlocked = false;
    function isEnabled() { return unlocked; }

    function render(context = {}) {
      const status = gateStatus({ ...context, unlocked });
      panel.dataset.humanInput = unlocked ? 'enabled' : 'disabled';
      label.textContent = unlocked ? 'Human Input Enabled' : 'Agent-Only Mode';
      hint.textContent = unlocked
        ? 'Room editing and relay controls are available on the primary, connected Dex viewer. Agents remain independent.'
        : 'Agents manage room structure and controls. You can browse rooms and send messages without unlocking.';
      toggle.textContent = unlocked ? 'Return to Agent-Only Mode' : 'Enable Human Input';
      toggle.classList.toggle('is-enabled', unlocked);
      toggle.setAttribute('aria-pressed', String(unlocked));

      for (const id of LOCKABLE) {
        const element = controls[id];
        if (!element) continue;
        let allowed = status.ready;
        if (ROOM_STRUCTURE.has(id)) allowed = status.structural;
        if (id === 'dexNewRoom') allowed = status.allowNewRoom;
        if (id === 'dexClearChat') allowed = status.allowClear;
        if (id === 'dexStopRelay') allowed = status.allowStop;
        if (id === 'dexContinueRelay') allowed = status.allowContinue;
        if (id === 'dexCancelMemberEdit') allowed = allowed && context.editing === true;
        element.disabled = !allowed;
      }
      // The room list, room composer, and Send button are deliberately excluded.
      return status;
    }

    toggle.addEventListener('click', () => {
      unlocked = !unlocked;
      if (!unlocked) onRelock?.();
      onChange?.();
    });
    render();
    return { isEnabled, render };
  }

  const api = { LOCKABLE, ROOM_STRUCTURE, gateStatus, createController };
  globalThis.BrowserAiBridgeDexHumanControl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
