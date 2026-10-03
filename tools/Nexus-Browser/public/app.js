const state = {
  extensionConnected: false,
  uiConnectionPhase: 'connecting',
  targetClasses: [{ id: 'online-origin', name: 'Online-Origin Targets' }, { id: 'local-origin', name: 'Local-Origin Targets' }, { id: 'app-origin', name: 'App-Origin Targets' }],
  selectedTargetClassId: 'online-origin',
  providers: [],
  selectedProviderId: 'deepseek',
  tabs: [],
  onlineTarget: null,
  localTargetTypes: [{ id: 'terminal-agent', name: 'Terminal Agent' }], selectedLocalTypeId: 'terminal-agent',
  localTargets: [],
  localTarget: null,
  pending: new Map(), serverSessionId: null
};

const el = {
  bridgeBadge: document.querySelector('#bridgeBadge'),
  targetClassSelect: document.querySelector('#targetClassSelect'),
  onlineTargetControls: document.querySelector('#onlineTargetControls'),
  localTargetControls: document.querySelector('#localTargetControls'),
  providerSelect: document.querySelector('#providerSelect'),
  tabSelect: document.querySelector('#tabSelect'),
  refreshTabs: document.querySelector('#refreshTabs'),
  connectTarget: document.querySelector('#connectTarget'),
  localTypeSelect: document.querySelector('#localTypeSelect'),
  localTargetSelect: document.querySelector('#localTargetSelect'),
  refreshLocalTargets: document.querySelector('#refreshLocalTargets'),
  connectLocalTarget: document.querySelector('#connectLocalTarget'),
  targetStatus: document.querySelector('#targetStatus'),
  transcript: document.querySelector('#transcript'),
  prompt: document.querySelector('#prompt'),
  captureLatest: document.querySelector('#captureLatest'),
  sendPrompt: document.querySelector('#sendPrompt'),
  diagnostics: document.querySelector('#diagnostics')
};

const searchUi = globalThis.BrowserAiBridgeSearchResultsUi, activityUi = globalThis.BrowserAiBridgeActivityUi,
  socketApi = globalThis.BrowserAiBridgeUiSocket, handoff = globalThis.BrowserAiBridgeWorkspaceHandoff,
  baseWorkspaceApi = globalThis.BrowserAiBridgeBaseWorkspace, hostAccessUiApi = globalThis.BrowserAiBridgeHostAccessUi;
