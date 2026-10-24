(() => {
  const protocol = globalThis.BrowserAiBridgeDexProtocol;
  const memberApi = globalThis.BrowserAiBridgeDexMembers;
  const controlApi = globalThis.BrowserAiBridgeDexProviderControl;
  const stateSyncApi = globalThis.BrowserAiBridgeDexStateSync;
  const runtimeApi = globalThis.BrowserAiBridgeDexRuntimeClient;
  const socketApi = globalThis.BrowserAiBridgeUiSocket, handoff = globalThis.BrowserAiBridgeWorkspaceHandoff;
  const dexWorkspaceApi = globalThis.BrowserAiBridgeDexWorkspace;
  const sessionPolicyApi = globalThis.BrowserAiBridgeDexSessionPolicy;
  const humanInputApi = globalThis.BrowserAiBridgeDexHumanControl;
  const roomViewApi = globalThis.BrowserAiBridgeDexRoomView;
  const hostAccessUiApi = globalThis.BrowserAiBridgeHostAccessUi;
  const relayTimingApi = globalThis.BrowserAiBridgeDexRelayTiming;
  if (!protocol || !memberApi || !controlApi || !stateSyncApi || !runtimeApi || !socketApi || !sessionPolicyApi || !humanInputApi || !roomViewApi || !hostAccessUiApi || !relayTimingApi) {
    throw new Error('Dex helpers must load before Dex Mode.');
  }
  const STORAGE_KEY = 'browser-ai-bridge.dex.rooms.v1';
  const VIEW_KEY = 'browser-ai-bridge.dex.viewer-state.v1';
  const RELOAD_REASON_KEY = 'browser-ai-bridge.dex.reload-reason.v1';
  let dexWorkspace = null;
  const relayTiming = relayTimingApi.createTracker();
  const state = {
    uiConnectionPhase: 'connecting',
    rooms: [],
    activeRoomId: null,
    tabs: [],
    providers: [],
    onlineTarget: null,
    localTargets: [], localTypes: [],
    appTargets: [], appTypes: [],
    reloading: false,
    runtimeRole: 'unknown',
  };
  const el = Object.fromEntries([
    'baseModeTab','dexModeTab','baseModePanel','dexModePanel','dexRoomList','dexNewRoom',
    'dexRoomName','dexUserName','dexAutoRelay','dexMaxTurns','dexMiddleAgent','dexSaveRoom','dexClearChat','dexDeleteRoom',
    'dexRoomStatus','dexMemberClass','dexMemberType','dexMemberTarget','dexMemberName','dexRefreshTargets',
    'dexAddMember','dexCancelMemberEdit','dexMemberRelayEnabled','dexMemberList','dexTranscript','dexPrompt','dexSend','dexStopRelay',
    'dexContinueRelay','dexDiagnostics','dexControlLabel','dexControlHint','dexHumanToggle'
  ].map((id) => [id, document.getElementById(id)]));

  const uid = (prefix) => `${prefix}-${globalThis.crypto?.randomUUID?.() || `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`}`;
  const now = () => new Date().toISOString();
  const activeRoom = () => state.rooms.find((room) => room.id === state.activeRoomId) || null;

  function defaultRoom(index = state.rooms.length + 1) {
    return {
      id: uid('room'),
      name: `Dex Room ${index}`,
      userName: 'User',
      members: [],
      messages: [],
      settings: { autoRelay: true, maxTurns: 8, contextMessages: 8, contextDefaultMessages: null, middleAgentMode: 'automatic', middleAgentMemberId: null },
      relay: { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Idle' },
      createdAt: now(),
      updatedAt: now()
    };
  }
  function normalizeRoom(room) {
    const base = defaultRoom();
    const value = { ...base, ...room };
    value.members = Array.isArray(room?.members) ? room.members : [];
    value.messages = Array.isArray(room?.messages) ? room.messages : [];
    value.settings = { ...base.settings, ...(room?.settings || {}) };
    value.settings.maxTurns = protocol.clampInt(value.settings.maxTurns, 1, protocol.MAX_RELAY_TURNS, 8);
    value.settings.contextMessages = protocol.clampInt(value.settings.contextMessages, 2, 20, 8);
    value.relay = { ...base.relay, ...(room?.relay || {}) };
    return value;
  }
  let stateSync = null, dexSocket = null, humanInput = null, providerAuthorization = null;
  const AUTHORIZED_TYPES = Object.freeze({ dex_state_put: 'state:edit', dex_room_delete: 'room:delete', dex_relay_stop: 'relay:stop', dex_relay_continue: 'relay:continue' });
  function send(payload) {
    const roomId = payload.roomId || providerAuthorization?.roomId || activeRoom()?.id || null;
    const authorization = providerAuthorization || (AUTHORIZED_TYPES[payload.type] ? humanInput?.authorization(AUTHORIZED_TYPES[payload.type], roomId) : null);
    return dexSocket?.send({ ...payload, ...(payload.type === 'dex_state_put' ? { roomId } : {}), ...(authorization ? { authorization } : {}) }) || false;
  }
  function loadRooms() {
    stateSync = stateSyncApi.createSync({
      state, storageKey: STORAGE_KEY, normalizeRoom, defaultRoom, send, now
    });
    stateSync.loadLocal();
  }
  function persist(options = {}) {
    stateSync?.persist(state.runtimeRole === 'standby' ? { ...options, remote: false } : options);
  }
  function log(message) {
    const stamp = new Date().toLocaleTimeString();
    const current = el.dexDiagnostics.textContent.trim();
    el.dexDiagnostics.textContent = `[${stamp}] ${message}\n${current}`.slice(0, 12000);
  }

  function roomMessage(room, senderKind, senderId, senderName, text, persistNow = true) {
    const message = {
      id: uid('msg'), senderKind, senderId, senderName,
      text: protocol.cleanText(text), at: now()
    };
    room.messages.push(message);
    room.updatedAt = now();
    if (persistNow) persist();
    return message;
  }

  function setMode(mode) {
    const dex = mode === 'dex';
    document.body.dataset.bridgeMode = dex ? 'dex' : 'base';
    el.baseModePanel.hidden = dex;
    el.dexModePanel.hidden = !dex;
    el.baseModeTab.classList.toggle('active', !dex);
    el.dexModeTab.classList.toggle('active', dex);
    // Switching the viewer must not stop autonomous localhost-owned relay work.
    if (dex) renderAll();
  }

  const sessionPolicy = sessionPolicyApi.createSessionPolicy({
    onSoftResync() {
      // The localhost scheduler and state snapshot remain authoritative. Never retry a
      // pending dispatch from the viewer after a lost socket.
      log('Bridge process restarted · soft Dex state/target resync.');
      send({ type: 'request_tabs' });
      send({ type: 'request_local_targets' }); send({ type: 'request_app_targets' });
    },
    onAssetChange({ revision }) {
      if (state.reloading) return;
      state.reloading = true;
      try {
        sessionStorage.setItem(VIEW_KEY, JSON.stringify({
          activeRoomId: state.activeRoomId,
          mode: document.body.dataset.bridgeMode,
          draft: el.dexPrompt.value,
          scrollTop: el.dexTranscript.scrollTop
        }));
        sessionStorage.setItem(RELOAD_REASON_KEY, 'Bridge assets changed (' + revision + '); refreshed Dex viewer scripts once.');
      } catch {}
      log('Asset revision changed · refreshing Dex viewer scripts once.');
      setTimeout(() => location.reload(), 80);
    }
  });

  function handleServerSession(id, assetRevision) {
    return sessionPolicy.observe(id, assetRevision).kind === 'asset-change';
  }

  function updateHealth(msg) {
    const tabId = Number(msg?.tabId);
    const target = state.tabs.find((tab) => Number(tab.id) === tabId && tab.providerId === msg.providerId);
    if (target) target.health = msg.health || null;
    if (state.onlineTarget && Number(state.onlineTarget.id) === tabId) state.onlineTarget.health = msg.health || null;
    renderAll();
  }

  function hostAccessUiMessage(msg) {
    return hostAccessUiApi.message(msg, { retryAction: 'retry the Dex relay' });
  }
  function handleSocketMessage(msg) {
    if (msg.type === 'dex_viewer_lease' && msg.action === 'standby') { queueMicrotask(() => { if (!dexSocket?.suspendUntil?.(Number(msg.expiresAt || 0))) log('Rejected an invalid Dex viewer standby lease.'); }); return; }
    if (humanInput?.handleMessage(msg)) return;
    if (runtime.handleMessage(msg)) return;
    if (msg.type === 'server_session') { handleServerSession(msg.id, msg.assetRevision); return; }
    if (msg.type === 'error') {
      const accessMessage = hostAccessUiMessage(msg);
      log(accessMessage || `${msg.code || 'ERROR'}: ${msg.message || 'Unknown error'}`);
      if (accessMessage) {
        const room = activeRoom();
        if (room) {
          room.relay.lastStopReason = 'Site access required';
          roomMessage(room, 'system', null, 'Dex', accessMessage);
          renderAll();
        }
      }
      return;
    }
    if (msg.type === 'dex_runtime_role') {
      state.runtimeRole = msg.role === 'standby' ? 'standby' : 'controller';
      // Standby tabs may still browse rooms; only the primary may mutate or send.
      renderAll();
      log(`Dex UI role: ${state.runtimeRole} · localhost owns relay scheduling and recovery.`);
      return;
    }
    if (msg.type === 'dex_state_snapshot') {
      const previousRoomId = state.activeRoomId;
      const result = stateSync?.applyRemote(msg.snapshot);
      if (previousRoomId && state.rooms.some((room) => room.id === previousRoomId)) {
        state.activeRoomId = previousRoomId;
      }
      dexWorkspace?.afterStateSync?.();
      // A fresh authoritative scheduler snapshot, never an open socket alone,
      // permits new dispatch after reconnect. Pending turns are not replayed.
      state.uiConnectionPhase = 'connected';
      renderAll();
      if (result?.applied) log('Dex state synchronized from localhost scheduler.');
      return;
    }
    if (msg.type === 'dex_room_delete_result') {
      memberController.clear(); log(msg.message || 'Room deleted.'); renderAll(); return;
    }
    if (msg.type === 'provider_control_request') {
      providerAuthorization = msg.authorization || null;
      let result;
      try { result = providerControl.handle(msg); if (result?.ok && controlApi.MUTATING_ACTIONS.has(String(msg.command?.action || '').trim().toLowerCase())) stateSync?.flush(); }
      finally { providerAuthorization = null; }
      send({ type: 'provider_control_result', requestId: msg.requestId, source: msg.source, result });
      return;
    }
    if (msg.type === 'provider_health_update') { updateHealth(msg); return; }
    if (msg.type === 'tabs_update') {
      state.tabs = Array.isArray(msg.tabs) ? msg.tabs.filter((tab) => tab.appMirror !== true) : [];
      if (Array.isArray(msg.providers)) state.providers = msg.providers;
      if ('target' in msg) state.onlineTarget = msg.target?.appMirror === true ? null : (msg.target || null);
      memberController.renderBuilder();
      return;
    }
    if (msg.type === 'local_targets_update') {
      state.localTargets = Array.isArray(msg.targets) ? msg.targets : [];
      memberController.renderBuilder();
      return;
    }
    if (msg.type === 'app_targets_update') {
      state.appTargets = Array.isArray(msg.targets) ? msg.targets : [];
      memberController.renderBuilder();
      return;
    }
    if (msg.type === 'target_classes_update') {
      state.localTypes = Array.isArray(msg.localTargetTypes) ? msg.localTargetTypes : [];
      state.appTypes = Array.isArray(msg.appTargetTypes) ? msg.appTargetTypes : [];
      memberController.renderBuilder();
      return;
    }
    if (msg.type === 'target_selected') {
      state.onlineTarget = msg.target || null;
      return;
    }
    if (msg.type === 'response_final') {
      const line = relayTiming.onFinal(msg);
      if (line) log(line);
      return;
    }
    if (msg.type === 'prompt_accepted') {
      const line = relayTiming.onAccepted(msg);
      if (line) log(line);
      return;
    }
    if (msg.type === 'dex_scheduler_event') {
      log(`Localhost scheduler: ${msg.event || 'event'}${msg.memberId ? ` · ${msg.memberId}` : ''}.`);
    }
  }

  function connectSocket() {
    const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
    dexSocket = socketApi.createClient({
      url: `${scheme}://${location.host}/ws`,
      hello: { type: 'hello', role: 'ui', clientKind: 'dex' },
      onMessage: handleSocketMessage,
      onOpen: () => {
        state.uiConnectionPhase = 'resyncing';
        renderAll();
        send({ type: 'request_tabs' });
        send({ type: 'request_local_targets' }); send({ type: 'request_app_targets' });
        log('Dex transport connected; awaiting localhost scheduler snapshot.');
      },
      onMalformed: (error) => log(`Bad Dex bridge event: ${error.message}`),
      onPhase: ({ phase, closeCode, closeReason }) => {
        const previous = state.uiConnectionPhase;
        state.uiConnectionPhase = phase;
        if (phase === 'reconnecting' || phase === 'disconnected') humanInput?.connectionLost();
        renderAll();
        if (phase === 'reconnecting' && previous === 'connected') {
          log(`Dex viewer/controller reconnecting · code ${closeCode ?? '?'}${closeReason ? ` · ${closeReason}` : ''}; relay controls paused.`);
        }
        if (phase === 'disconnected') log('Dex viewer/controller disconnected; retrying in background.');
      }
    });
    dexSocket.connect();
  }
  humanInput = humanInputApi.createController({
    panel: el.dexModePanel,
    label: el.dexControlLabel,
    hint: el.dexControlHint,
    toggle: el.dexHumanToggle,
    controls: el,
    onRelock: () => memberController.clear(),
    send, uid,
    onRoomCreated: ({ snapshot, roomId }) => { stateSync?.applyRemote(snapshot); state.activeRoomId = roomId; memberController.clear(); renderAll(); }
  });
  const canHumanEdit = () => humanInput.isEnabled() && state.runtimeRole === 'controller' && state.uiConnectionPhase === 'connected';

  const memberController = memberApi.createController({
    state, el, protocol, activeRoom, persist, log, renderAll, uid,
    canHumanEdit
  });
  const runtime = runtimeApi.createController({
    state, send, persist, roomMessage, renderAll, log
  });
  const providerControl = controlApi.createController({
    state,
    roomMessage,
    startRelay: runtime.startRelay,
    stopRoom: runtime.stopRoom,
    persist,
    renderAll,
    log,
    createRoom: defaultRoom,
    uid
  });

  const roomView = roomViewApi.createView({
    state, el, protocol,
    onRoomSelect(room) {
      memberController.clear();
      humanInput.roomChanged(room.id);
      state.activeRoomId = room.id;
      renderAll();
    }
  });

  function renderAll() {
    const room = activeRoom();
    roomView.renderRooms();
    if (!room) {
      humanInput.render({ connected: false, controller: false, hasRoom: false, roomId: null });
      return;
    }
    const uiConnected = state.uiConnectionPhase === 'connected';
    const connectionSuffix = uiConnected ? '' : ` · Nexus ${state.uiConnectionPhase}`;
    el.dexRoomName.value = room.name;
    el.dexUserName.value = room.userName;
    el.dexAutoRelay.checked = !!room.settings.autoRelay;
    el.dexMaxTurns.value = room.settings.maxTurns;
    el.dexMiddleAgent.replaceChildren(...[['automatic','Automatic (sole eligible agent)'], ['disabled','Disabled'], ...(room.members || []).filter(member => member.relayEnabled !== false).map(member => [member.id, `${member.name} · ${member.binding?.providerName || member.binding?.providerId || 'provider'}`])].map(([value, label]) => new Option(label, value)));
    el.dexMiddleAgent.value = room.settings.middleAgentMode === 'disabled' ? 'disabled' : room.settings.middleAgentMemberId || 'automatic';
    const budgetLabel = ` · ${room.relay.scheduledTurns ?? '?'} / ${room.relay.turnBudgetTotal ?? '?'} scheduled · ${room.relay.remaining || 0} left${room.recovery ? ` · ${room.recovery.relayRemaining || 0} held in capture-only recovery${room.recovery.promptSendFailure?.attentionAtMs ? ' · inspect exact bound tab; do not resend' : ''}` : ''}`;
    const receiptPending = controlApi.roomHasPendingControlReceipt(state, room);
    el.dexRoomStatus.textContent = room.relay.active
      ? `Relay running on localhost${budgetLabel}${room.relay.waitingFor ? ' · waiting for agent' : ''}${connectionSuffix}`
      : `Relay stopped · ${room.relay.lastStopReason || 'Idle'}${budgetLabel}${receiptPending ? ' · unresolved provider receipt preserved; editing available' : ''}${connectionSuffix}`;
    memberController.render(room);
    roomView.renderTranscript(room);
    const editing = memberController.isEditing();
    const busy = controlApi.roomBusy(state, room), executionBusy = controlApi.roomExecutionBusy(state, room);
    el.dexSend.disabled = !uiConnected || state.runtimeRole !== 'controller'
      || !room.members.length || busy || editing;
    humanInput.render({
      connected: uiConnected,
      controller: state.runtimeRole === 'controller',
      roomId: room.id, bootstrap: humanInputApi.isBootstrapCandidate(state.rooms, room),
      hasRoom: !!room,
      busy: executionBusy,
      receiptPending,
      messageCount: room.messages.length,
      editing
    });
    el.dexClearChat.textContent = room.messages.length ? `Clear chat (${room.messages.length})` : 'Clear chat';
  }

  el.dexRefreshTargets.addEventListener('click', () => { send({ type: 'request_tabs' }); send({ type: 'request_local_targets' }); send({ type: 'request_app_targets', force: true }); log('Refreshing participant targets…'); });
  el.baseModeTab.addEventListener('click', () => setMode('base'));
  el.dexModeTab.addEventListener('click', () => setMode('dex'));
  el.dexNewRoom.addEventListener('click', () => {
    if (canHumanEdit()) humanInput.createRoom();
  });
  el.dexSaveRoom.addEventListener('click', () => {
    const room = activeRoom();
    if (!room || !canHumanEdit() || controlApi.roomExecutionBusy(state, room)) return;
    room.name = protocol.cleanName(el.dexRoomName.value, room.name);
    room.userName = protocol.cleanName(el.dexUserName.value, 'User');
    room.settings.autoRelay = el.dexAutoRelay.checked;
    const nextBudget = protocol.clampInt(el.dexMaxTurns.value, 1, protocol.MAX_RELAY_TURNS, 8);
    if (room.settings.maxTurns !== nextBudget) room.settings.budgetRevision = Number(room.settings.budgetRevision || 0) + 1;
    room.settings.maxTurns = nextBudget;
    const middle = el.dexMiddleAgent.value; room.settings.middleAgentMode = middle === 'disabled' ? 'disabled' : middle === 'automatic' ? 'automatic' : 'manual';
    room.settings.middleAgentMemberId = ['automatic', 'disabled'].includes(middle) ? null : middle;
    room.updatedAt = now();
    persist();
    renderAll();
  });
  el.dexClearChat.addEventListener('click', () => {
    const room = activeRoom();
    if (!room || !canHumanEdit() || controlApi.roomBusy(state, room)) return log('Enable Human Input and stop the relay before clearing room chat.');
    if (!confirm(`Clear ${room.messages.length} message(s) from "${room.name}"? Participants and room settings stay intact.`)) return;
    const cleared = controlApi.clearRoomHistory(room);
    persist();
    renderAll();
    log(`Cleared ${cleared} message(s) from ${room.name}.`);
  });
  el.dexDeleteRoom.addEventListener('click', () => {
    const room = activeRoom();
    if (!room || !canHumanEdit() || controlApi.roomExecutionBusy(state, room)) return log('Enable Human Input and stop active room work before deleting it.');
    const pending = controlApi.roomHasPendingControlReceipt(state, room);
    const warning = pending ? ' Its unresolved provider-control receipt will be preserved in the local retirement ledger.' : '';
    if (!confirm(`Delete "${room.name}"?${warning}`)) return;
    if (!send({ type: 'dex_room_delete', requestId: uid('dex-room-delete'), roomId: room.id, confirmName: room.name, retireUnresolved: pending })) log('Nexus is disconnected; room was not deleted.');
  });
  el.dexSend.addEventListener('click', () => {
    const room = activeRoom();
    const text = protocol.cleanText(el.dexPrompt.value);
    if (!room || state.runtimeRole !== 'controller' || state.uiConnectionPhase !== 'connected'
        || !room.members.length || !text || controlApi.roomBusy(state, room) || memberController.isEditing()) return;
    const message = roomMessage(room, 'user', 'user', room.userName, text, false);
    el.dexPrompt.value = '';
    runtime.startRelay(room, message, room.settings.autoRelay ? room.settings.maxTurns : 1);
  });
  el.dexPrompt.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      el.dexSend.click();
    }
  });
  el.dexStopRelay.addEventListener('click', () => {
    if (canHumanEdit()) runtime.stopRoom(activeRoom(), 'Stopped by user');
  });
  el.dexContinueRelay.addEventListener('click', () => {
    const room = activeRoom();
    if (canHumanEdit() && room && !memberController.isEditing() && !controlApi.roomBusy(state, room)) {
      runtime.continueRelay(room, room.settings.maxTurns);
    }
  });

  loadRooms();
  let savedView = null;
  try {
    savedView = JSON.parse(sessionStorage.getItem(VIEW_KEY) || 'null');
    sessionStorage.removeItem(VIEW_KEY);
  } catch {}
  if (savedView?.activeRoomId && state.rooms.some((room) => room.id === savedView.activeRoomId)) {
    state.activeRoomId = savedView.activeRoomId;
  }
  if (typeof savedView?.draft === 'string') el.dexPrompt.value = savedView.draft;
  setMode(savedView?.mode || (new URLSearchParams(location.search).get('mode') === 'dex' ? 'dex' : 'base'));
  renderAll();
  if (Number.isFinite(savedView?.scrollTop)) {
    requestAnimationFrame(() => { el.dexTranscript.scrollTop = savedView.scrollTop; });
  }
  const reloadReason = sessionStorage.getItem(RELOAD_REASON_KEY);
  if (reloadReason) {
    sessionStorage.removeItem(RELOAD_REASON_KEY);
    log(reloadReason);
  }
  dexWorkspace = dexWorkspaceApi?.create({ state, el, setMode, renderAll, connect: connectSocket,
    disconnect: () => { dexSocket?.stop(); dexSocket = null; state.uiConnectionPhase = 'suspended'; renderAll(); } });
  if (handoff && dexWorkspace) handoff.register('dex', dexWorkspace); else connectSocket();
})();
