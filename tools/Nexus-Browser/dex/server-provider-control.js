'use strict';

const { randomUUID } = require('node:crypto');
const controlApi = require('../public/dex-provider-control');
const stateApi = require('./server-scheduler-state');
const { defaultRoom } = require('./server-human-input-route');

const SERVER_ROUTED_ACTIONS = new Set([
  'reload_extension', 'watch_done', 'unwatch_done',
  'arm_post_idle', 'post_idle_status', 'cancel_post_idle', 'report_post_idle',
  'room_budget', 'set_room_budget', 'room_log', 'tool_result_status',
  'workspace_ensure', 'terminal_targets', 'terminal_exec', 'terminal_status', 'terminal_output',
  'job_prepare', 'playwright_prepare', 'governor_prepare', 'job_status', 'job_list',
  'quorum_presence', 'quorum_open', 'quorum_vote', 'quorum_close'
]);
const ACTIONS = new Set([...controlApi.ACTIONS].filter((action) => !SERVER_ROUTED_ACTIONS.has(action)));

function createMemoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.has(key) ? values.get(key) : null,
    setItem: (key, value) => values.set(key, String(value)),
    removeItem: (key) => values.delete(key)
  };
}

function createServerProviderControl({
  getState, saveState, broadcastState = () => {}, getScheduler = () => null,
  getRuntimeState = () => ({}), now = () => new Date().toISOString(), idFactory = randomUUID
} = {}) {
  if (typeof getState !== 'function' || typeof saveState !== 'function') {
    throw new TypeError('Server provider-control requires durable state ownership.');
  }
  const storage = createMemoryStorage();

  function owns(action) { return ACTIONS.has(String(action || '').trim().toLowerCase()); }

  function execute({ source = {}, command = {}, origin = null } = {}) {
    const durable = getState();
    if (!durable) return { ok: false, code: 'DEX_ENTRY_STATE_UNAVAILABLE', message: 'Durable room state unavailable; no command executed.' };
    const runtime = getRuntimeState() || {};
    const snapshot = {
      ...durable,
      tabs: Array.isArray(runtime.tabs) ? runtime.tabs : [],
      localTargets: Array.isArray(runtime.localTargets) ? runtime.localTargets : [],
      providers: Array.isArray(runtime.providers) ? runtime.providers : []
    };
    const initialRoomIds = new Set((snapshot.rooms || []).map((room) => room.id));
    let saved = null;

    function persist() {
      const retained = new Set(snapshot.retiredRoomIds || []);
      for (const id of initialRoomIds) {
        if (!(snapshot.rooms || []).some((room) => room.id === id)) retained.add(id);
      }
      snapshot.retiredRoomIds = [...retained];
      saved = saveState(snapshot);
      broadcastState(saved);
      return saved;
    }
    function syncRoom(room) {
      const current = (getState()?.rooms || []).find((entry) => entry.id === room.id);
      if (!current) return;
      for (const key of Object.keys(room)) delete room[key];
      Object.assign(room, current);
    }
    function startRelay(room, message, budget = null) {
      persist();
      const result = getScheduler()?.startRelay?.({ roomId: room.id, sourceMessageId: message.id, budget });
      if (result?.ok) return true;
      syncRoom(room);
      return false;
    }
    function stopRoom(room, reason) {
      const result = getScheduler()?.stopRelay?.({ roomId: room.id, reason });
      if (!result?.ok) return false;
      syncRoom(room);
      return true;
    }
    function roomMessage(room, senderKind, senderId, senderName, text) {
      return stateApi.addMessage(room, {
        id: `msg-${idFactory()}`, senderKind, senderId, senderName, text, at: now()
      });
    }
    function createRoom() {
      let room;
      do { room = defaultRoom((snapshot.rooms || []).length + 1, { idFactory, now }); }
      while ((snapshot.rooms || []).some((entry) => entry.id === room.id)
        || (snapshot.retiredRoomIds || []).includes(room.id));
      return room;
    }

    const controller = controlApi.createController({
      state: snapshot, storage, roomMessage, startRelay, stopRoom, persist,
      renderAll() {}, log() {}, createRoom, uid: (prefix) => `${prefix}-${idFactory()}`,
      pendingControlAuthorized: (pending, room) => !!origin && room?.id === origin.roomId
        && pending?.commandKey === origin.commandKey && pending?.agentMessageId === origin.agentMessageId
    });
    const result = controller.handle({ source, command });
    // A failed start rolls the transient source message back in memory after the
    // scheduler rejected it. Recommit that rollback rather than leaving an orphan.
    if (!result?.ok && saved) persist();
    return result;
  }

  return { ACTIONS, owns, execute };
}

module.exports = { SERVER_ROUTED_ACTIONS, ACTIONS, createMemoryStorage, createServerProviderControl };
