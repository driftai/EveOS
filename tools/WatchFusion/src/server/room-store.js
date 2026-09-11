import crypto from 'node:crypto';
import { MAX_MESSAGES, MEMBER_STALE_MS, ROOM_TTL_MS } from './config.js';
import { now } from './http-utils.js';

const rooms = new Map();
const roomAliases = new Map();
const deletedRooms = new Map();
const sessions = new Map();

export const id = () => crypto.randomUUID();

export function safeRoomId(raw) {
  const value = String(raw || '').trim().toUpperCase();
  return /^[A-Z0-9_-]{3,32}$/.test(value) ? value : null;
}

export function safeRoomAlias(raw) {
  const value = String(raw || '').trim().toUpperCase();
  return /^[0-9]{1,12}$/.test(value) ? value : null;
}

export function clampName(value) {
  return String(value || 'Guest').trim().replace(/[<>]/g, '').slice(0, 32) || 'Guest';
}

export function makeInternalRoomId() { return crypto.randomBytes(4).toString('hex').slice(0, 6).toUpperCase(); }
export function resolveRoomId(raw) { const requested = safeRoomId(raw); return requested ? (roomAliases.get(requested) || requested) : null; }
export function hasRoom(roomId) { return rooms.has(roomId); }

export function getRoom(roomId) {
  let room = rooms.get(roomId);
  if (!room) {
    room = {
      id: roomId, alias: null, createdAt: now(), lastActivity: now(), hostId: null,
      ownerAccountId: null, ownerMemberId: null, temporaryHost: false, revision: 0,
      source: { type: 'youtube', videoId: null, originalUrl: null },
      playback: { paused: true, ended: false, position: 0, rate: 1, updatedAt: now() },
      members: new Map(), messages: [], streams: new Set()
    };
    rooms.set(roomId, room);
  }
  room.lastActivity = now();
  return room;
}

export function projectedPosition(room) {
  const playback = room.playback;
  if (playback.paused || playback.ended) return playback.position;
  return Math.max(0, playback.position + ((now() - playback.updatedAt) / 1000) * playback.rate);
}

export function publicState(room) {
  const serverTime = now();
  const publicMembers = [...room.members.values()].map(member => ({
    id: member.publicId,
    name: member.name,
    joinedAt: member.joinedAt
  }));
  return {
    roomId: room.id,
    roomCode: room.alias || null,
    joinCode: room.alias || room.id,
    hostId: room.members.get(room.hostId)?.publicId || null,
    revision: room.revision || 0,
    serverTime,
    source: room.source,
    playback: { ...room.playback, position: projectedPosition(room), updatedAt: room.playback.updatedAt, projectedAt: serverTime },
    members: publicMembers,
    temporaryHost: !!room.temporaryHost,
    messages: room.messages.map(({ id: msgId, memberId, name, text, at }) => ({
      id: msgId,
      memberId: room.members.get(memberId)?.publicId || null,
      name,
      text,
      at
    }))
  };
}

export function broadcast(room, event) {
  const payload = `data: ${JSON.stringify(event)}\n\n`;
  for (const stream of room.streams) stream.write(payload);
  try { globalThis.watchPartyRealtime?.(room.id, event); } catch {}
}

export function broadcastState(room) {
  room.revision = (Number(room.revision) || 0) + 1;
  broadcast(room, { type: 'state', state: publicState(room) });
}

export function createRoom(requestedRoomId, requestedAlias) {
  if (requestedAlias && roomAliases.has(requestedAlias)) return { error: 'room number is already in use' };
  const desiredId = /^[0-9]{1,12}$/.test(requestedRoomId) ? makeInternalRoomId() : requestedRoomId;
  if (rooms.has(desiredId)) return { error: 'room ID is already in use' };
  const room = getRoom(desiredId);
  if (requestedAlias) { room.alias = requestedAlias; roomAliases.set(requestedAlias, desiredId); }
  return { room };
}