const appMirrorUiApi = globalThis.BrowserAiBridgeAppMirrorUi, appTargetsUiApi = globalThis.BrowserAiBridgeAppTargetsUi;
if (!searchUi || !socketApi || !appMirrorUiApi || !appTargetsUiApi || !hostAccessUiApi) throw new Error('Base UI helpers were not loaded before app.js.');
if (!activityUi) throw new Error('Activity UI module was not loaded before app.js.');
let uiSocket = null, appMirrorUi = null, appTargetsUi = null, baseWorkspace = null;
function activeTarget() {
  return state.selectedTargetClassId === 'local-origin' ? state.localTarget
    : state.selectedTargetClassId === 'app-origin' ? appTargetsUi?.target() : state.onlineTarget;
}
function providerMeta(providerId) {
  return state.providers.find((provider) => provider.id === providerId) || null;
}
function providerName(providerId = null) {
  return providerMeta(providerId || state.selectedProviderId)?.name || 'Provider';
}
function assistantDisplayName(msg = {}) {
  return hostAccessUiApi.assistantDisplayName({ message: msg, target: activeTarget(), providerName: providerName(msg.providerId) });
}
function requestId() {
  return `${Date.now().toString(36)}-${crypto.getRandomValues(new Uint32Array(1))[0].toString(36)}`;
}
function log(message, detail = '') {
  const stamp = new Date().toLocaleTimeString();
  const line = `[${stamp}] ${message}${detail ? `\n${detail}` : ''}`;
  const current = el.diagnostics.textContent.trim();
  el.diagnostics.textContent = `${line}\n${current}`.slice(0, 12000);
}
function ensureMessage(role, id = null, assistantName = null) {
  let node = id ? document.querySelector(`[data-message-id="${CSS.escape(id)}"]`) : null;
  if (node) return node;

  node = document.createElement('article');
  node.className = `message ${role}`;
  if (id) node.dataset.messageId = id;

  const label = document.createElement('div');
  label.className = 'message-label';
  label.textContent = role === 'user' ? 'You' : role === 'assistant' ? (assistantName || 'Assistant') : 'System';

  const body = document.createElement('div');
  body.className = 'message-body';
  node.append(label, body);
  el.transcript.append(node);
  return node;
}
function addMessage(role, text, id = null, partial = false, assistantName = null) {
  const node = ensureMessage(role, id, assistantName);
  node.querySelector('.message-body').textContent = text;
  node.classList.toggle('partial', partial);
  el.transcript.scrollTop = el.transcript.scrollHeight;
  return node;
}
function send(payload) {
  if (!uiSocket?.send(payload)) {
    addMessage('system', 'Local bridge socket is not connected.');
    return false;
  }
  return true;
}
function requestSearchResults(requestIdValue, searchIndex, event) {
  const target = activeTarget();
  if (state.selectedTargetClassId !== 'online-origin' || !target || !state.extensionConnected) {
    addMessage('system', 'Search-result capture is available only for connected Online-Origin targets.');
    return;
  }
  searchUi.showLoading(requestIdValue, searchIndex, event);
  if (!send({ type: 'request_search_results', requestId: requestIdValue, searchIndex })) {
    searchUi.render({ requestId: requestIdValue, searchIndex, ok: false, error: 'Local bridge socket is not connected.' });
  }
  log(`Requesting ${target.providerName || 'Provider'} search results stage ${searchIndex}.`);
}
function renderActivity(requestIdValue, activity, final = false, assistantName = null) {
  activityUi.render({
    requestId: requestIdValue,
    activity,
    final,
    assistantName,
    ensureMessage,
    transcript: el.transcript,
    requestSearchResults
  });
}
function renderTargetClasses() {
  const previous = state.selectedTargetClassId;
  el.targetClassSelect.replaceChildren();
  for (const targetClass of state.targetClasses) {
    const option = document.createElement('option');
    option.value = targetClass.id;
    option.textContent = targetClass.name;
    el.targetClassSelect.append(option);
  }
  if (state.targetClasses.some((entry) => entry.id === previous)) state.selectedTargetClassId = previous;
  else if (state.targetClasses[0]) state.selectedTargetClassId = state.targetClasses[0].id;
  el.targetClassSelect.value = state.selectedTargetClassId;
}
function renderProviders() {
  const previous = state.selectedProviderId;
  el.providerSelect.replaceChildren();
  for (const provider of state.providers) {
    const option = document.createElement('option');
    option.value = provider.id;
    option.textContent = provider.name;
    el.providerSelect.append(option);
  }
  if (state.providers.some((provider) => provider.id === previous)) state.selectedProviderId = previous;
  else if (state.providers[0]) state.selectedProviderId = state.providers[0].id;
  el.providerSelect.value = state.selectedProviderId;
}
function providerTabs() {
  return state.tabs.filter((tab) => tab.providerId === state.selectedProviderId && tab.appMirror !== true);
}
function renderTabs() {
  const oldValue = el.tabSelect.value;
  const tabs = providerTabs();
  el.tabSelect.replaceChildren();
  if (!tabs.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = `No ${providerName()} tabs detected`;
    el.tabSelect.append(option);
    return;
  }
  for (const tab of tabs) {
    const option = document.createElement('option');
    option.value = String(tab.id);
    option.textContent = `${tab.title || tab.providerName || providerName()}${tab.health?.blocking ? ` · ${tab.health.summary || tab.health.state}` : ''} — ${tab.url || ''}`;
    el.tabSelect.append(option);
  }
  const wanted = state.onlineTarget?.providerId === state.selectedProviderId && state.onlineTarget?.id != null
    ? String(state.onlineTarget.id)
    : oldValue;
  if (wanted && tabs.some((tab) => String(tab.id) === wanted)) el.tabSelect.value = wanted;
}
function renderLocalTargetTypes() {
  el.localTypeSelect.replaceChildren();
  for (const type of state.localTargetTypes) {
    const option = document.createElement('option');
    option.value = type.id;
    option.textContent = type.name;
    el.localTypeSelect.append(option);
  }
  if (!state.localTargetTypes.some((entry) => entry.id === state.selectedLocalTypeId)) {
    state.selectedLocalTypeId = state.localTargetTypes[0]?.id || '';
  }
  el.localTypeSelect.value = state.selectedLocalTypeId;
}
function filteredLocalTargets() {
  return state.localTargets.filter((target) => target.targetTypeId === state.selectedLocalTypeId);
}
function renderLocalTargets() {
  const oldValue = el.localTargetSelect.value;
  const targets = filteredLocalTargets();
  el.localTargetSelect.replaceChildren();
  if (!targets.length) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No local agent targets detected';
    el.localTargetSelect.append(option);
    return;
  }
  for (const target of targets) {
    const option = document.createElement('option');
    option.value = target.id;
    option.textContent = `${target.title}${target.workspace ? ` — ${target.workspace}` : ''}`;
    el.localTargetSelect.append(option);
  }
  const wanted = state.localTarget?.id || oldValue;
  if (wanted && targets.some((target) => target.id === wanted)) el.localTargetSelect.value = wanted;
}
function renderStatus() {
  const local = state.selectedTargetClassId === 'local-origin', app = state.selectedTargetClassId === 'app-origin';
  const uiConnected = state.uiConnectionPhase === 'connected', browser = !local && !app, appBusy = app && ([...state.pending.values()].some((entry) => entry.targetClassId === 'app-origin') || ['waiting', 'streaming'].includes(appTargetsUi?.status()?.phase));
  el.onlineTargetControls.hidden = !browser;
  el.localTargetControls.hidden = !local;
  el.bridgeBadge.textContent = !uiConnected
    ? state.uiConnectionPhase === 'suspended' ? 'Workspace standby' : state.uiConnectionPhase === 'disconnected' ? 'Nexus disconnected' : 'Nexus reconnecting'
    : app ? 'App bridge ready' : local ? 'Local bridge ready'
      : state.extensionConnected ? 'Extension connected' : 'Extension offline';
  el.bridgeBadge.classList.toggle('offline', (state.uiConnectionPhase !== 'suspended' && !uiConnected) || (browser && !state.extensionConnected));
  el.bridgeBadge.classList.toggle('online', uiConnected && (!browser || state.extensionConnected));
  const target = activeTarget();
  if (target) {
    if (app) el.targetStatus.textContent = `Bound to app: ${target.providerName || target.title || target.id}`;
    else if (local) el.targetStatus.textContent = `Bound to local ${target.targetTypeName || 'target'}: ${target.title || target.id}`;
    else el.targetStatus.textContent = `Bound to ${target.providerName} tab ${target.id}: ${target.title || target.url || ''}${target.health?.blocking ? ` · ${target.health.summary || target.health.state}` : ''}`;
  } else {
    el.targetStatus.textContent = app ? 'No App-Origin target selected.'
      : local ? 'No Local-Origin target selected.' : 'No Online-Origin target selected.';
  }
  const targetName = target?.providerName || (app ? 'desktop app' : local ? 'local agent' : providerName());
  el.sendPrompt.textContent = `Send to ${targetName}`;
  el.prompt.placeholder = app
    ? `Type here. Enter sends to the selected ${targetName} app.`
    : local ? `Type here. Enter sends to the selected ${targetName} local target.`
      : `Type here. Enter sends to the selected ${targetName} tab.`;
  el.sendPrompt.disabled = !target || !uiConnected || appBusy || (browser && (!state.extensionConnected || target.health?.blocking));
  el.captureLatest.hidden = local;
  el.captureLatest.disabled = local || !target || !uiConnected || (browser && !state.extensionConnected);
  appMirrorUi?.render(); appTargetsUi?.render();
}
function hostAccessUiMessage(msg) {
  return hostAccessUiApi.message(msg, { retryAction: 'click Connect target again' });
}
function handleMessage(msg) {
  if (appMirrorUi?.handleMessage(msg) || appTargetsUi?.handleMessage(msg)) return;
  switch (msg.type) {
    case 'server_session':
      if (baseWorkspace?.onServerSession?.(msg.id)) log('New Nexus server session · Base transcript and target selection reset.');
      log(`Bridge session ${msg.id || 'unknown'} · assets ${msg.assetRevision || 'unknown'}.`);
      break;
    case 'bridge_status':
      state.extensionConnected = !!msg.connected;
      renderStatus();
      log(`Extension ${state.extensionConnected ? 'connected' : (msg.state === 'reconnecting' ? 'reconnecting' : 'disconnected')}`);
      break;
    case 'target_classes_update':
      if (Array.isArray(msg.classes)) state.targetClasses = msg.classes;
      if (Array.isArray(msg.localTargetTypes)) state.localTargetTypes = msg.localTargetTypes;
      renderTargetClasses();
      renderLocalTargetTypes();
      renderStatus();
      break;
    case 'tabs_update':
      state.providers = Array.isArray(msg.providers) ? msg.providers : state.providers;
      state.tabs = Array.isArray(msg.tabs) ? msg.tabs : [];
      appMirrorUi?.observeTabs(state.tabs);
      if ('target' in msg) state.onlineTarget = msg.target?.appMirror === true ? null : (msg.target || null);
      if (state.onlineTarget?.providerId) state.selectedProviderId = state.onlineTarget.providerId;
      renderProviders();
      renderTabs();
      renderStatus();
      log(`Detected ${state.tabs.length} supported online AI tab(s).`);
      break;
    case 'local_targets_update':
      state.localTargets = Array.isArray(msg.targets) ? msg.targets : [];
      if ('target' in msg) state.localTarget = msg.target || null;
      renderLocalTargets();
      renderStatus();
      log(`Detected ${state.localTargets.length} supported local agent target(s).`);
      break;
    case 'target_selected':
      state.onlineTarget = msg.target?.appMirror === true ? null : (msg.target || null);
      if (state.onlineTarget?.providerId) state.selectedProviderId = state.onlineTarget.providerId;
      renderProviders();
      renderTabs();
      renderStatus();
      addMessage('system', state.onlineTarget ? `Connected to ${state.onlineTarget.providerName} tab ${state.onlineTarget.id}.` : 'Online target selection cleared.');
      break;
    case 'local_target_selected':
      state.localTarget = msg.target || null;
      renderLocalTargets();
      renderStatus();
      addMessage('system', state.localTarget ? `Connected to local target ${state.localTarget.title}.` : 'Local target selection cleared.');
      break;
    case 'target_lost':
      state.onlineTarget = null;
      renderStatus();
      addMessage('system', msg.message || 'The selected online target was lost.');
      log('Target lost', msg.message || '');
      break;
    case 'prompt_accepted': {
      const pending = state.pending.get(msg.requestId), clientMs = pending ? Date.now() - pending.sentAt : null;
      const dispatchMs = Number.isFinite(Number(msg.detail?.dispatchToAppMs)) ? Number(msg.detail.dispatchToAppMs) : null;
      log(`${msg.providerName || 'Target'} accepted prompt ${msg.requestId || ''}${dispatchMs != null ? ` · send→app ${dispatchMs} ms` : ''}${clientMs != null ? ` · UI→accept ${clientMs} ms` : ''}.`);
      break;
    }
    case 'activity_update':
      renderActivity(msg.requestId, msg.activity || { events: [] }, !!msg.final, assistantDisplayName(msg));
      if (msg.activity?.events?.length) log(`Activity update ${msg.requestId || ''}: ${msg.activity.events.length} event(s).`);
      break;
    case 'response_partial':
      addMessage('assistant', msg.text || '', `assistant-${msg.requestId}`, true, assistantDisplayName(msg));
      break;
    case 'response_final': {
      const node = addMessage('assistant', msg.text || '', `assistant-${msg.requestId}`, false, assistantDisplayName(msg));
      const activityPanel = node.querySelector('.activity-panel');
      if (activityPanel && !activityPanel.hidden) activityPanel.open = false;
      const pending = state.pending.get(msg.requestId), uiRound = pending ? Date.now() - pending.sentAt : null;
      const timing = Number.isFinite(Number(msg.detail?.totalResponseMs))
        ? ` · send→app ${Number(msg.detail?.dispatchToAppMs || 0)} ms · app→first ${Number(msg.detail?.timeToFirstResponseMs || 0)} ms · app→final ${Number(msg.detail.totalResponseMs)} ms · adapter round trip ${Number(msg.detail?.nexusRoundTripMs || 0)} ms · UI round trip ${uiRound ?? '?'} ms · ${Number(msg.detail?.pollCount || 0)} poll(s)` : '';
      log(`${assistantDisplayName(msg)} final response ${msg.requestId || ''} (${(msg.text || '').length} chars)${timing}.`);
      state.pending.delete(msg.requestId); renderStatus();
      break;
    }
    case 'search_results_result':
      searchUi.render(msg);
      log(`Search results ${msg.requestId || ''} stage ${msg.searchIndex ?? 0}: ${(msg.results || []).length}/${msg.expectedCount || '?'} page(s).`);
      break;
    case 'capture_result':
      addMessage('assistant', msg.text || '(No visible assistant response found.)', null, false, assistantDisplayName(msg));
      log(`Captured latest visible ${assistantDisplayName(msg)} response.`);
      break;
    case 'error': {
      const accessMessage = hostAccessUiMessage(msg);
      addMessage('system', accessMessage || `${msg.code ? `${msg.code}: ` : ''}${msg.message || 'Unknown bridge error.'}`);
      log('Bridge error', JSON.stringify(msg, null, 2));
      if (msg.requestId) { state.pending.delete(msg.requestId); renderStatus(); }
      if (searchUi.isOpenForRequest(msg.requestId)) {
        searchUi.render({ requestId: msg.requestId, searchIndex: msg.detail?.searchIndex ?? 0, ok: false, error: msg.message || 'Search-result capture failed.' });
      }
      break;
    }
    case 'pong': break;
    case 'provider_health_update': log(`${msg.providerName || msg.providerId || 'Provider'} health: ${msg.health?.summary || msg.health?.state || 'unknown'}`); break;
    case 'extension_hello': log(`Extension hello v${msg.version || '?'}.`); break;
    default:
      log(`Unhandled event: ${msg.type || 'unknown'}`, JSON.stringify(msg));
  }
}

