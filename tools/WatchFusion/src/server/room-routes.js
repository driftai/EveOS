import {
  appendChat,
  broadcast,
  broadcastState,
  clampName,
  createRoom,
  deleteRoom,
  getMember,
  getRoom,
  hasRoom,
  id,
  isDeleted,
  joinMember,
  leaveMember,
  projectedPosition,
  publicState,
  resolveRoomId,
  safeRoomAlias,
  safeRoomId
} from './room-store.js';
import { json, now, readBody } from './http-utils.js';
import { parseYoutubeUrl, youtubeUrlFromId } from './youtube.js';

function validAccountId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(value);
}
function sessionAccountId(value) { return validAccountId(value) ? value : id(); }

export async function handleRoomRoute(req, res, url, parts) {
  const requestedRoomId = safeRoomId(parts[2]);
  if (!requestedRoomId) return json(res, 400, { error: 'invalid room id' });
  const roomId = resolveRoomId(requestedRoomId);
  const existingRoom = roomId ? getExistingRoom(roomId) : null;
  const isCreate = req.method === 'POST' && parts[3] === 'create';
  if (!existingRoom && !isCreate) {
    return json(res, 404, {
      error: /^[0-9]{1,12}$/.test(requestedRoomId) ? 'room number not found or room is no longer active' : 'room not found',
      roomCode: /^[0-9]{1,12}$/.test(requestedRoomId) ? requestedRoomId : null
    });
  }
  if (existingRoom && isDeleted(roomId)) return json(res, 410, { error: 'room deleted' });
  if (isCreate) return createRoomRoute(req, res, requestedRoomId);
  const room = existingRoom;
  if (req.method === 'GET' && !parts[3]) {
    return json(res, 200, { ok: true, roomId: room.id, roomCode: room.alias || null, joinCode: room.alias || room.id, state: publicState(room) });
  }
  if (req.method === 'POST' && parts[3] === 'join') return joinRoomRoute(req, res, room, requestedRoomId, roomId);
  const memberId = String(req.headers['x-member-id'] || url.searchParams.get('memberId') || '');
  const member = getMember(room, memberId);
  if (!member) return json(res, 401, { error: 'join the room first' });
  if (req.method === 'GET' && parts[3] === 'events') return openEvents(req, res, room);
  if (req.method === 'POST' && parts[3] === 'ping') return json(res, 200, { ok: true, serverTime: now() });
  if (req.method === 'POST' && parts[3] === 'leave') {
    leaveMember(room, memberId);
    broadcastState(room);
    return json(res, 200, { ok: true });
  }
  if (req.method === 'POST' && parts[3] === 'command') return commandRoute(req, res, room, roomId, memberId, member);
  return false;
}

function getExistingRoom(roomId) { return roomId && hasRoom(roomId) ? getRoom(roomId) : null; }

async function createRoomRoute(req, res, requestedRoomId) {
  const body = await readBody(req);
  const alias = safeRoomAlias(body.roomCode || body.alias || requestedRoomId);
  const created = createRoom(requestedRoomId, alias);
  if (created.error) return json(res, 409, { error: created.error, roomCode: alias || null });
  return json(res, 201, { roomId: created.room.id, roomCode: created.room.alias || null, joinCode: created.room.alias || created.room.id });
}

async function joinRoomRoute(req, res, room, requestedRoomId, roomId) {
  const body = await readBody(req);
  const requestedAlias = safeRoomAlias(body.roomCode || body.alias || requestedRoomId);
  const joined = joinMember(room, {
    requestedMemberId: typeof body.memberId === 'string' ? body.memberId : '',
    requestedAlias,
    requestedRoomId,
    accountId: sessionAccountId(body.accountId),
    name: clampName(body.name)
  });
  if (joined.error) return json(res, 409, { error: joined.error, roomCode: requestedAlias || null });
  broadcastState(room);
  return json(res, 200, { session: joined.session, state: publicState(room) });
}

function openEvents(req, res, room) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-store, must-revalidate',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write(`data: ${JSON.stringify({ type: 'state', state: publicState(room) })}\n\n`);
  room.streams.add(res);
  const heartbeat = setInterval(() => res.write(': ping\n\n'), 15000);
  req.on('close', () => { clearInterval(heartbeat); room.streams.delete(res); });
}

async function commandRoute(req, res, room, roomId, memberId, member) {
  const body = await readBody(req);
  const isHost = member.id === room.hostId || memberId === room.hostId;
  if (['play', 'pause', 'seek', 'rate', 'source', 'transfer-host'].includes(body.type) && !isHost) {
    return json(res, 403, { error: 'only the current host controls this action' });
  }
  const type = body.type;
  if (type === 'delete-room') {
    broadcast(room, { type: 'room-deleted', roomId });
    deleteRoom(roomId, room);
    return json(res, 200, { ok: true, deleted: true });
  }
  if (type === 'transfer-host') {
    const target = getMember(room, String(body.targetMemberId || ''));
    if (!target) return json(res, 404, { error: 'target member is no longer in the room' });
    room.hostId = target.id;
    room.temporaryHost = target.accountId !== room.ownerAccountId;
  } else if (type === 'source') {
    if (body.source && typeof body.source === 'object') {
      room.source = body.source;
    } else {
      const videoId = parseYoutubeUrl(body.input);
      if (!videoId) return json(res, 400, { error: 'enter a valid YouTube URL or video ID' });
      room.source = { type: 'youtube', videoId, originalUrl: youtubeUrlFromId(videoId) };
    }
    room.playback = { paused: true, ended: false, position: 0, rate: 1, updatedAt: now() };
  } else if (type === 'play') {
    const replayingEnded = !!room.playback.ended;
    room.playback.position = replayingEnded ? 0 : (Number(body.position) || 0);
    room.playback.paused = false;
    room.playback.ended = false;
    room.playback.updatedAt = now();
  } else if (type === 'pause') {
    room.playback.position = Number(body.position) || projectedPosition(room);
    room.playback.paused = true;
    room.playback.ended = !!body.ended;
    room.playback.updatedAt = now();
  } else if (type === 'seek') {
    room.playback.position = Math.max(0, Number(body.position) || 0);
    room.playback.paused = false;
    room.playback.ended = false;
    room.playback.updatedAt = now();
  } else if (type === 'rate') {
    room.playback.position = projectedPosition(room);
    room.playback.rate = Math.min(2, Math.max(0.25, Number(body.rate) || 1));
    room.playback.ended = false;
    room.playback.updatedAt = now();
  } else if (type === 'chat') {
    if (!appendChat(room, member, body.text)) return json(res, 400, { error: 'empty message' });
  } else return json(res, 400, { error: 'unknown command' });

  room.lastActivity = now();
  broadcastState(room);
  return json(res, 200, { ok: true, state: publicState(room) });
}
