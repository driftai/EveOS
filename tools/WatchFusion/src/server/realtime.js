import { WebSocketServer, WebSocket } from 'ws';
import { getMember, getRoom, hasRoom, publicState, resolveRoomId } from './room-store.js';

const MAX_PAYLOAD = 64 * 1024;
let wss = null;
const roomSockets = new Map();

function send(socket, payload) {
  if (socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify(payload));
}

function addRoomSocket(roomId, socket) {
  let set = roomSockets.get(roomId);
  if (!set) { set = new Set(); roomSockets.set(roomId, set); }
  set.add(socket);
  socket.roomId = roomId;
}

function removeRoomSocket(socket) {
  const roomId = socket.roomId;
  if (!roomId) return;
  const set = roomSockets.get(roomId);
  if (!set) return;
  set.delete(socket);
  if (!set.size) roomSockets.delete(roomId);
  socket.roomId = null;
}

export function broadcastRealtime(roomId, event) {
  const set = roomSockets.get(roomId);
  if (!set) return;
  for (const socket of set) send(socket, event);
}

globalThis.watchPartyRealtime = broadcastRealtime;

export function attachRealtime(server) {
  wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });
  wss.on('connection', socket => {
    socket.isAlive = true;
    socket.on('pong', () => { socket.isAlive = true; });

    socket.on('message', raw => {
      let message;
      try { message = JSON.parse(raw.toString()); } catch { return send(socket, { type: 'error', error: 'invalid JSON' }); }
      if (!message || message.type !== 'join') return send(socket, { type: 'error', error: 'first message must be join' });
      const roomId = resolveRoomId(message.roomId);
      const memberId = String(message.memberId || '');
      if (!roomId || !hasRoom(roomId)) return send(socket, { type: 'error', error: 'room not found' });
      const room = getRoom(roomId);
      if (!getMember(room, memberId)) return send(socket, { type: 'error', error: 'member not joined' });
      removeRoomSocket(socket);
      addRoomSocket(roomId, socket);
      send(socket, { type: 'state', state: publicState(room), transport: 'websocket' });
    });
    socket.on('close', () => removeRoomSocket(socket));
    socket.on('error', () => removeRoomSocket(socket));
  });

  const heartbeat = setInterval(() => {
    for (const sockets of roomSockets.values()) for (const socket of sockets) {
      if (!socket.isAlive) { try { socket.terminate(); } catch {} continue; }
      socket.isAlive = false;
      try { socket.ping(); } catch {}
    }
  }, 15000);
  heartbeat.unref();

  server.on('upgrade', (request, socket, head) => {
    try {
      const url = new URL(request.url, `http://${request.headers.host || 'localhost'}`);
      if (url.pathname !== '/ws') return socket.destroy();
      wss.handleUpgrade(request, socket, head, ws => wss.emit('connection', ws, request));
    } catch { socket.destroy(); }
  });
  return wss;
}
