'use strict';
// Localhost owns read-only room inspection and budget changes. Never relay a
// history query or silently replay an interrupted prompt.
const protocol = require('../public/dex-protocol');
const mailbox = require('./recovery-mailbox');
const stateApi = require('./server-scheduler-state');
const ACTIONS = new Set(['room_budget', 'set_room_budget', 'room_log']);
const MAX_PAGE = 25, MAX_PAGE_CHARS = 14000;
function resolveRoom(snapshot, source, reference) {
  const rooms = (snapshot.rooms || []).filter((r) => mailbox.matchingMember(r, source));
  if (!rooms.length) return { error: 'DEX_ROOM_NOT_BOUND', message: 'This exact participant is not bound to any Dex room.' };
  let eligible = rooms;
  if (reference) {
    const key = String(reference).trim().toLowerCase();
    eligible = rooms.filter((r) => r.id === reference || String(r.name || '').toLowerCase() === key);
  }
  if (eligible.length !== 1) return { error: eligible.length ? 'DEX_ROOM_AMBIGUOUS' : 'DEX_ROOM_NOT_FOUND',
    message: eligible.length ? 'Specify the unique authorized room ID.' : 'No matching authorized Dex room.' };
  return { room: eligible[0] };
}
function budgetStatus(room) {
  const total = Number(room.relay?.turnBudgetTotal);
  const remaining = Math.max(0, Number(room.relay?.remaining || 0));
  const known = Number.isInteger(total) && total >= 1;
  const scheduled = Number.isInteger(room.relay?.scheduledTurns) ? room.relay.scheduledTurns
    : (known ? Math.max(0, total - remaining) : null);
  return {
    roomId: room.id, configuredTurns: stateApi.safeBudget(room.settings?.maxTurns, 8),
    allocatedTurns: known ? total : null, scheduledTurns: scheduled, unusedTurnsDiscarded: known && !room.relay?.active ? Math.max(0, total - scheduled) : 0,
    remainingTurns: remaining,
    inFlight: !!room.relay?.waitingFor || !!room.pendingTurn || (!!room.recovery && !room.recovery.passiveAt),
    relayActive: !!room.relay?.active,
    recoveryPending: !!room.recovery,
    queuedHandoffs: (room.deferredRelays || []).length,
    stoppedReason: room.relay?.lastStopReason || 'Idle',
    maxAllowedTurns: protocol.MAX_RELAY_TURNS,
    contextPolicy: 'one latest prior message per room agent',
    contextOverrideLimit: 40
  };
}
function roomLog(room, command = {}) {
  const limit = command.limit == null ? 10 : Number(command.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_PAGE)
    return { ok: false, code: 'DEX_ROOM_LOG_BAD_LIMIT', message: 'limit must be an integer between 1 and 25.' };
  const full = command.full === true;
  if (full && limit > 5) return { ok: false, code: 'DEX_ROOM_LOG_FULL_LIMIT',
    message: 'Full transcripts are limited to five messages per page; use before to page backward.' };
  const entries = (room.messages || []).filter((m) =>
    m.senderKind === 'agent' || m.senderKind === 'user' || (command.includeSystem === true && m.senderKind === 'system'));
  let end = entries.length;
  if (command.before != null) {
    end = entries.findIndex((m) => m.id === command.before);
    if (end < 0) return { ok: false, code: 'DEX_ROOM_LOG_BAD_CURSOR',
      message: 'before must be a message ID returned from an earlier room_log page.' };
  }
  const wanted = entries.slice(Math.max(0, end - limit), end);
  let available = MAX_PAGE_CHARS, returned = [];
  for (let i = wanted.length - 1; i >= 0; i--) {
    const m = wanted[i];
    const raw = String(m.text || '');
    const body = full ? raw.slice(0, 8000) : protocol.projectContextText(raw, 1400);
    if (available < body.length + 200) break;
    available -= body.length + 200;
    returned.unshift({
      id: m.id, senderId: m.senderId || null, senderName: m.senderName || m.senderKind,
      kind: m.senderKind, at: m.at || null, text: body,
      truncated: body.length < raw.length
    });
  }
  const nextBefore = returned[0]?.id || null;
  const nextIndex = nextBefore == null ? end : entries.findIndex((m) => m.id === nextBefore);
  return { ok: true, action: 'room_log',
    message: 'Private room transcript page returned to the requesting participant only; no room message or relay created.',
    data: { roomId: room.id, total: entries.length, returned: returned.length, messages: returned,
      nextBefore: nextIndex > 0 ? nextBefore : null,
      hasMore: nextIndex > 0, pageLimit: MAX_PAGE,
      ...(nextIndex === end && wanted.length > 0 ? { limitHint: 'Lower limit or request full:false to fit large entries.' } : {}) }
  };
}
function execute(snapshot, { source, command, at = new Date().toISOString() } = {}) {
  const action = String(command?.action || '').toLowerCase();
  if (!ACTIONS.has(action)) return null;
  const resolved = resolveRoom(snapshot, source || {}, command.room);
  if (!resolved.room) return { snapshot, changed: false,
    result: { ok: false, code: resolved.error, message: resolved.message } };
  const room = resolved.room;
  if (action === 'room_budget') return { snapshot, changed: false, result: {
    ok: true, action, message: 'Current durable relay budget and room state.', data: budgetStatus(room) } };
  if (action === 'room_log') return { snapshot, changed: false,
    result: roomLog(room, command) };
  const turns = Number(command.turns);
  if (!Number.isInteger(turns) || turns < 1 || turns > protocol.MAX_RELAY_TURNS)
    return { snapshot, changed: false, result: { ok: false, code: 'DEX_BUDGET_INVALID',
      message: 'turns must be an integer between 1 and 500.' } };
  if (room.recovery || room.pendingTurn || room.relay?.active || room.relay?.waitingFor)
    return { snapshot, changed: false, result: { ok: false, code: 'DEX_BUDGET_BUSY',
      message: 'Cannot replace an active/in-flight budget. Append [[DEX:BUDGET:+N]] during your own relay reply, or retry after safe recovery.' } };
  room.settings = room.settings || {};
  room.settings.maxTurns = turns;
  room.settings.budgetRevision = Math.max(0, Number(room.settings.budgetRevision || 0)) + 1;
  room.updatedAt = at;
  return { snapshot, changed: true, resume: command.resume === true, roomId: room.id, turns,
    result: { ok: true, action, message: command.resume === true
      ? 'Updated default room budget; attempting one new relay from the last committed message.'
      : 'Updated default budget for the next relay. This does not replay an older turn.',
      data: budgetStatus(room) } };
}
async function route(request, deps) {
  const { source, command, requestId, ws, origin } = request;
  const { getState, saveState, broadcastState, getScheduler, now, sendResult, commitOriginReceipt } = deps;
  const executed = execute(getState(), { source, command, at: new Date(now()).toISOString() });
  if (!executed) return false;
  if (executed.changed) {
    const saved = saveState(executed.snapshot);
    broadcastState?.(saved);
    if (executed.resume) {
      const next = getScheduler?.()?.continueRelay({ roomId: executed.roomId, budget: executed.turns });
      const resumed = !!next?.ok;
      executed.result.data = { ...executed.result.data,
        resumed, resumeError: resumed ? null : (next?.code || 'DEX_RELAY_NOT_AVAILABLE') };
      executed.result.message += resumed ? ' One new relay scheduled.' : ' Relay not started; settings are saved. Inspect status before another attempt.';
    }
  }
  // A read-only history lookup is private to the caller: a durable room
  // control receipt may contain only metadata, never the fetched log text.
  const receiptResult = command.action === 'room_log' && executed.result.ok
    ? { ...executed.result, data: { roomId: executed.result.data.roomId,
      returned: executed.result.data.returned, hasMore: executed.result.data.hasMore } }
    : executed.result;
  const receipt = commitOriginReceipt(origin, receiptResult, requestId);
  sendResult({ sourceSocket: ws, requestId, source }, executed.result, receipt);
  return true;
}
module.exports = { ACTIONS, MAX_PAGE, resolveRoom, budgetStatus, roomLog, execute, route };
