'use strict';

const stateApi = require('./server-scheduler-state');
const recoveryMailbox = require('./recovery-mailbox');
const protocol = require('../public/dex-protocol');

function continuationState(value, source, member) {
  const remaining = Number(value?.remaining), scheduledTurns = Number(value?.scheduledTurns);
  const turnBudgetTotal = Number(value?.turnBudgetTotal);
  if (value?.version !== 1 || source?.controlReceipt?.executorMemberId !== member?.id
      || !Number.isInteger(remaining) || remaining < 1
      || !Number.isInteger(scheduledTurns) || scheduledTurns < 1
      || !Number.isInteger(turnBudgetTotal) || turnBudgetTotal !== scheduledTurns + remaining
      || turnBudgetTotal > protocol.MAX_RELAY_TURNS) return null;
  return { active: true, remaining: remaining - 1, turnBudgetTotal,
    scheduledTurns: scheduledTurns + 1, lastStopReason: 'Running provider-control receipt continuation' };
}

function createMemberTurnStarter({ load, save, currentRoomId, maintenanceBusy, processSoon, now }) {
  return function startMemberTurn({ roomId, sourceMessageId, memberId, purpose = 'direct-member-turn', relayContinuation = null } = {}) {
    if (maintenanceBusy()) return { ok: false, code: 'POST_IDLE_LEASE_BUSY', message: 'Post-idle local handoff holds the exclusive relay-start lease.' };
    const snapshot = load(), room = stateApi.roomById(snapshot, roomId);
    const source = stateApi.messageById(room, sourceMessageId), member = stateApi.memberById(room, memberId);
    if (!room || !source) return { ok: false, code: 'DEX_RELAY_SOURCE_NOT_FOUND', message: 'Relay source message is unavailable.' };
    if (!member || member.relayEnabled === false || !member.binding)
      return { ok: false, code: 'DEX_RELAY_MEMBER_UNAVAILABLE', message: 'The selected room member is not eligible for relay.' };
    if (currentRoomId() === room.id || room.recovery || room.pendingTurn || room.relay?.waitingFor || (room.deferredRelays || []).length)
      return { ok: false, code: 'DEX_RELAY_BUSY', message: 'That Dex room already has pending or active work.' };
    const continuation = relayContinuation ? continuationState(relayContinuation, source, member) : null;
    if (relayContinuation && !continuation)
      return { ok: false, code: 'DEX_RELAY_CONTINUATION_INVALID', message: 'The provider-control receipt continuation did not match its exact member or physical turn budget.' };
    room.relay = room.relay || {};
    Object.assign(room.relay, continuation || { active: true, remaining: 0, turnBudgetTotal: 1,
      scheduledTurns: 1, lastStopReason: `Running ${purpose}` });
    stateApi.queueTurn(room, member, source, now(), 0);
    recoveryMailbox.stageForPending(room);
    save(snapshot); processSoon(0);
    return { ok: true, roomId, memberId: member.id, purpose };
  };
}

module.exports = { continuationState, createMemberTurnStarter };
