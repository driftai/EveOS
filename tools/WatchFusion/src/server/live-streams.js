import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { broadcastState, getMember, getRoom, hasRoom, publicState, resolveRoomId } from './room-store.js';
import { json, readBody } from './http-utils.js';
import { observeLinkedPlayout } from './presentation-routes.js';
import { parseYoutubeUrl } from './youtube.js';
import { networkProbeStats } from './network.js';
import { createRelayLoopWitness } from './relay-loop-witness.js';
import { PROJECT_ROOT } from './config.js';
import { attachMaintenanceUnlink, publisherProvenance } from './maintenance-unlink.js';
import { trustedExtensionIds } from './extension-identity.js';

const streams = new Map();
let maintenanceControl=()=>null;
const token = () => crypto.randomBytes(24).toString('hex');
const send = (socket, data) => { if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(data)); };
const text = (value, limit = 200) => String(value || '').slice(0, limit);
const authorized = (stream, secret) => stream && secret === stream.publisherToken;
const navigationReasons=new Set(['playlist-row','native-index','native-player','verified-playlist-link','playlist-ambiguous','playlist-adjacent-unavailable','playlist-unverified','verified-indexed-link','playlist-current-ambiguous','playlist-index-missing','playlist-boundary','playlist-selection-mismatch','playlist-index-conflict','playlist-index-target-missing','playlist-panel-missing','native-unavailable','invalid-page','probe-disabled','probe-execution-error','no-source-tab','source-tab-unavailable','source-link-changed','no-execution-ack','probe-delivery-error','source-disconnected','request-conflict']);
function navigationStatus(socket,id,action,outcome,reason,target='',index=0){
  if(!Number.isSafeInteger(id)||id<=0||!['next','prev'].includes(action))return;
  if(!['accepted','rejected','unknown'].includes(outcome))outcome='unknown';
  if(!navigationReasons.has(reason))reason='no-execution-ack';
  target=typeof target==='string'&&/^[A-Za-z0-9_-]{11}$/.test(target)?target:'';
  index=Number.isSafeInteger(index)&&index>0&&index<=999999?index:0;
  send(socket,{type:'status',status:`wf-navigation-result|${id}|${action}|${outcome}|${reason}|${target}|${index}`});
}
function navigationRequest(stream,socket,credential,action,id,at){
  const requests=stream.navigationRequests??=new Map();
  for(const [key,request] of requests)if(at-request.at>12000||request.socket.readyState!==WebSocket.OPEN||request.publisher!==stream.publisher)requests.delete(key);
  if(stream.publisher?.readyState!==WebSocket.OPEN){navigationStatus(socket,id,action,'rejected','source-disconnected');return false;}
  if(requests.has(id)||requests.size>=16){navigationStatus(socket,id,action,'rejected','request-conflict');return false;}
  requests.set(id,{socket,credential,action,at,publisher:stream.publisher});return true;
}
function navigationResult(stream,publisher,message,at){
  const request=stream.navigationRequests?.get(message.value);
  if(!request||request.publisher!==publisher||request.action!==message.action||at-request.at>12000)return;
  stream.navigationRequests.delete(message.value);
  const c=request.credential;
  if(!(roomAccess(c.roomId,c.memberId,stream.id)?.host||(!stream.linkedMemberId&&c.owner)))return;
  navigationStatus(request.socket,message.value,message.action,message.outcome,message.reason,message.target,message.index);
}
export function ownsLinkedSource(room, member, proof) {
  const stream = streams.get(room.linkedSourceId);
  return !!member && !!stream && stream.linkedMemberId === member.id && stream.roomId === room.id
    && proof?.id === stream.id && authorized(stream, proof.token);
}
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
  if (!getMember(room, memberId) || streams.get(streamId)?.roomId !== room.id) return null;
  if (room.source?.streamId !== streamId && room.linkedSourceId !== streamId) return null;
  return { room, host: room.hostId === memberId };
}
function audioSyncSample(value = {}) {
  const estimatedPlayoutTimestamp = Number(value.estimatedPlayoutTimestamp);
  if (!Number.isFinite(estimatedPlayoutTimestamp) || estimatedPlayoutTimestamp <= 0) return null;
  return {
    estimatedPlayoutTimestamp,
    nativeOutputLatencyMs: Math.max(0, Math.min(1000, Number(value.nativeOutputLatencyMs) || 0)),
    appliedDelayMs: Math.max(0, Math.min(1000, Number(value.appliedDelayMs) || 0)),
    auto: value.auto !== false,
    at: Date.now()
  };
}
function broadcastAudioSync(stream) {
  const now = Date.now();
  for (const [id, sample] of stream.syncSamples) {
    if (!stream.viewers.has(id) || now - sample.at > 3500) stream.syncSamples.delete(id);
  }
  const samples = [...stream.syncSamples.entries()];
  if (samples.length < 2) {
    for (const [id] of samples) send(stream.viewers.get(id), { type:'audio-sync', available:false, peers:samples.length, delayMs:0 });
    return;
  }
  const values = samples.map(([id, sample]) => {
    const natural = sample.estimatedPlayoutTimestamp - sample.nativeOutputLatencyMs;
    const reference = natural - (sample.auto ? 0 : sample.appliedDelayMs);
    return { id, natural, reference };
  });
  const clocks = values.map(value => value.natural);
  if (Math.max(...clocks) - Math.min(...clocks) > 5000) return;
  const target = Math.min(...values.map(value => value.reference));
  for (const value of values) {
    const delayMs = Math.max(0, Math.min(1000, Math.round(value.natural - target)));
    send(stream.viewers.get(value.id), { type:'audio-sync', available:true, peers:values.length, delayMs });
  }
}
function dispose(stream) {
  streams.delete(stream.id);
  let detachedRoom;
  if (stream.linkedMemberId && hasRoom(stream.roomId)) {
    const room = getRoom(stream.roomId);
    if (room.linkedSourceId === stream.id) {
      room.linkedSourceId = null;
      broadcastState(room);
      detachedRoom = room;
    }
  }
  stream.syncSamples.clear();
  for (const socket of [stream.publisher, ...stream.viewers.values()]) socket?.close(1000, 'Live source stopped');
  return detachedRoom;
}
export async function handleLiveRoute(req, res, parts) {
  if (parts[0] !== 'api' || parts[1] !== 'live') return false;
  if(parts[2]==='maintenance-unlink'){
    const ctl=maintenanceControl();
    if(!ctl||!ctl.authorized(req))return json(res,403,{ok:false,code:'MAINTENANCE_AUTH_REQUIRED'});
    const body=await readBody(req,{maxBytes:1024}),result=ctl.execute(req,body);return json(res,result.status,result.body);
  }
  if (req.method !== 'POST' || !sameOrigin(req)) return json(res, 403, { error: 'Open this control in WatchFusion.' });
  const body = await readBody(req, { maxBytes: 4096 });
  if (!parts[2]) {
    if (streams.size >= 16) return json(res, 429, { error: 'Stop an unused live source first.' });
    const stream = { id: crypto.randomUUID(), publisherToken: token(), viewerToken: token(), viewers: new Map(), syncSamples: new Map(), publisher: null, metadata: {}, at: Date.now() };
    streams.set(stream.id, stream);
    return json(res, 201, { id: stream.id, publisherToken: stream.publisherToken, viewerToken: stream.viewerToken });
  }
  const stream = streams.get(parts[2]);
  if (!authorized(stream, body.publisherToken)) return json(res, 403, { error: 'Live source ownership required.' });
  stream.at = Date.now();
  if (parts[3] === 'stop') {
    const room = dispose(stream);
    return json(res, 200, { ok: true, ...(room ? { state: publicState(room) } : {}) });
  }
  if (parts[3] === 'room') {
    const id = resolveRoomId(body.roomId);
    const room = id && hasRoom(id) ? getRoom(id) : null;
    const memberId = String(req.headers['x-member-id'] || '');
    if (!room || !getMember(room, memberId) || room.hostId !== memberId) return json(res, 403, { error: 'Only the current host can share a live source.' });
    if (body.mode === 'linked-tab') {
      if (stream.roomId && (stream.roomId !== room.id || stream.linkedMemberId !== memberId)) {
        return json(res, 409, { error: 'Source already belongs to a different session.' });
      }
      stream.roomId = room.id;
      stream.linkedMemberId = memberId;
      room.linkedSourceId = stream.id;
      broadcastState(room);
      return json(res, 200, { ok: true, state: publicState(room) });
    }
    if (stream.linkedMemberId) return json(res, 409, { error: 'Source belongs to a linked tab.' });
    stream.roomId = room.id;
    room.linkedSourceId = null;
    room.source = { kind: 'live', type: 'live', streamId: stream.id, title: text(body.title) || 'Live media', mode: body.mode === 'audioflix' ? 'audioflix' : 'tab' };
    broadcastState(room);
    return json(res, 200, { ok: true, state: publicState(room) });
  }
  return json(res, 404, { error: 'Unknown live action.' });
}
function relayLinkedPlayout(stream, raw = {}) {
  if (!stream.linkedMemberId || !hasRoom(stream.roomId)) return;
  const room = getRoom(stream.roomId, {touch:false}), state = stream.metadata;
  if (room.linkedSourceId !== stream.id || room.hostId !== stream.linkedMemberId || !room.members.has(stream.linkedMemberId) || !room.source) return;
  const matches = room.source.videoId ? parseYoutubeUrl(state.pageUrl) === room.source.videoId : state.pageUrl === (room.source.originalUrl || room.source.url);
  if (!matches) return;
  observeLinkedPlayout(room, {
    outputSession:stream.id, sampledAt:raw.serverSampledAt ?? state.relayReceivedAt, positionMs:state.currentTime * 1000,
    uncertaintyMs:raw.uncertaintyMs, tabMuted:raw.tabMuted === true, ready:!state.status && raw.currentTime != null,
    playing:!state.paused && !state.ended && Math.abs(state.rate - room.playback.rate) < .01, buffering:state.buffering
  }, state.relayReceivedAt);
}
// Per-publisher clock-offset floor: excess transit delay is measurable even without a shared wall clock.
// Reject only negotiated linked-source telemetry; legacy live publishers are unchanged.
function sourceDelivery(raw,now,state){
  if(!Number.isSafeInteger(raw?.deliverySeq)||raw.deliverySeq<=0)return null;
  const seq=raw.deliverySeq,sent=raw.publisherSentAt,sampled=raw.sampledAt;
  if(seq<=state.seq||!Number.isFinite(sent)||!Number.isFinite(sampled)||sampled<=0||sent<sampled||sent-sampled>900||sent<=state.sent)return {seq,accept:false,lag:0};
  state.seq=seq;state.sent=sent;const transit=now-sent;
  state.floor=Math.min(state.floor,transit);const lag=Math.max(0,Math.round(transit-state.floor));
  const qualified=Number.isFinite(raw.serverSampledAt)&&raw.serverSampledAt>0&&Number.isFinite(raw.uncertaintyMs)&&raw.uncertaintyMs>=0&&raw.uncertaintyMs<=75;
  const age=qualified?now-raw.serverSampledAt-raw.uncertaintyMs:sent-sampled+lag;
  return {seq,accept:lag<=900&&age<=900&&(!qualified||now-raw.serverSampledAt>=-50),lag:Math.min(60000,lag)};
}
function metadata(value = {}) {
  const pageUrl = /^https?:\/\//i.test(String(value.pageUrl || '')) ? text(value.pageUrl, 2048) : '';
  const relayReceivedAt = Date.now();
  // Relay the exact timestamp already used by the independent source coordinator.
  const qualifiedStamp = Number.isFinite(value.serverSampledAt) && Number.isFinite(value.uncertaintyMs) &&
    value.uncertaintyMs >= 0 && value.uncertaintyMs <= 75 && value.serverSampledAt > 0 &&
    relayReceivedAt - value.serverSampledAt >= -50 && relayReceivedAt - value.serverSampledAt <= 1500;
  return { ...(qualifiedStamp ? {serverSampledAt:value.serverSampledAt, uncertaintyMs:value.uncertaintyMs} : {}), title: text(value.title), group: text(value.group), pageUrl, paused: !!value.paused, ended: !!value.ended, buffering: value.buffering === true,
    sampledAt: Math.max(0, Number(value.sampledAt) || 0),
    ...(typeof value.tabMuted === 'boolean' ? {tabMuted:value.tabMuted} : {}), ...(typeof value.sourcePlayerSilenced === 'boolean' ? {sourcePlayerSilenced:value.sourcePlayerSilenced} : {}),
    publisherReceivedAt: Math.max(0, Number(value.publisherReceivedAt) || 0),
    publisherSentAt: Math.max(0, Number(value.publisherSentAt) || 0), relayReceivedAt,
    ...Object.fromEntries(['probeRefreshes','probeRefreshSkipped','muteAudits','publisherBufferBytes','publisherSkipped','publisherRejected','publisherAckRttMs'].filter(k=>Number.isSafeInteger(value[k])&&value[k]>=0&&value[k]<=1000000).map(k=>[k,value[k]])),
    currentTime: Math.max(0, Number(value.currentTime) || 0), duration: Math.max(0, Number(value.duration) || 0),
    rate: Math.min(4, Math.max(0.25, Number(value.rate) || 1)),
    volume: pageUrl && !Number.isFinite(value.volume) ? null : Math.min(1, Math.max(0, Number(value.volume) || 0)),
    index: Math.max(0, Number(value.index) || 0), shuffle: !!value.shuffle, loop: !!value.loop,
    status: text(value.status), queue: Array.isArray(value.queue) ? value.queue.slice(0, 500).map(item => ({ id: text(item.id, 100), title: text(item.title) })) : [] };
}
export function attachLiveStreams(server) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 128 * 1024, perMessageDeflate: false });
  const extensionIds=new Set(trustedExtensionIds());
  maintenanceControl=attachMaintenanceUnlink(server,{root:PROJECT_ROOT,streams,dispose,eligible:(stream,id)=>{
    if(!extensionIds.has(id)||stream.maintenancePublisherOrigin!==id||stream.publisher?.readyState!==WebSocket.OPEN||!Number.isSafeInteger(stream.metadata?.deliverySeq)||stream.metadata.deliverySeq<=0)return false;
    if(!stream.roomId)return !stream.linkedMemberId;
    if(!stream.linkedMemberId||!hasRoom(stream.roomId))return false;
    const room=getRoom(stream.roomId,{touch:false});return room.linkedSourceId===stream.id&&room.hostId===stream.linkedMemberId&&room.members.has(stream.linkedMemberId);
  }});
  server.on('upgrade', (req, socket, head) => {
    if (String(req.url).split('?')[0] !== '/live-ws') return;
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  const loopWitness=createRelayLoopWitness();let loopAt=performance.now(),loopDelay=0,loopDelayAt=0;
  const loopMonitor=setInterval(()=>{const now=performance.now(),delay=Math.max(0,now-loopAt-250);loopAt=now;if(delay>100||now-loopDelayAt>1500){loopDelay=Math.min(60000,Math.round(delay));loopDelayAt=now;}loopWitness.setActive([...streams.values()].some(x=>x.linkedMemberId&&x.publisher?.readyState===WebSocket.OPEN));loopWitness.sample();},250);loopMonitor.unref?.();
  wss.on('connection', (socket,request) => {
    let stream, peerId, publisher = false, credential;
    let count = 0, windowAt = Date.now();const delivery={seq:0,sent:0,floor:Infinity};
    const authTimer = setTimeout(() => socket.close(1008, 'Authentication required'), 5000);
    socket.on('message', raw => {
      try {
        const receivedAt = Date.now();
        if (receivedAt - windowAt > 1000) { count = 0; windowAt = Date.now(); }
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
            stream.publisher?.close(1000, 'Publisher replaced'); stream.publisher = socket;stream.maintenancePublisherOrigin=publisherProvenance(request);
            send(socket, { type: 'ready', iceServers: iceServers() });
            for (const [id, viewer] of stream.viewers) { send(socket, { type: 'viewer', peer: id }); send(viewer, { type: 'status', status: 'Source connected' }); }
          } else {
            peerId = crypto.randomUUID(); stream.viewers.set(peerId, socket);
            send(socket, { type: 'ready', iceServers: iceServers(), peer: peerId });
            if(!stream.metadata.deliverySeq||Date.now()-stream.metadata.relayReceivedAt<=900)send(socket, { type: 'metadata', metadata: { ...stream.metadata, relaySentAt: Date.now() } });
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
          const proof=sourceDelivery(message.metadata,receivedAt,delivery);
          if(proof){send(socket,{type:'status',status:`wf-source-receipt|${proof.seq}|${proof.accept?'accepted':'rejected'}`});if(!proof.accept)return;}
          stream.metadata = metadata(message.metadata);
          if(proof){Object.assign(stream.metadata,{deliverySeq:proof.seq,relayLagMs:proof.lag,relayLoopDelayMs:loopDelay});const witness=loopWitness.current();if(witness)Object.assign(stream.metadata,{relayLoopSequence:witness.sequence,relayLoopKind:witness.kind,relayLoopCallbackMs:witness.callbackMs,relayLoopProcessCpuMs:witness.processCpuMs});
            if(typeof networkProbeStats==='function'){const n=networkProbeStats();Object.assign(stream.metadata,{relayNetworkProbeMs:n.ms,relayNetworkProbeSequence:n.sequence,relayNetworkProbeAgeMs:n.ageMs,relaySyncNetworkProbeMs:n.syncMs,relaySyncNetworkProbeSequence:n.syncSequence,relaySyncNetworkProbeAgeMs:n.syncAgeMs});}}
          relayLinkedPlayout(stream, message.metadata);
          for (const viewer of stream.viewers.values()) {if(proof&&(viewer.bufferedAmount||0)>65536)continue;send(viewer, { type: 'metadata', metadata: { ...stream.metadata, relaySentAt: Date.now() } });}
        } else if (publisher && message.type === 'navigation-result') {
          navigationResult(stream,socket,message,receivedAt);
        } else if (!publisher && message.type === 'sync-sample' && stream.roomId) {
          const sample = audioSyncSample(message.sample);
          if (sample) { stream.syncSamples.set(peerId, sample); broadcastAudioSync(stream); }
        } else if (!publisher && message.type === 'control') {
          const roomHost = roomAccess(credential.roomId, credential.memberId, stream.id)?.host;
          const canControl = roomHost || (!stream.linkedMemberId && credential.owner);
          if (!canControl) return send(socket, { type: 'status', status: 'Only the host controls this live source.' });
          if (!['play', 'pause', 'toggle', 'seek', 'rate', 'volume', 'prev', 'next', 'jump', 'shuffle', 'loop'].includes(message.action)) return;
          const value=Number(message.value)||0;
          if(['next','prev'].includes(message.action)&&Number.isSafeInteger(value)&&value>0&&!navigationRequest(stream,socket,credential,message.action,value,receivedAt))return;
          send(stream.publisher, { type: 'control', action: message.action, value });
        } else if (message.type === 'ping') send(socket, {type:'pong', sentAt:message.sentAt, receivedAt, serverTime:Date.now()});
      } catch { send(socket, { type: 'status', status: 'Invalid live message' }); }
    });
    socket.on('close', () => {
      clearTimeout(authTimer);
      if (!stream) return;
      if (publisher && stream.publisher === socket) {
        stream.publisher = null;
        stream.navigationRequests?.clear();
        for (const viewer of stream.viewers.values()) send(viewer, { type: 'status', status: 'Source disconnected · waiting for it to return' });
      } else if (peerId) {
        stream.viewers.delete(peerId);
        for(const [id,request] of stream.navigationRequests||[])if(request.socket===socket)stream.navigationRequests.delete(id);
        stream.syncSamples.delete(peerId);
        broadcastAudioSync(stream);
        send(stream.publisher, { type: 'left', peer: peerId });
      }
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
  timer.unref(); server.on('close', () => { clearInterval(timer);clearInterval(loopMonitor);loopWitness.close(); for (const stream of streams.values()) dispose(stream); wss.close(); });
}
