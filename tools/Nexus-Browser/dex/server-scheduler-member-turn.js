'use strict';

const stateApi = require('./server-scheduler-state');
const recoveryMailbox = require('./recovery-mailbox');

function createMemberTurnStarter({ load, save, currentRoomId, maintenanceBusy, processSoon, now }) {
  return function startMemberTurn({ roomId, sourceMessageId, memberId, purpose = 'direct-member-turn' } = {}) {
    if (maintenanceBusy()) return { ok: false, code: 'POST_IDLE_LEASE_BUSY', message: 'Post-idle local handoff holds the exclusive relay-start lease.' };
    const snapshot = load(), room = stateApi.roomById(snapshot, roomId);
    const source = stateApi.messageById(room, sourceMessageId), member = stateApi.memberById(room, memberId);
    if (!room || !source) return { ok: false, code: 'DEX_RELAY_SOURCE_NOT_FOUND', message: 'Relay source message is unavailable.' };
    if (!member || member.relayEnabled === false || !member.binding)
      return { ok: false, code: 'DEX_RELAY_MEMBER_UNAVAILABLE', message: 'The selected room member is not eligible for relay.' };
    if (currentRoomId() === room.id || room.recovery || room.pendingTurn || room.relay?.waitingFor || (room.deferredRelays || []).length)
      return { ok: false, code: 'DEX_RELAY_BUSY', message: 'That Dex room already has pending or active work.' };
    room.relay = room.relay || {};
    Object.assign(room.relay, { active: true, remaining: 0, turnBudgetTotal: 1,
      scheduledTurns: 1, lastStopReason: `Running ${purpose}` });
    stateApi.queueTurn(room, member, source, now(), 0);
    recoveryMailbox.stageForPending(room);
    save(snapshot); processSoon(0);
    return { ok: true, roomId, memberId: member.id, purpose };
  };
}

module.exports = { createMemberTurnStarter };
