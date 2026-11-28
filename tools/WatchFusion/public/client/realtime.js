let realtimeSocket = null;
let realtimeReconnectTimer = null, realtimeHandshakeTimer = null;
let realtimeReconnectAttempt = 0;
let realtimeFallback = null;
let realtimeStarted = false;
let realtimeRevision = -1;
let realtimeJoined = false;
let realtimeChatSequence = 0;
const realtimeChatAcks = new Map();

function acceptRealtimeState(nextState) {
  const revision = Number(nextState?.revision);
  if ((Number.isFinite(revision) && revision < realtimeRevision) || !applyIncomingRoomState(nextState)) return false;
  if (Number.isFinite(revision)) realtimeRevision = revision;
  return true;
}

function websocketUrl() {
  const base = transportBaseUrl || location.origin;
  const url = new URL('/ws', base);
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  return url.href;
}

function rejectRealtimeChats(error = new Error('Realtime chat disconnected')) {
  for (const pending of realtimeChatAcks.values()) {
    clearTimeout(pending.timer);
    pending.reject(error);
  }
  realtimeChatAcks.clear();
}

function stopRealtimeSocket() {
  realtimeStarted = false;
  realtimeJoined = false;
  rejectRealtimeChats();
  if (realtimeReconnectTimer) { clearTimeout(realtimeReconnectTimer); realtimeReconnectTimer = null; }
  if (realtimeHandshakeTimer) { clearTimeout(realtimeHandshakeTimer); realtimeHandshakeTimer = null; }
  const socket = realtimeSocket;
  realtimeSocket = null;
  if (socket) { try { socket.close(1000, 'client closing'); } catch {} }
}

function scheduleRealtimeReconnect() {
  if (!realtimeStarted || realtimeReconnectTimer) return;
  const delay = Math.min(1500, 500 * (2 ** Math.min(realtimeReconnectAttempt, 1)));
  realtimeReconnectAttempt += 1;
  realtimeReconnectTimer = setTimeout(() => {
    realtimeReconnectTimer = null;
    openRealtimeSocket();
  }, delay);
}

function promoteFallback() {
  const fallback = realtimeFallback;
  stopRealtimeSocket();
  fallback?.();
}