function connectSocket() {
  uiSocket = socketApi.createClient({
    url: `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`,
    hello: { type: 'hello', role: 'ui' },
    onMessage: handleMessage,
    onOpen: () => {
      log('Local UI socket connected.');
      appMirrorUi?.requestStatus(); appTargetsUi?.requestTargets(); baseWorkspace?.onOpen?.();
    },
    onMalformed: (error) => log('Invalid message from bridge.', error.message),
    onPhase: ({ phase, closeCode, closeReason }) => {
      const previous = state.uiConnectionPhase;
      state.uiConnectionPhase = phase;
      renderStatus();
      if (phase === 'reconnecting' && previous === 'connected') log(`Local UI socket reconnecting · code ${closeCode ?? '?'}${closeReason ? ` · ${closeReason}` : ''}; selections preserved and dispatch paused.`);
      if (phase === 'disconnected') log('Local UI socket disconnected; retrying in background.');
    }
  });
  uiSocket.connect();
}

function submitPrompt() {
  const text = el.prompt.value.trim();
  if (!text) return;
  const target = activeTarget();
  if (!target) return addMessage('system', 'Connect a target first.');
  if (state.selectedTargetClassId === 'app-origin' && ([...state.pending.values()].some((entry) => entry.targetClassId === 'app-origin') || ['waiting', 'streaming'].includes(appTargetsUi?.status()?.phase))) return addMessage('system', 'Current ChatGPT turn still running.');

  const id = requestId();
  const payload = { type: 'send_prompt', requestId: id, text, targetClassId: state.selectedTargetClassId };
  if (state.selectedTargetClassId === 'local-origin' || state.selectedTargetClassId === 'app-origin') payload.targetId = target.id;
  state.pending.set(id, { text, sentAt: Date.now(), providerId: target.providerId, targetClassId: state.selectedTargetClassId });
  if (!send(payload)) { state.pending.delete(id); return; }

  addMessage('user', text, `user-${id}`); renderStatus();
  el.prompt.value = '';
}
el.targetClassSelect.addEventListener('change', () => {
  state.selectedTargetClassId = el.targetClassSelect.value;
  renderStatus();
  if (state.selectedTargetClassId === 'local-origin') send({ type: 'request_local_targets' });
  if (state.selectedTargetClassId === 'app-origin') appTargetsUi?.requestTargets();
});
el.providerSelect.addEventListener('change', () => {
  state.selectedProviderId = el.providerSelect.value;
  renderTabs();
  renderStatus();
});
el.localTypeSelect.addEventListener('change', () => {
  state.selectedLocalTypeId = el.localTypeSelect.value;
  renderLocalTargets();
  renderStatus();
});
el.refreshTabs.addEventListener('click', () => send({ type: 'request_tabs' }));
el.refreshLocalTargets.addEventListener('click', () => send({ type: 'request_local_targets' }));
el.connectTarget.addEventListener('click', () => {
  const tabId = Number(el.tabSelect.value);
  if (!Number.isInteger(tabId)) return addMessage('system', `Choose a ${providerName()} tab first.`);
  send({ type: 'select_target', tabId, providerId: state.selectedProviderId });
});
el.connectLocalTarget.addEventListener('click', () => {
  const targetId = el.localTargetSelect.value;
  if (!targetId) return addMessage('system', 'Choose a local agent target first.');
  send({ type: 'select_local_target', targetId, targetTypeId: state.selectedLocalTypeId });
});
el.sendPrompt.addEventListener('click', submitPrompt);
el.prompt.addEventListener('keydown', (event) => {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    submitPrompt();
  }
});
el.captureLatest.addEventListener('click', () => {
  const target = activeTarget(), payload = { type: 'capture_latest', requestId: requestId(), targetClassId: state.selectedTargetClassId };
  if (state.selectedTargetClassId === 'app-origin') payload.targetId = target?.id || '';
  send(payload);
});
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') searchUi.close();
});

appTargetsUi = appTargetsUiApi.create({ state, send, addMessage, log, renderBaseStatus: renderStatus });
appMirrorUi = appMirrorUiApi.create({ state, send, requestId, addMessage, log });
renderTargetClasses(); renderProviders(); renderTabs(); renderLocalTargetTypes(); renderLocalTargets(); renderStatus();
baseWorkspace = baseWorkspaceApi?.create({ state, el, send,
  appTarget: () => appTargetsUi?.target(), appBindingIdentity: () => appTargetsUi?.bindingIdentity?.(),
  restoreAppTarget: (target, binding) => appTargetsUi?.restoreSelection?.(target, binding),
  render: () => { renderTargetClasses(); renderProviders(); renderTabs(); renderLocalTargetTypes(); renderLocalTargets(); renderStatus(); },
  connect: connectSocket, disconnect: () => { uiSocket?.stop(); uiSocket = null; state.uiConnectionPhase = 'suspended'; renderStatus(); } });
if (handoff && baseWorkspace) handoff.register('base', baseWorkspace); else connectSocket();
setInterval(() => { if (uiSocket?.snapshot?.().phase === 'connected') uiSocket.send({ type: 'ping' }); }, 20000);
