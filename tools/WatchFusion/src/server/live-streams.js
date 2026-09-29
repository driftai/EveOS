import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { broadcastState, getMember, getRoom, hasRoom, publicState, resolveRoomId } from './room-store.js';
import { json, readBody } from './http-utils.js';

const streams = new Map();
const token = () => crypto.randomBytes(24).toString('hex');
const send = (socket, data) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
const text = (value, limit = 200) => String(value || '').slice(0, limit);
const authorized = (stream, secret) => stream && secret === stream.publisherToken;
function iceServers() {
  try { const value = JSON.parse(process.env.WATCHFUSION_ICE_SERVERS || '[]'); return Array.isArray(value) ? value.slice(0, 8) : []; }
  catch { return []; }
}
function sameOrigin(req) {
  if (req.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  try { return new URL(origin).host === req.headers.host; } catch { return false; }
}
function roomAccess(roomId, memberId, streamId) {
  const id = resolveRoomId(roomId);
  if (!id || !hasRoom(id)) return null;
  const room = getRoom(id);
  if (!getMember(room, memberId) || room.source?.streamId !== streamId || streams.get(streamId)?.roomId !== room.id) return null;
  return { room, host: room.hostId === memberId };
}
function dispose(stream) {
  streams.delete(stream.id);
  for (const socket of [stream.publisher, ...stream.viewers.values()]) socket?.close(1000, 'Live source stopped');
}
export async function handleLiveRoute(req, res, parts) {
  if (parts[0] !== 'api' || parts[1] !== 'live') return false;
  if (req.method !== 'POST' || !sameOrigin(req)) return json(res, 403, { error: 'Open this control in WatchFusion.' });
  const body = await readBody(req, { maxBytes: 4096 });
  if (!parts[2]) {
    if (streams.size >= 16) return json(res, 429, { error: 'Stop an unused live source first.' });
    const stream = { id: crypto.randomUUID(), publisherToken: token(), viewerToken: token(), viewers: new Map(), publisher: null, metadata: {}, at: Date.now() };
    streams.set(stream.id, stream);
    return json(res, 201, { id: stream.id, publisherToken: stream.publisherToken, viewerToken: stream.viewerToken });
  }
  const stream = streams.get(parts[2]);
  if (!authorized(stream, body.publisherToken)) return json(res, 403, { error: 'Live source ownership required.' });
  stream.at = Date.now();
  if (parts[3] === 'stop') { dispose(stream); return json(res, 200, { ok: true }); }
  if (parts[3] === 'room') {
    const id = resolveRoomId(body.roomId);
    const room = id && hasRoom(id) ? getRoom(id) : null;
    const memberId = String(req.headers['x-member-id'] || '');
    if (!room || !getMember(room, memberId) || room.hostId !== memberId) return json(res, 403, { error: 'Only the current host can share a live source.' });
    stream.roomId = room.id;
    room.source = { kind: 'live', type: 'live', streamId: stream.id, title: text(body.title) || 'Live media', mode: body.mode === 'audioflix' ? 'audioflix' : 'tab' };
    broadcastState(room);
    return json(res, 200, { ok: true, state: publicState(room) });
  }
  return json(res, 404, { error: 'Unknown live action.' });
}
function metadata(value = {}) {
  return { title: text(value.title), group: text(value.group), paused: !!value.paused,
    currentTime: Math.max(0, Number(value.currentTime) || 0), duration: Math.max(0, Number(value.duration) || 0),
    rate: Math.min(4, Math.max(0.25, Number(value.rate) || 1)), volume: Math.min(1, Math.max(0, Number(value.volume) || 0)),
    index: Math.max(0, Number(value.index) || 0), shuffle: !!value.shuffle, loop: !!value.loop,
    status: text(value.status), queue: Array.isArray(value.queue) ? value.queue.slice(0, 500).map(item => ({ id: text(item.id, 100), title: text(item.title) })) : [] };
}
export function attachLiveStreams(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  server.on('upgrade', (req, socket, head) => {
    if (String(req.url).split('?')[0] !== '/live-ws') return;
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws));
  });
  wss.on('connection', socket => {
    let stream, peerId, publisher = false, credential;
    let count = 0, windowAt = Date.now();
    const authTimer = setTimeout(() => socket.close(1008, 'Authentication required'), 5000);
    socket.on('message', raw => {
      try {
        if (Date.now() - windowAt > 1000) { count = 0; windowAt = Date.now(); }
        if (++count > 100) return socket.close(1008, 'Too many messages');
        const message = JSON.parse(raw);
        if (!stream) {
          const candidate = streams.get(message.id);
          if (message.type !== 'join' || !candidate) return socket.close(1008, 'Live source expired');
          publisher = message.role === 'publisher' && authorized(candidate, message.token);
          credential = { roomId: message.roomId, memberId: text(message.memberId, 100), owner: authorized(candidate, message.token), solo: message.token === candidate.viewerToken };
          if (!publisher && !credential.owner && !credential.solo && !roomAccess(credential.roomId, credential.memberId, candidate.id)) return socket.close(1008, 'Live source access denied');
          if (message.role === 'publisher' && !publisher) return socket.close(1008, 'Publisher access denied');
          if (!publisher && candidate.viewers.size >= 16) return socket.close(1008, 'Live viewer limit reached');
          stream = candidate; stream.at = Date.now(); clearTimeout(authTimer);
          if (publisher) {
            stream.publisher?.close(1000, 'Publisher replaced'); stream.publisher = socket;
            send(socket, { type: 'ready', iceServers: iceServers() });
            for (const [id, viewer] of stream.viewers) { send(socket, { type: 'viewer', peer: id }); send(viewer, { type: 'status', status: 'Source connected' }); }
          } else {
            peerId = crypto.randomUUID(); stream.viewers.set(peerId, socket);
            send(socket, { type: 'ready', iceServers: iceServers(), peer: peerId });
            send(socket, { type: 'metadata', metadata: stream.metadata });
            send(socket, { type: 'status', status: stream.publisher ? 'Connecting live media…' : 'Waiting for source…' });
            send(stream.publisher, { type: 'viewer', peer: peerId });
          }
          return;
        }
        if (!streams.has(stream.id)) return socket.close(1008, 'Source stopped');
        if (publisher && stream.publisher !== socket) return socket.close(1008, 'Publisher replaced');
        if (!publisher && !credential.owner && !credential.solo && !roomAccess(credential.roomId, credential.memberId, stream.id)) return socket.close(1008, 'Room source changed');
        stream.at = Date.now();
        if (message.type === 'signal') {
          const payload = message.signal;
          if (!payload || typeof payload !== 'object') return;
          const signal = payload.description ? { description: { type: payload.description.type, sdp: text(payload.description.sdp, 64000) } } : { candidate: payload.candidate };
          send(publisher ? stream.viewers.get(message.peer) : stream.publisher, { type: 'signal', peer: publisher ? message.peer : peerId, signal });
        } else if (publisher && message.type === 'metadata') {
          stream.metadata = metadata(message.metadata);
          for (const viewer of stream.viewers.values()) send(viewer, { type: 'metadata', metadata: stream.metadata });
        } else if (!publisher && message.type === 'control') {
          const canControl = credential.owner || roomAccess(credential.roomId, credential.memberId, stream.id)?.host;
          if (!canControl) return send(socket, { type: 'status', status: 'Only the host controls this live source.' });
          if (!['play', 'pause', 'toggle', 'seek', 'rate', 'volume', 'prev', 'next', 'jump', 'shuffle', 'loop'].includes(message.action)) return;
          send(stream.publisher, { type: 'control', action: message.action, value: Number(message.value) || 0 });
        } else if (message.type === 'ping') send(socket, { type: 'pong' });
      } catch { send(socket, { type: 'status', status: 'Invalid live message' }); }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (!stream) return;
      if (publisher && stream.publisher === socket) {
        stream.publisher = null;
        for (const viewer of stream.viewers.values()) send(viewer, { type: 'status', status: 'Source disconnected · waiting for it to return' });
      } else if (peerId) { stream.viewers.delete(peerId); send(stream.publisher, { type: 'left', peer: peerId }); }
    });
    socket.on('error', () => {});
  });
  const timer = setInterval(() => {
    for (const stream of streams.values()) {
      for (const [id, viewer] of stream.viewers) {
        if (viewer.readyState !== WebSocket.OPEN) stream.viewers.delete(id);
      }
      if (Date.now() - stream.at > 120000) dispose(stream);
    }
  }, 30000);
  timer.unref(); server.on('close', () => { clearInterval(timer); for (const stream of streams.values()) dispose(stream); wss.close(); });
}
