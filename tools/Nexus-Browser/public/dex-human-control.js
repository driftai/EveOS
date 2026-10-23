(() => {
  const LOCKABLE = Object.freeze([
    'dexNewRoom', 'dexRoomName', 'dexUserName', 'dexAutoRelay', 'dexMaxTurns', 'dexMiddleAgent',
    'dexSaveRoom', 'dexClearChat', 'dexDeleteRoom',
    'dexMemberClass', 'dexMemberType', 'dexMemberTarget', 'dexMemberName',
    'dexMemberRelayEnabled', 'dexAddMember', 'dexCancelMemberEdit',
    'dexStopRelay', 'dexContinueRelay'
  ]);
  const ROOM_STRUCTURE = new Set([
    'dexRoomName', 'dexUserName', 'dexAutoRelay', 'dexMaxTurns', 'dexMiddleAgent',
    'dexSaveRoom', 'dexDeleteRoom', 'dexMemberClass', 'dexMemberType', 'dexMemberTarget',
    'dexMemberName', 'dexMemberRelayEnabled', 'dexAddMember', 'dexCancelMemberEdit'
  ]);

  function isBootstrapCandidate(rooms, room) {
    return rooms?.length === 1 && room?.name === 'Dex Room 1' && room?.userName === 'User'
      && !(room?.members || []).length && !(room?.messages || []).length;
  }
  function gateStatus({ status = 'locked', connected = false, controller = false,
    roomId = null, leaseRoomId = null, hasRoom = false, busy = false,
    receiptPending = false, messageCount = 0, editing = false } = {}) {
    const ready = status === 'active' && connected && controller && !!roomId && roomId === leaseRoomId;
    const structural = ready && hasRoom && !busy;
    return { ready, structural, allowNewRoom: ready,
      allowClear: structural && !receiptPending && messageCount > 0,
      allowStop: ready && busy,
      allowContinue: structural && !receiptPending && messageCount > 0 && !editing };
  }

  function createController({
    panel, label, hint, toggle, controls, send = () => false, uid = (prefix) => `${prefix}-${Date.now()}`,
    now = () => Date.now(), setTimer = globalThis.setTimeout, clearTimer = globalThis.clearTimeout,
    onRelock, onChange, onRoomCreated
  } = {}) {
    if (!panel || !label || !hint || !toggle || !controls)
      throw new Error('Dex human-input mode requires its banner and control references.');
    let status = 'locked', lease = null, expiryTimer = null, context = {}, serverEpoch = null;
    const creationRequests = new Set(), enableRequests = new Set(), pendingCreates = new Set();
    const requestId = (prefix) => uid(prefix);
    function clearExpiry() { if (expiryTimer != null) clearTimer?.(expiryTimer); expiryTimer = null; }
    function relock(next, detail = {}) {
      clearExpiry(); lease = null; status = next; creationRequests.clear(); enableRequests.clear(); pendingCreates.clear(); onRelock?.(); onChange?.(status, detail); render(context);
    }
    function scheduleExpiry() {
      clearExpiry();
      const delay = Date.parse(lease?.expiresAt || '') - now();
      if (!Number.isFinite(delay) || delay <= 0) return relock('expired', { code: 'DEX_HUMAN_LEASE_EXPIRED' });
      expiryTimer = setTimer?.(() => relock('expired', { code: 'DEX_HUMAN_LEASE_EXPIRED' }), Math.min(delay, 2147483647));
    }
    function accept(nextLease) {
      lease = nextLease; status = 'active'; scheduleExpiry(); onChange?.(status, { lease }); render(context);
    }
    function isEnabled() { return gateStatus({ ...context, status, leaseRoomId: lease?.roomId }).ready; }
    function authorization(operation, roomId) {
      if (!isEnabled() || lease?.roomId !== String(roomId || '') || !lease.operations?.includes(operation)) return null;
      return { token: lease.token, actorId: lease.actorId, serverEpoch: lease.serverEpoch,
        generation: lease.generation, kind: lease.kind };
    }
    function requestRoomLease() {
      if (!context.connected || !context.roomId) return relock('denied', { code: 'DEX_HUMAN_INPUT_UNAVAILABLE' });
      status = 'requesting'; render(context);
      if (!context.controller) send({ type: 'dex_request_primary', requestId: requestId('dex-primary') });
      const id = requestId('dex-human');
      enableRequests.add(id);
      if (!send({ type: 'dex_human_input_request', requestId: id, roomId: context.roomId,
        ...(context.bootstrap === true ? { bootstrap: true } : {}) })) {
        enableRequests.delete(id);
        relock('denied', { code: 'DEX_HUMAN_INPUT_DISCONNECTED' });
      }
    }
    function disable() {
      send({ type: 'dex_human_input_disable', requestId: requestId('dex-human-disable') });
      relock('locked', { code: 'DEX_HUMAN_INPUT_DISABLED' });
    }
    function createRoom() {
      if (!isEnabled()) return false;
      const id = requestId('dex-human-create'); creationRequests.add(id);
      if (send({ type: 'dex_human_input_request', requestId: id, scope: 'create' })) return true;
      creationRequests.delete(id); relock('denied', { code: 'DEX_HUMAN_INPUT_DISCONNECTED' }); return false;
    }
    function roomChanged(roomId) { if (lease?.roomId && lease.roomId !== roomId) disable(); }
    function connectionLost() {
      if (status === 'active' || status === 'requesting') relock('denied', { code: 'DEX_HUMAN_LEASE_REVOKED' });
    }
    function observeFailure(value = {}) {
      const code = value.code || value.result?.code;
      if (!String(code || '').startsWith('DEX_HUMAN_LEASE_')) return false;
      relock(code === 'DEX_HUMAN_LEASE_EXPIRED' ? 'expired' : 'denied', { code });
      return true;
    }
    function handleMessage(msg = {}) {
      if (msg.type === 'server_session') {
        if (serverEpoch && serverEpoch !== msg.id && lease) relock('expired', { code: 'DEX_HUMAN_LEASE_EPOCH_STALE' });
        serverEpoch = msg.id || serverEpoch; return false;
      }
      if (msg.type === 'dex_runtime_role' && msg.role === 'standby') {
        if (lease || status === 'requesting') relock('denied', { code: 'DEX_HUMAN_LEASE_GENERATION_STALE' });
        return false;
      }
      if (msg.type === 'dex_human_input_status') {
        if (msg.status === 'creation-authorized') {
          const expected = msg.lease?.scope?.type === 'create'
            && ((status === 'requesting' && enableRequests.delete(msg.requestId))
              || (status === 'active' && creationRequests.delete(msg.requestId)));
          if (expected) {
            const id = requestId('dex-room-create'); pendingCreates.add(id);
            if (!send({ type: 'dex_room_create', requestId: id, authorization: msg.lease })) {
              pendingCreates.delete(id); relock('denied', { code: 'DEX_HUMAN_INPUT_DISCONNECTED' });
            }
          }
        } else if (msg.status === 'active' && msg.lease
          && status === 'requesting' && msg.lease.roomId === context.roomId
          && enableRequests.delete(msg.requestId)) accept(msg.lease);
        else if ((msg.status === 'expired' || msg.status === 'denied')
          && status === 'requesting' && enableRequests.has(msg.requestId)) relock(msg.status, msg);
        // Disable already relocks locally: its late acknowledgement must not
        // invalidate a newer successful enable request.
        else if (msg.status === 'locked' && !msg.requestId
          && msg.code === 'DEX_HUMAN_LEASE_SCOPE_CHANGED'
          && msg.roomId === lease?.roomId) relock('locked', msg);
        return true;
      }
      if (msg.type === 'dex_room_create_result' && msg.ok && msg.lease) {
        if (msg.lease.roomId === msg.roomId && context.connected
            && pendingCreates.delete(msg.requestId)) { accept(msg.lease); onRoomCreated?.(msg); }
        return true;
      }
      observeFailure(msg.type === 'dex_relay_result' ? msg.result : msg);
      return false;
    }
    function render(next = {}) {
      context = { ...context, ...next };
      const current = gateStatus({ ...context, status, leaseRoomId: lease?.roomId });
      const visible = current.ready ? 'enabled' : status;
      panel.dataset.humanInput = visible === 'locked' ? 'disabled' : visible;
      label.textContent = current.ready ? 'Human Input Active'
        : status === 'requesting' ? 'Human Input Pending'
          : status === 'expired' ? 'Human Input Expired'
            : status === 'denied' ? 'Human Input Denied' : 'Agent-Only Mode';
      hint.textContent = current.ready
        ? `Server authorization is active only for this room until ${new Date(lease.expiresAt).toLocaleTimeString()}.`
        : status === 'requesting' ? 'Waiting for the server to authorize this exact controller, room, and operation set.'
          : status === 'expired' ? 'Authorization expired or the server session changed. Enable Human Input again for this room.'
            : status === 'denied' ? 'The server denied or revoked this controller authorization. Review the Dex diagnostics before retrying.'
              : 'Agents manage room structure and controls. You can browse rooms and send messages without unlocking.';
      toggle.textContent = current.ready || status === 'requesting' ? 'Return to Agent-Only Mode'
        : status === 'expired' || status === 'denied' ? 'Enable Human Input Again' : 'Enable Human Input';
      toggle.classList.toggle('is-enabled', current.ready);
      toggle.setAttribute('aria-pressed', String(current.ready));
      for (const id of LOCKABLE) {
        const element = controls[id]; if (!element) continue;
        let allowed = current.ready;
        if (ROOM_STRUCTURE.has(id)) allowed = current.structural;
        if (id === 'dexNewRoom') allowed = current.allowNewRoom;
        if (id === 'dexClearChat') allowed = current.allowClear;
        if (id === 'dexStopRelay') allowed = current.allowStop;
        if (id === 'dexContinueRelay') allowed = current.allowContinue;
        if (id === 'dexCancelMemberEdit') allowed = allowed && context.editing === true;
        element.disabled = !allowed;
      }
      return current;
    }
    toggle.addEventListener('click', () => isEnabled() || status === 'requesting' ? disable() : requestRoomLease());
    render();
    return { isEnabled, authorization, createRoom, roomChanged, connectionLost, handleMessage, render,
      status: () => status, lease: () => lease };
  }

  const api = { LOCKABLE, ROOM_STRUCTURE, gateStatus, createController, isBootstrapCandidate };
  globalThis.BrowserAiBridgeDexHumanControl = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
