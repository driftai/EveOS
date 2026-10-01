let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeReconnectAttempt = 0;
let realtimeFallback = null;
let realtimeStarted = false;
let realtimeRevision = -1;
let realtimeJoined = false;
let realtimeChatSequence = 0;
const realtimeChatAcks = new Map();

function acceptRealtimeState(nextState) {
  const revision = Number(nextState?.revision);
  if (Number.isFinite(revision)) {
    if (revision < realtimeRevision) return false;
    realtimeRevision = revision;
  }
  state = nextState;
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
    socket.onopen = () => {
      realtimeReconnectAttempt = 0;
      realtimeJoined = false;
      setStatus(isTryCloudflare ? 'Connected (WebSocket)' : 'Connected');
      socket.send(JSON.stringify({ type: 'join', roomId, memberId: session.memberId }));
    };
    socket.onmessage = event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
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
      realtimeJoined = true;
      const authorityBefore = playbackAuthorityKey(state);
      if (!acceptRealtimeState(payload.state)) return;
      render();
      syncPlaybackForAuthorityChange(authorityBefore);
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (realtimeSocket !== socket || !realtimeStarted) return;
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