function openRealtimeSocket() {
  if (!realtimeStarted || realtimeSocket || !roomId || !session) return;
  try {
    const socket = new WebSocket(websocketUrl());
    realtimeSocket = socket;
    let probe=null, probeSequence=0, nextProbeAt=0;const joinedRoom=roomId,joinedMember=session.memberId;
    const clockTimer=setInterval(()=>{
      if(realtimeSocket!==socket||!realtimeStarted){clearInterval(clockTimer);return;}
      const now=Date.now();if(!realtimeJoined||socket.readyState!==WebSocket.OPEN||document.hidden||roomId!==joinedRoom||session?.memberId!==joinedMember||state?.playback?.paused||state?.playback?.ended||now<nextProbeAt)return;
      if(probe&&now-probe.sent<=1200)return;probe={id:++probeSequence,sent:now,mono:performance.now()};
      const allowance=window.watchPartyClock?.fineAllowanceMs?.();nextProbeAt=now+(Number.isFinite(allowance)&&allowance<=8?5000:1200);
      try{socket.send(JSON.stringify({type:'clock-probe',id:probe.id}));}catch{probe=null;}
    },500);
    realtimeHandshakeTimer = setTimeout(() => { if (realtimeSocket === socket && realtimeStarted && !realtimeJoined) promoteFallback(); }, 4000);
    socket.onopen = () => {
      if (realtimeSocket !== socket || !realtimeStarted) return;
      realtimeJoined = false;
      setStatus(isTryCloudflare ? 'Connected (WebSocket)' : 'Connected');
      socket.send(JSON.stringify({ type: 'join', roomId, memberId: session.memberId }));
    };
    socket.onmessage = event => {
      if (realtimeSocket !== socket || !realtimeStarted) return;
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if(payload.type==='clock-probe-ack'){
        const at=Date.now(),p=probe;if(!p||payload.id!==p.id||roomId!==joinedRoom||session?.memberId!==joinedMember)return;probe=null;
        if(at>=p.sent&&at-p.sent<=1200&&Math.abs(at-p.sent-(performance.now()-p.mono))<=3&&Number.isFinite(payload.receivedAt)&&Number.isFinite(payload.serverTime))updateServerClock(payload.serverTime,p.sent,at,payload.receivedAt);
        return;
      }
      if (payload.type === 'chat-ack') {
        const pending = realtimeChatAcks.get(String(payload.clientId || ''));
        if (!pending) return;
        clearTimeout(pending.timer);
        realtimeChatAcks.delete(String(payload.clientId || ''));
        if (payload.ok === false) pending.reject(new Error(payload.error || 'Message rejected'));
        else pending.resolve(true);
        return;
      }
      if (payload.type === 'error') {
        setStatus(payload.error || 'Realtime connection rejected');
        promoteFallback();
        return;
      }
      if (payload.type !== 'state' || !payload.state) return;
      const authorityBefore = playbackAuthorityKey(state);
      if (!acceptRealtimeState(payload.state)) return;
      realtimeJoined = true; realtimeReconnectAttempt = 0;
      if (realtimeHandshakeTimer) { clearTimeout(realtimeHandshakeTimer); realtimeHandshakeTimer = null; }
      render();
      syncPlaybackForAuthorityChange(authorityBefore);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      clearInterval(clockTimer);probe=null;
      if (realtimeSocket !== socket || !realtimeStarted) return;
      if (realtimeHandshakeTimer) { clearTimeout(realtimeHandshakeTimer); realtimeHandshakeTimer = null; }
      realtimeSocket = null;
      realtimeJoined = false;
      rejectRealtimeChats();
      if (realtimeReconnectAttempt < 1) {
        setStatus('Reconnecting…');
        scheduleRealtimeReconnect();
        return;
      }
      setStatus('Realtime fallback…');
      promoteFallback();
    };
  } catch {
    promoteFallback();
  }
}

function startRealtimeSocket(onFallback) {
  stopRealtimeSocket();
  realtimeFallback = onFallback;
  realtimeStarted = true;
  realtimeReconnectAttempt = 0;
  realtimeRevision = Number(state?.revision) || -1;
  if (!('WebSocket' in window)) {
    onFallback?.();
    return false;
  }
  openRealtimeSocket();
  return true;
}

function sendRealtimeChat(text) {
  const value = String(text || '').trim();
  if (!value || !realtimeJoined || realtimeSocket?.readyState !== WebSocket.OPEN) return null;
  const clientId = `chat-${Date.now().toString(36)}-${(++realtimeChatSequence).toString(36)}`;
  const payload = JSON.stringify({ type: 'chat', text: value, clientId });
  try {
    if (new TextEncoder().encode(payload).byteLength > 60 * 1024) return null;
  } catch {
    if (payload.length > 48 * 1024) return null;
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      realtimeChatAcks.delete(clientId);
      reject(new Error('Realtime chat acknowledgement timed out'));
    }, isTryCloudflare ? 20000 : 8000);
    realtimeChatAcks.set(clientId, { resolve, reject, timer });
    try { realtimeSocket.send(payload); }
    catch (error) {
      clearTimeout(timer);
      realtimeChatAcks.delete(clientId);
      reject(error);
    }
  });
}

window.watchPartyRealtime = {
  start: startRealtimeSocket,
  stop: stopRealtimeSocket,
  sendChat: sendRealtimeChat,
  resetRevision: revision => { realtimeRevision = Number.isFinite(Number(revision)) ? Number(revision) : -1; },
  connected: () => realtimeSocket?.readyState === WebSocket.OPEN && realtimeJoined
};
