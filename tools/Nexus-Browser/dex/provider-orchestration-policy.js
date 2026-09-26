const MAX_MANAGED_AGENTS = 4;

function sameSource(binding = {}, source = {}) {
  if (binding.targetClassId !== source.targetClassId || binding.providerId !== source.providerId) return false;
  if (binding.targetId != null && source.targetId != null && String(binding.targetId) === String(source.targetId)) return true;
  return !!binding.url && !!source.url && binding.url === source.url;
}

function findRoom(snapshot = {}, ref = '') {
  const wanted = String(ref || '').trim().toLowerCase();
  if (!wanted) return null;
  return (snapshot.rooms || []).find((room) => String(room.id) === String(ref))
    || (snapshot.rooms || []).find((room) => String(room.name || '').trim().toLowerCase() === wanted)
    || null;
}

function roomBusy(room) {
  return !!room?.relay?.active || !!room?.relay?.waitingFor || !!room?.pendingTurn || !!room?.recovery
    || !!room?.pendingProviderControlReceipt || !!room?.deferredRelays?.length;
}

function managedMembers(snapshot = {}) {
  return (snapshot.rooms || []).flatMap((room) =>
    (room.members || []).filter((member) => member.binding?.managedByDex === true)
  );
}

function sourceMember(room, source) {
  return (room?.members || []).find((member) => sameSource(member.binding, source)) || null;
}

function resolveMember(room, ref = '') {
  const wanted = String(ref || '').trim().toLowerCase();
  if (!wanted) return null;
  return (room?.members || []).find((member) => String(member.id) === String(ref))
    || (room?.members || []).find((member) => String(member.name || '').trim().toLowerCase() === wanted)
    || null;
}

function authorizeRoom(snapshot, source, command) {
  if (source?.targetClassId !== 'online-origin') {
    return { ok: false, code: 'DEX_CONTROL_ONLINE_REQUIRED', message: 'Managed browser-agent orchestration is available only to verified Online-Origin agents.' };
  }
  if (!String(command?.room || '').trim()) {
    return { ok: false, code: 'DEX_CONTROL_ROOM_REQUIRED', message: 'Managed browser-agent orchestration requires an explicit room id or exact name.' };
  }
  const room = findRoom(snapshot, command.room);
  const member = room ? sourceMember(room, source) : null;
  if (!room || !member) {
    return { ok: false, code: 'DEX_CONTROL_ROOM_NOT_FOUND', message: 'That room is not authorized for this exact provider chat/session.' };
  }
  if (roomBusy(room)) {
    const currentSourceTurn = room.relay?.active === true
      && room.relay?.waitingFor === member.id
      && (!room.recovery?.memberId || room.recovery.memberId === member.id);
    return {
      ok: false,
      code: 'DEX_CONTROL_ROOM_BUSY',
      message: `Dex room ${room.name} is busy. Wait for the relay to stop before changing managed workers.`,
      waitForSourceTurn: currentSourceTurn
    };
  }
  return { ok: true, room, sourceMember: member };
}

function authorizeSpawn(snapshot, source, command) {
  const base = authorizeRoom(snapshot, source, command);
  if (!base.ok) return base;
  if (!String(command?.providerId || '').trim()) {
    return { ok: false, code: 'DEX_CONTROL_PROVIDER_REQUIRED', message: 'spawn_agent requires a providerId.' };
  }
  const managed = managedMembers(snapshot);
  if (managed.length >= MAX_MANAGED_AGENTS) {
    return { ok: false, code: 'DEX_CONTROL_SPAWN_LIMIT', message: `Dex already has ${managed.length} managed browser workers; the current limit is ${MAX_MANAGED_AGENTS}.` };
  }
  return { ok: true, roomId: base.room.id };
}

function authorizeDespawn(snapshot, source, command) {
  const base = authorizeRoom(snapshot, source, command);
  if (!base.ok) return base;
  const member = resolveMember(base.room, command?.member);
  if (!member) return { ok: false, code: 'DEX_CONTROL_MEMBER_NOT_FOUND', message: 'despawn_agent requires an exact managed member id or name.' };
  if (member.id === base.sourceMember.id) {
    return { ok: false, code: 'DEX_CONTROL_SELF_DESPAWN', message: 'A provider may not despawn its own controlling chat/session.' };
  }
  if (member.binding?.managedByDex !== true || member.binding?.targetClassId !== 'online-origin') {
    return { ok: false, code: 'DEX_CONTROL_NOT_MANAGED', message: 'That participant is not a Dex-managed browser worker. Use remove_agent for ordinary bindings.' };
  }
  return {
    ok: true,
    roomId: base.room.id,
    memberId: member.id,
    target: {
      targetId: member.binding.targetId,
      providerId: member.binding.providerId,
      url: member.binding.url || ''
    }
  };
}

module.exports = {
  MAX_MANAGED_AGENTS, sameSource, findRoom, roomBusy, managedMembers,
  sourceMember, resolveMember, authorizeRoom, authorizeSpawn, authorizeDespawn
};
