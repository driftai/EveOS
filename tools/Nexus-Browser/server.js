const http = require('http');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const localTargets = require('./local-targets/manager');
const { createDexServerRouting } = require('./dex/server-routing'), { createProviderControlRouting } = require('./dex/provider-control-routing'), { createProviderTargetSpawnRouting } = require('./dex/provider-target-spawn-routing');
const { createQualificationRestartHook } = require('./dex/qualification-restart'), { createQualificationRouting } = require('./dex/qualification-routing');
const { createDexStateStore } = require('./dex/state-store'), { createDexServerScheduler } = require('./dex/server-scheduler');
const { mergeClientSnapshot } = require('./dex/server-state-merge');
const { createServerDurability } = require('./dex/server-durability');
const { createExtensionSessionArbiter } = require('./dex/extension-session-arbiter');
const { assetRevision } = require('./server-asset-revision');
const { createDiagnosticsSnapshot } = require('./server-diagnostics');
const { createServerLocalRelay } = require('./dex/server-local-relay');
const { attachWebSocketHeartbeat } = require('./dex/ws-heartbeat'), { createDisposableRoomCleanup } = require('./dex/disposable-room-cleanup');
const runtimeConfig = require('./runtime-config');
const { createHttpHandler, websocketOriginAllowed } = require('./server-http');
const HOST = process.env.HOST || '127.0.0.1', PORT = runtimeConfig.servicePort();
const RUNTIME_URLS = runtimeConfig.urls(PORT);
const PUBLIC_DIR = path.join(__dirname, 'public'), SERVER_SESSION_ID = `${process.pid}-${Date.now().toString(36)}`;
const ASSET_REVISION = assetRevision();
const server = http.createServer(createHttpHandler({ host: HOST, port: PORT, publicDir: PUBLIC_DIR, diagnostics: diagnosticsSnapshot }));
const wss = new WebSocketServer({ noServer: true });
const heartbeat = attachWebSocketHeartbeat(wss);
let extensionSocket = null;
const extensionSessions = createExtensionSessionArbiter({
  isOpen: (ws) => ws?.readyState === WebSocket.OPEN,
  onAuthoritySettled: (state) => {
    if (!state.ready) return;
    syncExtensionAuthority(state);
    broadcastUi({ type: 'tabs_update', providers: lastProviders, tabs: lastTabs, target: lastTarget });
    dexScheduler.resume();
  }
});
const uiSockets = new Set();
let lastTabs = [];
let lastProviders = [];
let lastTarget = null;
let lastLocalTargets = [];
let dexStateStore = createDexStateStore();
let durability = createServerDurability();
function configureDurability(o = {}) { const prev = { durability, dexStateStore }; if (o.durability) durability = o.durability; if (o.dexStateStore) dexStateStore = o.dexStateStore; return prev; }
function safeSend(ws, payload) {
  if (!ws || ws.readyState !== WebSocket.OPEN) return false;
  ws.send(JSON.stringify(payload));
  return true;
}
function broadcastUi(payload) { for (const ws of uiSockets) safeSend(ws, payload); }
function syncExtensionAuthority(state = extensionSessions.current()) {
  extensionSocket = state.socket;
  if (state.snapshot) { lastTabs = state.snapshot.tabs; lastProviders = state.snapshot.providers; lastTarget = state.snapshot.target; }
  return state;
}
function broadcastDexState(snapshot = dexStateStore.load()) { for (const ws of uiSockets) if (ws.clientKind === 'dex') safeSend(ws, { type: 'dex_state_snapshot', snapshot }); }
const dexRouting = createDexServerRouting({ uiSockets, safeSend });
async function ensureDexClient() {
  const existing = dexRouting.dexClient();
  if (existing) return existing;
  safeSend(extensionSocket, { type: 'ensure_dex_ui' });
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const client = dexRouting.dexClient();
    if (client) return client;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return null;
}

