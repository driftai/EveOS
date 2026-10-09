'use strict';

const doneWatchApi = require('../public/dex-done-watch');
const controlReceiptApi = require('./provider-control-receipt');
const { randomUUID } = require('node:crypto');

function routeDoneWatch({ action, source, command, requestId, ws, origin }, deps) {
  const { getState, saveState, broadcastState, sendResult, fail } = deps;
  const snapshot = typeof getState === 'function' ? getState() : null;
  if (!snapshot || typeof saveState !== 'function') {
    fail(ws, requestId, source, 'DEX_DONE_WATCH_UNAVAILABLE', 'Durable DONE watch storage is unavailable.', origin);
    return true;
  }
  const eligible = (snapshot.rooms || []).filter((room) => (room.members || [])
    .some((member) => controlReceiptApi.bindingMatchesSource(member.binding, source)));
  const reference = String(command.room || '').trim();
  const chosen = reference
    ? eligible.filter((room) => room.id === reference
      || String(room.name || '').toLowerCase() === reference.toLowerCase())
    : eligible;
  if (chosen.length !== 1) {
    fail(ws, requestId, source, 'DEX_DONE_WATCH_ROOM_REQUIRED', 'Specify one exact authorized room for this DONE watch.', origin);
    return true;
  }
  const room = chosen[0];
  const watcher = room.members.find((member) => controlReceiptApi.bindingMatchesSource(member.binding, source));
  if (action === 'unwatch_done') {
    const removed = doneWatchApi.disarm(room, watcher.id);
    const saved = saveState(snapshot);
    broadcastState?.(saved);
    sendResult({ sourceSocket: ws, requestId, source }, {
      ok: true, action, message: 'DONE notifications disarmed for this participant.',
      data: { roomId: room.id, removed: removed.removed }
    });
    return true;
  }
  const ref = String(command.member || '').trim();
  const targets = ref ? (room.members || []).filter((member) =>
    member.id === ref || String(member.name || '').toLowerCase() === ref.toLowerCase()) : [];
  if (ref && targets.length !== 1) {
    fail(ws, requestId, source, 'DEX_DONE_WATCH_BAD_TARGET', 'Specify a unique other room participant to watch.', origin);
    return true;
  }
  const armed = doneWatchApi.arm(room, {
    watcherMemberId: watcher.id,
    targetMemberId: targets[0]?.id || null,
    id: `done-watch-${randomUUID()}`
  });
  if (!armed.ok) {
    fail(ws, requestId, source, armed.code, armed.message, origin);
    return true;
  }
  const saved = saveState(snapshot);
  broadcastState?.(saved);
  sendResult({ sourceSocket: ws, requestId, source }, {
    ok: true,
    action,
    message: 'Armed one-shot DONE notification; no extra Dex relay turn will run.',
    data: {
      roomId: room.id,
      watchId: armed.watch.id,
      targetMemberId: armed.watch.targetMemberId,
      expiresAt: armed.watch.expiresAt
    }
  });
  return true;
}

module.exports = { routeDoneWatch };
