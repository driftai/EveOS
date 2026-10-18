function iso(value) {
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : 0;
}

function stop(room, reason) {
  room.relay = room.relay || {};
  room.relay.active = false;
  room.relay.waitingFor = null;
  room.relay.remaining = 0;
  room.relay.lastStopReason = reason;
}

function repairSnapshot(snapshot, {
  now = Date.now(), maxRecoveryAgeMs = 24 * 60 * 60 * 1000,
  restartRecovery = false
} = {}) {
  const value = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const rooms = Array.isArray(value.rooms) ? value.rooms : [];
  const repairs = [];
  const issues = [];

  for (const room of rooms) {
    room.members = Array.isArray(room.members) ? room.members : [];
    room.messages = Array.isArray(room.messages) ? room.messages : [];
    room.relay = room.relay || { active: false, remaining: 0, waitingFor: null, lastStopReason: 'Idle' };

    const memberIds = new Set(room.members.map((member) => member?.id).filter(Boolean));
    const messageIds = new Set(room.messages.map((message) => message?.id).filter(Boolean));
    const recovery = room.recovery || null;

    if (restartRecovery && Array.isArray(room.localToolResults)) {
      for (const result of room.localToolResults) {
        if (!result || result.state !== 'claimed') continue;
        result.state = 'outcome-unknown';
        repairs.push({
          roomId: room.id,
          requestId: result.requestId || null,
          code: 'ORPHANED_LOCAL_TOOL_RESULT_CLAIM'
        });
      }
    }

    if (room.relay.active && !room.members.length) {
      stop(room, 'Deterministic repair · active room had no participants');
      repairs.push({ roomId: room.id, code: 'ACTIVE_WITHOUT_MEMBERS' });
    }

    if (!recovery && room.relay.waitingFor && !memberIds.has(room.relay.waitingFor)) {
      stop(room, 'Deterministic repair · waiting participant no longer exists');
      repairs.push({ roomId: room.id, code: 'MISSING_WAITING_MEMBER' });
    }

    if (recovery) {
      const validMember = memberIds.has(recovery.memberId);
      const validSource = messageIds.has(recovery.sourceMessageId);
      const started = iso(recovery.interruptedAt || recovery.startedAt);
      const stale = started > 0 && now - started > maxRecoveryAgeMs;
      if (!validMember || !validSource || stale) {
        delete room.recovery;
        stop(room, stale
          ? 'Deterministic repair · expired interrupted-turn recovery'
          : 'Deterministic repair · invalid interrupted-turn recovery metadata');
        repairs.push({
          roomId: room.id,
          code: stale ? 'STALE_RECOVERY' : 'INVALID_RECOVERY_METADATA'
        });
      }
    }

    if (!room.relay.active && !room.recovery) {
      if (room.relay.waitingFor != null || Number(room.relay.remaining || 0) !== 0) {
        room.relay.waitingFor = null;
        room.relay.remaining = 0;
        repairs.push({ roomId: room.id, code: 'STOPPED_RELAY_RESIDUE' });
      }
    }

    const duplicateIds = room.members.map((member) => member?.id).filter(Boolean);
    if (new Set(duplicateIds).size !== duplicateIds.length) {
      issues.push({ roomId: room.id, code: 'DUPLICATE_MEMBER_ID' });
    }
  }

  return { snapshot: { ...value, rooms }, repairs, issues };
}

module.exports = { iso, repairSnapshot };