const qualificationRestart = createQualificationRestartHook(), providerTargetSpawnRouting = createProviderTargetSpawnRouting({ safeSend, getExtensionSocket: () => extensionSocket });
const disposableRoomCleanup = createDisposableRoomCleanup({ load: () => dexStateStore.load(), save: (snapshot) => dexStateStore.save(snapshot), closeTarget: (input) => providerTargetSpawnRouting.close(input), broadcastState: broadcastDexState });
const providerControlRouting = createProviderControlRouting({
  uiSockets,
  safeSend,
  ensureDexClient,
  getDexClient: () => dexRouting.dexClient(), getState: () => dexStateStore.load(), saveState: (snapshot) => dexStateStore.save(snapshot), broadcastState: broadcastDexState, getExtension: () => { const s = extensionSessions.current(); return { socket: extensionSocket, ready: s.ready, epoch: s.primaryConnectionEpoch, sessionCount: s.sessionCount, targets: lastTabs }; }, spawnTarget: (input) => providerTargetSpawnRouting.spawn(input), closeTarget: (input) => providerTargetSpawnRouting.close(input), recordIncident: (input) => { const event = durability.recordIncident(input); console.log(`[bridge] incident ${event.code} [${event.requestId || 'n/a'}] source=${event.source || 'unknown'}`); return event; },
  async validateSource(source, ws) {
    if (ws?.role === 'provider-control-extension') {
      return source?.targetClassId === 'online-origin'
        && Number.isInteger(Number(source?.targetId))
        && !!source?.providerId
        && !!source?.url;
    }
    if (source?.targetClassId !== 'local-origin') return false;
    const target = await localTargets.getLocalTarget(String(source?.targetId || ''));
    if (!target || target.providerId !== source?.providerId) return false;
    Object.assign(source, target, { targetId: target.id });
    return true;
  }
});
const qualificationRouting = createQualificationRouting({ safeSend, getExtensionSocket: () => extensionSocket, getDurability: () => durability, getStateStore: () => dexStateStore, restartHook: qualificationRestart, serverSessionId: SERVER_SESSION_ID });
const serverDexSource = { clientKind: 'dex' };
const serverLocalRelay = createServerLocalRelay({ localTargets, mirrorPrompt: (targetId, msg, target) => mirrorPromptToConsoles(targetId, serverDexSource, msg, target), emitEvent: (targetId, payload) => sendLocalEvent(targetId, serverDexSource, payload), broadcastStatus: (targetId) => broadcastLocalStatus(targetId, serverDexSource) });
const dexScheduler = createDexServerScheduler({ stateStore: { load: () => dexStateStore.load(), save: (snapshot) => dexStateStore.save(snapshot) }, durability: { beforeDispatch: (...args) => durability.beforeDispatch(...args), observe: (...args) => durability.observe(...args), markFailed: (...args) => durability.markFailed(...args), query: (...args) => durability.query(...args) }, getOnlineTargets: () => lastTabs, getProviders: () => lastProviders, getSelectedOnlineTarget: () => lastTarget, getLocalTargets: async (force = false) => { if (force) await refreshLocalTargets(null, { force: true }); return lastLocalTargets; }, isExtensionAvailable: () => !!extensionSocket && extensionSocket.readyState === WebSocket.OPEN && extensionSessions.current().ready, sendExtension: (payload) => safeSend(extensionSocket, payload), sendLocalPrompt: serverLocalRelay.sendLocalPrompt, captureLocalLatest: localTargets.captureLocalLatest, broadcastState: broadcastDexState, recordIncident: (input) => durability.recordIncident(input) });
const readDiagnostics = createDiagnosticsSnapshot(() => ({ dexStateStore, durability, localTargets, extensionSocket, extensionSessions, uiSockets, lastTabs, lastLocalTargets, dexScheduler, providerControlRouting, providerTargetSpawnRouting, SERVER_SESSION_ID, ASSET_REVISION, WebSocket }));
function diagnosticsSnapshot() { return readDiagnostics(); }
function extensionStatus() {
  return { type: 'bridge_status', connected: !!extensionSocket && extensionSocket.readyState === WebSocket.OPEN, authorityReady: extensionSessions.current().ready };
}
function classSnapshot() {
  return { type: 'target_classes_update', classes: localTargets.publicTargetClasses(), localTargetTypes: localTargets.publicLocalTargetTypes() };
}

function selectedLocalTarget(ws) {
  if (!ws?.localTargetId) return null;
  return lastLocalTargets.find((target) => target.id === ws.localTargetId) || null;
}

function localStatusPayload(targetId) {
  return { type: 'local_target_status', targetId, status: localTargets.getLocalTargetStatus(targetId) };
}

