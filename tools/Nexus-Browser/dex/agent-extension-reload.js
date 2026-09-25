'use strict';
const { roomBusy } = require('./provider-orchestration-policy');

// Server-owned reload for exactly bound browser chats; never runs agent shell commands.
function createAgentExtensionReload({
  getState = () => ({}), getExtension = () => ({}), hasPending = () => false,
  safeSend = () => false, recordIncident = () => {},
  now = () => Date.now(), sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timeoutMs = 20000, cooldownMs = 60000
} = {}) {
  let active = null;
  let last = null;

  function sameBoundSession(binding = {}, source = {}) {
    if (binding.targetClassId !== 'online-origin' || source.targetClassId !== 'online-origin'
      || binding.providerId !== source.providerId) return false;
    if (binding.targetId == null || String(binding.targetId) !== String(source.targetId)) return false;
    return !binding.url || binding.url === source.url;
  }
  function authorize(source, command, transportRole) {
    if (transportRole !== 'provider-control-extension' || source?.targetClassId !== 'online-origin') {
      return { ok: false, code: 'DEX_RELOAD_ONLINE_REQUIRED', message: 'Extension reload requires a verified bound browser chat, not a local CLI or UI socket.' };
    }
    const roomId = String(command?.room || '').trim();
    if (!roomId) return { ok: false, code: 'DEX_RELOAD_ROOM_REQUIRED', message: 'Specify your exact authorized room id.' };
    const rooms = getState()?.rooms || [];
    const room = rooms.find((r) => r.id === roomId);
    if (!room || !(room.members || []).some((member) => sameBoundSession(member.binding, source))) {
      return { ok: false, code: 'DEX_RELOAD_NOT_BOUND', message: 'This exact browser chat is not bound to that Dex room. Rebind the chat before requesting a global extension reload.' };
    }
    if (rooms.some(roomBusy) || hasPending()) {
      return { ok: false, code: 'DEX_RELOAD_BUSY', message: 'An active/pending Dex room or provider-control operation prevents an extension reload. Retry after work is idle.' };
    }
    return { ok: true, roomId };
  }
  function observeExtension(message, socket) {
    if (!active || message?.type !== 'reloading_extension'
      || message.requestId !== active.requestId || socket !== active.originalSocket) return false;
    active.acked = true;
    return true;
  }
  function providerControlConnected(socket) {
    if (active && active.dispatched) active.newBridgeSocket = socket;
  }
  function dropSocket(socket) {
    if (active?.newBridgeSocket === socket) active.newBridgeSocket = null;
  }
  function diagnostics() {
    return {
      active: active ? { requestId: active.requestId, roomId: active.roomId, acked: active.acked, startedAt: active.startedAt } : null,
      last: last ? { ...last } : null
    };
  }
  async function run({ source, command, requestId, transportRole }) {
    const authorization = authorize(source, command, transportRole);
    if (!authorization.ok) return { result: authorization };
    const key = [source.providerId, source.targetId, source.url || '', authorization.roomId].join('|');
    if (active) return { result: { ok: false, code: 'DEX_RELOAD_IN_PROGRESS', message: 'An extension reload is already in progress.' } };
    if (last?.ok && last.key === key && now() - last.completedAt < cooldownMs) {
      return { result: { ok: true, action: 'reload_extension', message: 'Extension already reloaded and reconnected recently; duplicate request suppressed.', data: { roomId: authorization.roomId, connectionEpoch: last.afterEpoch, deduplicated: true } } };
    }
    const state = getExtension();
    if (!state?.ready || !state.socket || !Number.isInteger(state.epoch) || state.sessionCount !== 1) {
      return { result: { ok: false, code: 'DEX_RELOAD_EXTENSION_UNAVAILABLE', message: 'Requires one authoritative, fully synced extension connection; check Nexus diagnostics first.' } };
    }
    if (!Array.isArray(state.targets) || !state.targets.some((target) =>
      String(target.id) === String(source.targetId) && target.providerId === source.providerId
      && (!target.url || target.url === source.url))) {
      return { result: { ok: false, code: 'DEX_RELOAD_TARGET_NOT_READY', message: 'The requesting browser tab is not in the authoritative extension target snapshot. Refresh targets or rebind before reload.' } };
    }
    const runState = {
      requestId, roomId: authorization.roomId, originalSocket: state.socket,
      beforeEpoch: state.epoch, startedAt: now(), dispatched: false,
      acked: false, newBridgeSocket: null
    };
    active = runState;
    if (!safeSend(state.socket, { type: 'reload_extension', requestId })) {
      active = null;
      return { result: { ok: false, code: 'DEX_RELOAD_DISPATCH_FAILED', message: 'Extension reload was not dispatched.' } };
    }
    runState.dispatched = true;
    const deadline = now() + timeoutMs;
    let result;
    let resultSocket = null;
    while (now() < deadline) {
      const current = getExtension();
      if (runState.acked && current?.ready && current.epoch > runState.beforeEpoch
        && current.sessionCount === 1 && runState.newBridgeSocket) {
        resultSocket = runState.newBridgeSocket;
        result = {
          ok: true, action: 'reload_extension',
          message: 'Nexus Browser extension reloaded, published a fresh target snapshot, and its provider-control channel reconnected.',
          data: { roomId: runState.roomId, beforeEpoch: runState.beforeEpoch, connectionEpoch: current.epoch }
        };
        break;
      }
      await sleep(100);
    }
    if (!result) {
      const current = getExtension();
      resultSocket = runState.newBridgeSocket;
      result = {
        ok: false, code: 'DEX_RELOAD_OUTCOME_UNKNOWN',
        message: 'Reload requested but acknowledgement plus fresh extension snapshot and control-channel reconnect were not all verified. Inspect diagnostics; do not blindly repeat.',
        data: { roomId: runState.roomId, acked: runState.acked, beforeEpoch: runState.beforeEpoch, observedEpoch: current?.epoch ?? null, ready: !!current?.ready }
      };
      try { recordIncident({ code: result.code, source: 'agent-extension-reload', requestId, roomId: runState.roomId, evidence: result.data }); } catch {}
    }
    last = { ok: result.ok, key, requestId, roomId: runState.roomId, beforeEpoch: runState.beforeEpoch,
      afterEpoch: getExtension()?.epoch ?? null, completedAt: now(), resultCode: result.code || null };
    active = null;
    return { result, socket: resultSocket };
  }
  return { run, authorize, observeExtension, providerControlConnected, dropSocket, diagnostics };
}
module.exports = { createAgentExtensionReload };