export function joinMember(room, { requestedMemberId = '', requestedAlias = null, requestedRoomId = '', accountId, name }) {
  if (requestedAlias) {
    const mapped = roomAliases.get(requestedAlias);
    if (mapped && mapped !== room.id) return { error: 'room number is already in use' };
    room.alias = requestedAlias;
    roomAliases.set(requestedAlias, room.id);
  }
  const existing = requestedMemberId && room.members.get(requestedMemberId);
  const cleanAccountId = typeof accountId === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(accountId) ? accountId : id();
  if (existing && existing.accountId !== cleanAccountId) {
    return { error: 'session identity mismatch' };
  }
  const memberId = existing ? requestedMemberId : id();
  const cleanName = clampName(name || existing?.name);
  if (existing) {
    existing.name = cleanName;
    existing.lastSeen = now();
  } else {
    room.members.set(memberId, { id: memberId, publicId: id(), accountId: cleanAccountId, name: cleanName, joinedAt: now(), lastSeen: now() });
  }
  if (!room.ownerAccountId) {
    room.ownerAccountId = cleanAccountId;
    room.ownerMemberId = memberId;
    room.hostId = memberId;
    room.temporaryHost = false;
  } else if (room.ownerAccountId === cleanAccountId) {
    room.ownerMemberId = memberId;
    room.hostId = memberId;
    room.temporaryHost = false;
  } else if (!room.hostId || !room.members.has(room.hostId)) {
    room.hostId = memberId;
    room.temporaryHost = true;
  }
  const session = {
    memberId,
    publicId: room.members.get(memberId).publicId,
    roomId: room.id,
    roomCode: room.alias || null,
    joinCode: room.alias || room.id,
    name: cleanName,
    accountId: cleanAccountId,
    isOwner: cleanAccountId === room.ownerAccountId
  };
  sessions.set(memberId, session);
  room.lastActivity = now();
  return { session };
}

export function getMember(room, memberId) {
  const member = room.members.get(memberId) || [...room.members.values()].find(m => m.publicId === memberId);
  if (member) member.lastSeen = now();
  return member;
}

export function leaveMember(room, memberId) {
  const member = getMember(room, memberId);
  const internalId = member?.id || memberId;
  room.members.delete(internalId);
  sessions.delete(internalId);
  if (room.hostId === internalId) {
    const fallback = room.members.values().next().value;
    room.hostId = fallback?.id || null;
    room.temporaryHost = !!room.hostId && room.ownerAccountId !== fallback?.accountId;
  }
  room.lastActivity = now();
}

export function deleteRoom(roomId, room) {
  for (const stream of room.streams) stream.end();
  room.streams.clear();
  rooms.delete(roomId);
  if (room.alias) roomAliases.delete(room.alias);
  deletedRooms.set(roomId, now());
}

export function isDeleted(roomId) { return deletedRooms.has(roomId); }
export function counts() { return { rooms: rooms.size, aliases: roomAliases.size }; }

export function pruneRooms() {
  const nowMs = now(), cutoff = nowMs - ROOM_TTL_MS;
  for (const [roomId, deletedAt] of deletedRooms) {
    if (deletedAt < nowMs - 120000) deletedRooms.delete(roomId);
  }
  for (const [roomId, room] of rooms) {
    for (const [memberId, member] of room.members) {
      if (member.lastSeen < nowMs - MEMBER_STALE_MS) room.members.delete(memberId);
    }
    if (room.hostId && !room.members.has(room.hostId)) {
      const fallback = room.members.values().next().value;
      room.hostId = fallback?.id || null;
      room.temporaryHost = !!room.hostId && room.ownerAccountId !== fallback?.accountId;
    }
    if (room.members.size === 0 && room.streams.size === 0 && room.lastActivity < cutoff) {
      rooms.delete(roomId);
      if (room.alias) roomAliases.delete(room.alias);
    }
  }
}

export function appendChat(room, member, text) {
  const clean = String(text || '').trim().slice(0, 500);
  if (!clean) return false;
  room.messages.push({ id: id(), memberId: member.id, name: member.name, text: clean, at: now() });
  if (room.messages.length > MAX_MESSAGES) room.messages.splice(0, room.messages.length - MAX_MESSAGES);
  return true;
}