function sendLocalStatus(ws, targetId = ws?.localTargetId) {
  if (!targetId) return false;
  return safeSend(ws, localStatusPayload(targetId));
}

function sendLocalEvent(targetId, source, payload) {
  safeSend(source, payload);
  for (const peer of uiSockets) {
    if (peer === source || peer.localTargetId !== targetId) continue;
    if (!dexRouting.allowLocalPeer(source, peer)) continue;
    safeSend(peer, payload);
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

async function refreshLocalTargets(destination = null, { force = false } = {}) {
  lastLocalTargets = await localTargets.listLocalTargets({ force });
  const destinations = destination ? [destination] : [...uiSockets];
  for (const ws of destinations) {
    if (ws.localTargetId && !lastLocalTargets.some((target) => target.id === ws.localTargetId)) ws.localTargetId = null;
    safeSend(ws, { type: 'local_targets_update', targets: lastLocalTargets, target: selectedLocalTarget(ws) });
    if (ws.localTargetId) sendLocalStatus(ws);
  }
  return lastLocalTargets;
}

function forwardToExtension(payload, source) {
  if (!safeSend(extensionSocket, payload)) {
    safeSend(source, { type: 'error', requestId: payload.requestId || null, code: 'EXTENSION_OFFLINE', message: 'The browser extension bridge is not connected.' });
  }
}

async function handleLocalUiCommand(ws, msg) {
  if (msg.type === 'request_local_targets') { await refreshLocalTargets(ws, { force: !!msg.force }); return true; }
  if (msg.type === 'request_local_status') {
    if (!sendLocalStatus(ws, String(msg.targetId || ws.localTargetId || ''))) {
      safeSend(ws, { type: 'error', code: 'LOCAL_TARGET_NOT_SELECTED', message: 'No Local-Origin target is selected.' });
    }
    return true;
  }
  if (msg.type === 'select_local_target') {
    const target = await localTargets.getLocalTarget(String(msg.targetId || ''));
    if (!target) {
      safeSend(ws, { type: 'error', code: 'LOCAL_TARGET_NOT_FOUND', message: 'That Local-Origin target is not available.' });
      return true;
    }
    ws.localTargetId = target.id;
    safeSend(ws, { type: 'local_target_selected', target, status: localTargets.getLocalTargetStatus(target.id) });
    console.log(`[bridge] local target_selected: ${target.id} (${target.title}) [${ws.clientKind}]`);
    return true;
  }
  if (msg.type === 'capture_latest' && msg.targetClassId === 'local-origin') {
    const targetId = String(msg.targetId || ws.localTargetId || '');
    try {
      const result = await localTargets.captureLocalLatest({ targetId });
      safeSend(ws, {
        type: 'capture_result', requestId: msg.requestId || null, text: result.text || '',
        targetClassId: 'local-origin', targetId, providerId: result.target?.providerId,
        providerName: result.target?.providerName, attachedPid: result.attachedPid || null
      });
    } catch (error) {
      safeSend(ws, {
        type: 'error', requestId: msg.requestId || null, code: error.code || 'LOCAL_CAPTURE_FAILED',
        message: error.message, targetClassId: 'local-origin', targetId
      });
    }
    return true;
  }
  if (msg.type === 'send_prompt' && msg.targetClassId === 'local-origin') {
    const targetId = String(msg.targetId || ws.localTargetId || '');
    const target = await localTargets.getLocalTarget(targetId);
    if (!target) {
      safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'LOCAL_TARGET_NOT_FOUND', message: 'That Local-Origin target is not available.' });
      return true;
    }
    const gate = await durability.beforeDispatch(msg, {
      targetClassId: 'local-origin', targetId, providerId: target.providerId
    });
    if (!gate.ok) {
      safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'DUPLICATE_DISPATCH_BLOCKED', message: 'Durable turn ledger blocked a duplicate local dispatch.' });
      return true;
    }
    console.log(`[bridge] local send_prompt [${msg.requestId}] -> ${targetId}: ${String(msg.text || '').slice(0, 80)}`);
    mirrorPromptToConsoles(targetId, ws, msg, target);
    try {
      const turn = localTargets.sendLocalPrompt({
        targetId, requestId: msg.requestId, text: msg.text,
        emit: (payload) => {
          durability.observe(payload, { targetClassId: 'local-origin', targetId, providerId: target.providerId }).catch(() => {});
          sendLocalEvent(targetId, ws, payload);
        }
      });
      broadcastLocalStatus(targetId, ws);
      await turn;
      broadcastLocalStatus(targetId, ws);
    } catch (error) {
      sendLocalEvent(targetId, ws, {
        type: 'error', requestId: msg.requestId || null, code: error.code || 'LOCAL_TARGET_ERROR',
        message: error.message, targetClassId: 'local-origin'
      });
      broadcastLocalStatus(targetId, ws);
    }
    return true;
  }
  return false;
}

