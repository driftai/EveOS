(() => {
  const protocol = globalThis.BrowserAiBridgeDexProtocol;
  const memberApi = globalThis.BrowserAiBridgeDexMembers;
  const controlApi = globalThis.BrowserAiBridgeDexProviderControl;
  const stateSyncApi = globalThis.BrowserAiBridgeDexStateSync;
  const runtimeApi = globalThis.BrowserAiBridgeDexRuntimeClient;
  const socketApi = globalThis.BrowserAiBridgeUiSocket;
  const sessionPolicyApi = globalThis.BrowserAiBridgeDexSessionPolicy;
  const humanInputApi = globalThis.BrowserAiBridgeDexHumanControl;
  const roomViewApi = globalThis.BrowserAiBridgeDexRoomView;
  if (!protocol || !memberApi || !controlApi || !stateSyncApi || !runtimeApi || !socketApi || !sessionPolicyApi || !humanInputApi || !roomViewApi) {
    throw new Error('Dex helpers must load before Dex Mode.');
  }

  const STORAGE_KEY = 'browser-ai-bridge.dex.rooms.v1';
  const VIEW_KEY = 'browser-ai-bridge.dex.viewer-state.v1';
  const RELOAD_REASON_KEY = 'browser-ai-bridge.dex.reload-reason.v1';
  const state = {
    uiConnectionPhase: 'connecting',
    rooms: [],
    activeRoomId: null,
    tabs: [],
    providers: [],
    onlineTarget: null,
    localTargets: [],
    localTypes: [],
    reloading: false,
    runtimeRole: 'unknown',
    lastRelayFinalAt: 0,
    lastRelayFinalProvider: ''
  };
  const el = Object.fromEntries([
    'baseModeTab','dexModeTab','baseModePanel','dexModePanel','dexRoomList','dexNewRoom',
    'dexRoomName','dexUserName','dexAutoRelay','dexMaxTurns','dexSaveRoom','dexClearChat','dexDeleteRoom',
    'dexRoomStatus','dexMemberClass','dexMemberType','dexMemberTarget','dexMemberName',
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
      settings: { autoRelay: true, maxTurns: 8, contextMessages: 8, contextDefaultMessages: null },
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

  let stateSync = null;
  let dexSocket = null;
  function send(payload) {
    return dexSocket?.send(payload) || false;
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
      send({ type: 'request_local_targets' });
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
    if (msg?.code !== 'HOST_ACCESS_REQUIRED') return null;
    const site = msg.detail?.pattern || 'this provider site';
    if (msg?.detail?.allSitesDeclared) {
      return `Chrome is withholding EveOS Nexus Browser's all-sites access for ${site}. Open the extension menu → This can read and change site data → On all sites once, then retry the Dex relay.`;
    }
    return `Chrome site access is required for ${site}. Allow EveOS Nexus Browser on this site in Chrome's extension Site access, then retry the Dex relay.`;
  }

  function handleSocketMessage(msg) {
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
      // A fresh authoritative scheduler snapshot, never an open socket alone,
      // permits new dispatch after reconnect. Pending turns are not replayed.
      state.uiConnectionPhase = 'connected';
      renderAll();
      if (result?.applied) log('Dex state synchronized from localhost scheduler.');
      return;
    }
    if (msg.type === 'provider_control_request') {
      const result = providerControl.handle(msg);
      if (result?.ok && controlApi.MUTATING_ACTIONS.has(String(msg.command?.action || '').trim().toLowerCase())) {
        stateSync?.flush();
      }
      send({ type: 'provider_control_result', requestId: msg.requestId, source: msg.source, result });
      return;
    }
    if (msg.type === 'provider_health_update') { updateHealth(msg); return; }
    if (msg.type === 'tabs_update') {
      state.tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
      if (Array.isArray(msg.providers)) state.providers = msg.providers;
      if ('target' in msg) state.onlineTarget = msg.target || null;
      memberController.renderBuilder();
      return;
    }
    if (msg.type === 'local_targets_update') {
      state.localTargets = Array.isArray(msg.targets) ? msg.targets : [];
      memberController.renderBuilder();
      return;
    }
    if (msg.type === 'target_classes_update') {
      state.localTypes = Array.isArray(msg.localTargetTypes) ? msg.localTargetTypes : [];
      memberController.renderBuilder();
      return;
    }
    if (msg.type === 'target_selected') {
      state.onlineTarget = msg.target || null;
      return;
    }
    if (msg.type === 'response_final') {
      const observedAt = Number(msg.observedAt || Date.now());
      state.lastRelayFinalAt = observedAt;
      state.lastRelayFinalProvider = msg.providerName || msg.providerId || 'provider';
      const settleMs = Number(msg.detail?.adapterSettleMs);
      log(`Relay timing: ${state.lastRelayFinalProvider} final settled${Number.isFinite(settleMs) ? ` in ${settleMs} ms` : ''}.`);
      return;
    }
    if (msg.type === 'prompt_accepted') {
      const acceptedAt = Number(msg.observedAt || Date.now());
      if (state.lastRelayFinalAt) {
        const handoffMs = Math.max(0, acceptedAt - state.lastRelayFinalAt);
        log(`Relay timing: ${state.lastRelayFinalProvider || 'previous provider'} → ${msg.providerName || msg.providerId || 'provider'} accepted in ${handoffMs} ms.`);
        state.lastRelayFinalAt = 0; state.lastRelayFinalProvider = '';
      }
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
        send({ type: 'request_local_targets' });
        log('Dex transport connected; awaiting localhost scheduler snapshot.');
      },
      onMalformed: (error) => log(`Bad Dex bridge event: ${error.message}`),
      onPhase: ({ phase }) => {
        const previous = state.uiConnectionPhase;
        state.uiConnectionPhase = phase;
        renderAll();
        if (phase === 'reconnecting' && previous === 'connected') {
          log('Dex viewer/controller reconnecting; relay controls paused.');
        }
        if (phase === 'disconnected') log('Dex viewer/controller disconnected; retrying in background.');
      }
    });
    dexSocket.connect();
  }

  const humanInput = humanInputApi.createController({
    panel: el.dexModePanel,
    label: el.dexControlLabel,
    hint: el.dexControlHint,
    toggle: el.dexHumanToggle,
    controls: el,
    onRelock: () => memberController.clear(),
    onChange: () => renderAll()
  });
  const canHumanEdit = () => humanInput.isEnabled()
    && state.runtimeRole === 'controller' && state.uiConnectionPhase === 'connected';

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
      state.activeRoomId = room.id;
      renderAll();
    }
  });

  function renderAll() {
    const room = activeRoom();
    roomView.renderRooms();
    if (!room) {
      humanInput.render({ connected: false, controller: false, hasRoom: false });
      return;
    }
    const uiConnected = state.uiConnectionPhase === 'connected';
    const connectionSuffix = uiConnected ? '' : ` · Nexus ${state.uiConnectionPhase}`;
    el.dexRoomName.value = room.name;
    el.dexUserName.value = room.userName;
    el.dexAutoRelay.checked = !!room.settings.autoRelay;
    el.dexMaxTurns.value = room.settings.maxTurns;
    const budgetLabel = ` · ${room.relay.scheduledTurns ?? '?'} / ${room.relay.turnBudgetTotal ?? '?'} scheduled · ${room.relay.remaining || 0} left`;
    el.dexRoomStatus.textContent = room.relay.active
      ? `Relay running on localhost${budgetLabel}${room.relay.waitingFor ? ' · waiting for agent' : ''}${connectionSuffix}`
      : `Relay stopped · ${room.relay.lastStopReason || 'Idle'}${budgetLabel}${connectionSuffix}`;
    memberController.render(room);
    roomView.renderTranscript(room);
    const editing = memberController.isEditing();
    const busy = controlApi.roomBusy(state, room);
    el.dexSend.disabled = !uiConnected || state.runtimeRole !== 'controller'
      || !room.members.length || busy || editing;
    humanInput.render({
      connected: uiConnected,
      controller: state.runtimeRole === 'controller',
      hasRoom: !!room,
      busy,
      messageCount: room.messages.length,
      editing
    });
    el.dexClearChat.textContent = room.messages.length ? `Clear chat (${room.messages.length})` : 'Clear chat';
  }

  el.baseModeTab.addEventListener('click', () => setMode('base'));
  el.dexModeTab.addEventListener('click', () => setMode('dex'));
  el.dexNewRoom.addEventListener('click', () => {
    if (!canHumanEdit()) return;
    memberController.clear();
    const room = defaultRoom();
    state.rooms.push(room);
    state.activeRoomId = room.id;
    persist();
    renderAll();
  });
  el.dexSaveRoom.addEventListener('click', () => {
    const room = activeRoom();
    if (!room || !canHumanEdit() || controlApi.roomBusy(state, room)) return;
    room.name = protocol.cleanName(el.dexRoomName.value, room.name);
    room.userName = protocol.cleanName(el.dexUserName.value, 'User');
    room.settings.autoRelay = el.dexAutoRelay.checked;
    const nextBudget = protocol.clampInt(el.dexMaxTurns.value, 1, protocol.MAX_RELAY_TURNS, 8);
    if (room.settings.maxTurns !== nextBudget) room.settings.budgetRevision = Number(room.settings.budgetRevision || 0) + 1;
    room.settings.maxTurns = nextBudget;
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
    if (!room || !canHumanEdit() || controlApi.roomBusy(state, room)) return log('Enable Human Input and stop the relay before deleting a room.');
    state.rooms = state.rooms.filter((item) => item.id !== room.id);
    if (!state.rooms.length) state.rooms.push(defaultRoom(1));
    memberController.clear();
    state.activeRoomId = state.rooms[0].id;
    persist();
    renderAll();
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
  connectSocket();
})();