wss.on('connection', (ws, req) => {
  ws.role = null; ws.remoteAddress = req?.socket?.remoteAddress || '';
  ws.clientKind = 'browser';
  ws.localTargetId = null;

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); }
    catch { safeSend(ws, { type: 'error', code: 'BAD_JSON', message: 'Bridge received invalid JSON.' }); return; }

    if (msg.type === 'hello') {
      if (msg.role === 'qualification') { qualificationRouting.accept(ws); return; }
      if (msg.role === 'extension') {
        ws.role = 'extension';
        const state = syncExtensionAuthority(extensionSessions.register(ws));
        console.log(`[bridge] extension connected [${state.socket === ws ? 'primary' : 'standby'}] session=${state.primarySessionId || 'pending'} epoch=${state.primaryConnectionEpoch || 0} sessions=${state.sessionCount}`);
        broadcastUi(extensionStatus());
        safeSend(ws, { type: 'request_tabs' });
        return;
      }
      if (msg.role === 'provider-control-extension') {
        ws.role = 'provider-control-extension'; providerControlRouting.providerControlConnected(ws);
        console.log('[bridge] provider-control extension connected');
        return;
      }
      if (msg.role === 'ui') {
        ws.role = 'ui';
        ws.clientKind = msg.clientKind === 'console' ? 'console'
          : msg.clientKind === 'dex' ? 'dex'
            : msg.clientKind === 'provider-control' ? 'provider-control'
              : msg.clientKind === 'maintenance' ? 'maintenance' : 'browser';
        uiSockets.add(ws);
        console.log(`[bridge] ui connected [${ws.clientKind}]`);
        if (ws.clientKind === 'dex') {
          const primary = dexRouting.registerDex(ws);
          safeSend(ws, { type: 'dex_runtime_role', role: primary ? 'primary' : 'standby' });
        }
        safeSend(ws, { type: 'server_session', id: SERVER_SESSION_ID, assetRevision: ASSET_REVISION });
        if (ws.clientKind === 'dex') safeSend(ws, { type: 'dex_state_snapshot', snapshot: dexStateStore.load() });
        safeSend(ws, extensionStatus());
        safeSend(ws, classSnapshot());
        if (extensionSessions.current().ready) safeSend(ws, { type: 'tabs_update', providers: lastProviders, tabs: lastTabs, target: lastTarget });
        await refreshLocalTargets(ws);
        return;
      }
      safeSend(ws, { type: 'error', code: 'BAD_ROLE', message: 'Unsupported hello.role.' });
      return;
    }

    if (msg.type === 'ping') { safeSend(ws, { type: 'pong', at: Date.now() }); return; }
    if (ws.role === 'qualification') { await qualificationRouting.handle(ws, msg); return; }
    if (ws.role === 'provider-control-extension') {
      if (await providerControlRouting.handle(ws, msg)) return;
      safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'BAD_PROVIDER_CONTROL_COMMAND', message: `Unsupported provider-control command: ${msg.type}` });
      return;
    }

    if (ws.role === 'ui') {
      if (ws.clientKind === 'maintenance' && ['cleanup_disposable_rooms', 'resolve_passive_recovery'].includes(msg.type)) { const result = msg.type === 'cleanup_disposable_rooms' ? await disposableRoomCleanup.run(msg.requestId) : dexScheduler.resolvePassiveRecovery({ roomId: msg.roomId, requestId: msg.recoveryRequestId, reason: msg.reason }); if (msg.type === 'resolve_passive_recovery' && result.ok) broadcastDexState(dexStateStore.load()); safeSend(ws, msg.type === 'cleanup_disposable_rooms' ? result : { type: 'resolve_passive_recovery_result', requestId: msg.requestId || null, ...result }); return; }
      if (msg.type === 'dex_state_put' && ws.clientKind === 'dex') {
        if (!dexRouting.isPrimaryDex(ws)) {
          safeSend(ws, { type: 'error', code: 'DEX_RUNTIME_STANDBY', message: 'This Dex tab is standby; the primary Dex controller owns room edits while localhost owns relay scheduling and recovery.' });
          return;
        }
        try {
          const snapshot = dexStateStore.save(mergeClientSnapshot(dexStateStore.load(), msg.snapshot || {})); dexScheduler.onStateChanged(); broadcastDexState(snapshot);
          safeSend(ws, { type: 'dex_state_saved', savedAt: snapshot.savedAt });
        } catch (error) {
          safeSend(ws, { type: 'error', code: 'DEX_STATE_SAVE_FAILED', message: error.message });
        }
        return;
      }
      if (['dex_relay_start', 'dex_relay_stop', 'dex_relay_continue'].includes(msg.type) && ws.clientKind === 'dex') {
        if (!dexRouting.isPrimaryDex(ws)) { safeSend(ws, { type: 'error', code: 'DEX_RUNTIME_STANDBY', message: 'Standby Dex tab cannot mutate room execution.' }); return; }
        const result = msg.type === 'dex_relay_start' ? dexScheduler.startRelay(msg) : msg.type === 'dex_relay_stop' ? dexScheduler.stopRelay(msg) : dexScheduler.continueRelay(msg);
        safeSend(ws, { type: 'dex_relay_result', requestId: msg.requestId || null, result }); return;
      }
      if (await providerControlRouting.handle(ws, msg)) return;
      if (ws.clientKind === 'dex' && ['select_target', 'ensure_target', 'send_prompt', 'capture_latest'].includes(msg.type)) {
        safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'DEX_SERVER_SCHEDULER_OWNS_TRANSPORT', message: 'Localhost scheduler owns Dex provider transport.' }); return;
      }
      const allowed = new Set([
        'request_tabs', 'select_target', 'ensure_target', 'send_prompt', 'capture_latest',
        'request_search_results', 'request_local_targets', 'select_local_target', 'request_local_status',
        'reload_extension', 'reload_tab'
      ]);
      if (ws.clientKind === 'dex' && !dexRouting.isPrimaryDex(ws)
          && !['request_tabs', 'request_local_targets', 'request_local_status'].includes(msg.type)) {
        safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'DEX_RUNTIME_STANDBY', message: 'Standby Dex tab cannot dispatch or mutate runtime state.' });
        return;
      }
      if (!allowed.has(msg.type)) {
        safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'BAD_UI_COMMAND', message: `Unsupported UI command: ${msg.type}` });
        return;
      }
      dexRouting.noteUiCommand(ws, msg);
      if (await handleLocalUiCommand(ws, msg)) return;
      if (msg.type === 'send_prompt') {
        if (!extensionSocket || extensionSocket.readyState !== WebSocket.OPEN) {
          safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'EXTENSION_OFFLINE', message: 'The browser extension bridge is not connected.' });
          return;
        }
        if (!extensionSessions.current().ready) {
          safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'EXTENSION_SYNC_PENDING', message: 'Waiting for an authoritative extension tab snapshot; no prompt was dispatched.' });
          return;
        }
        const gate = await durability.beforeDispatch(msg, {
          targetClassId: 'online-origin', targetId: lastTarget?.id || null, providerId: lastTarget?.providerId || null
        });
        if (!gate.ok) {
          safeSend(ws, { type: 'error', requestId: msg.requestId || null, code: 'DUPLICATE_DISPATCH_BLOCKED', message: 'Durable turn ledger blocked a duplicate online dispatch.' });
          return;
        }
        console.log(`[bridge] ui send_prompt [${msg.requestId}]: ${msg.text.slice(0, 80)}`);
      }
      else if (msg.type === 'select_target') console.log(`[bridge] ui select_target: tab ${msg.tabId}`);
      else if (msg.type === 'reload_extension') console.log('[bridge] ui reload_extension');
      else if (msg.type === 'reload_tab') console.log(`[bridge] ui reload_tab: tab ${msg.tabId}`);
      else if (msg.type === 'request_search_results') console.log(`[bridge] ui request_search_results [${msg.requestId}] stage ${msg.searchIndex ?? 0}`);
      forwardToExtension(msg, ws);
      return;
    }

    if (ws.role === 'extension') {
      if (msg.type === 'tabs_update') {
        const state = syncExtensionAuthority(extensionSessions.update(ws, msg));
        console.log(`[bridge] extension tabs_update: ${Array.isArray(msg.tabs) ? msg.tabs.length : 0} tab(s) [${state.socket === ws ? 'primary' : `standby; authoritative=${lastTabs.length}`} primary=${state.primarySessionId || 'none'} epoch=${state.primaryConnectionEpoch || 0} sessions=${state.sessionCount}]`);
        if (state.socket !== ws || !state.ready) return;
        dexScheduler.resume();
      } else if (extensionSocket !== ws) return;
      await durability.observe(msg, {
        targetClassId: 'online-origin', targetId: msg.tabId || lastTarget?.id || null,
        providerId: msg.providerId || lastTarget?.providerId || null
      }).catch(() => {});
      if (providerControlRouting.observeExtension(msg, ws) || providerTargetSpawnRouting.observe(msg)) return;
      if (qualificationRouting.observeExtension(msg)) return;
      if (msg.type === 'target_selected') {
        lastTarget = msg.target || null;
        console.log(`[bridge] extension target_selected: tab ${lastTarget?.id} (${lastTarget?.title})`);
      } else if (msg.type === 'target_lost') {
        lastTarget = null;
        console.log(`[bridge] extension target_lost: ${msg.message}`);
      } else if (msg.type === 'prompt_accepted') {
        console.log(`[bridge] extension prompt_accepted [${msg.requestId}] on tab ${msg.tabId}`);
      } else if (msg.type === 'response_final') {
        console.log(`[bridge] extension response_final [${msg.requestId}]: ${(msg.text || '').slice(0, 100)}... (${(msg.text || '').length} chars)`);
      } else if (msg.type === 'search_results_result') {
        console.log(`[bridge] extension search_results_result [${msg.requestId}] stage ${msg.searchIndex ?? 0}: ${(msg.results || []).length} page(s)`);
      } else if (msg.type === 'error') {
        console.log(`[bridge] extension error [${msg.requestId || 'n/a'}]: ${msg.code} - ${msg.message}`);
      }
      await dexScheduler.handleTransportEvent(msg);
      dexRouting.broadcastExtensionEvent(msg);
      return;
    }
    safeSend(ws, { type: 'error', code: 'HELLO_REQUIRED', message: 'Send hello before other bridge messages.' });
  });

  ws.on('close', (code, reason) => {
    providerControlRouting.dropSocket(ws); qualificationRouting.dropSocket(ws);
    if (ws.role === 'extension') {
      const state = syncExtensionAuthority(extensionSessions.drop(ws, { closeCode: Number(code) || null, closeReason: String(reason || '') }));
      if (state.wasPrimary) {
        providerTargetSpawnRouting.failAll();
        console.log(`[bridge] extension primary disconnected; ${state.socket ? `promoted standby with ${lastTabs.length} tab(s)` : 'no standby available'}`);
        broadcastUi(extensionStatus());
        if (state.socket && state.ready) {
          broadcastUi({ type: 'tabs_update', providers: lastProviders, tabs: lastTabs, target: lastTarget });
          dexScheduler.resume();
        } else if (!state.socket) {
          lastTarget = null;
          broadcastUi({ type: 'target_lost', message: 'Extension bridge disconnected.' });
          dexScheduler.transportLost();
        }
      }
    }
    if (ws.role === 'ui') console.log(`[bridge] ui disconnected [${ws.clientKind}]`);
    uiSockets.delete(ws);
    if (ws.clientKind === 'dex') dexRouting.unregisterDex(ws);
  });
  ws.on('error', (err) => console.error('[bridge] websocket error:', err.message));
});

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);
  if (url.pathname !== '/ws' || !websocketOriginAllowed(req.headers.origin, PORT)) {
    socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

server.on('close', () => { heartbeat.stop(); localTargets.stopLocalTargets(); });
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    console.log(`[Nexus Browser] UI: http://${HOST}:${PORT}`);
    console.log(`[Nexus Browser] WS: ws://${HOST}:${PORT}/ws`);
    dexScheduler.resume();
  });
}

module.exports = { server, wss, HOST, PORT, RUNTIME_URLS, SERVER_SESSION_ID, refreshLocalTargets, configureDurability, websocketOriginAllowed };
