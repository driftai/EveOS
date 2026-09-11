let realtimeSocket = null;
let realtimeReconnectTimer = null;
let realtimeReconnectAttempt = 0;
let realtimeFallback = null;
let realtimeStarted = false;
let realtimeRevision = -1;

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

function stopRealtimeSocket() {
  realtimeStarted = false;
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
      setStatus(isTryCloudflare ? 'Connected (WebSocket)' : 'Connected');
      socket.send(JSON.stringify({ type: 'join', roomId, memberId: session.memberId }));
    };
    socket.onmessage = event => {
      let payload;
      try { payload = JSON.parse(event.data); } catch { return; }
      if (payload.type === 'error') {
        setStatus(payload.error || 'Realtime connection rejected');
        promoteFallback();
        return;
      }
      if (payload.type !== 'state' || !payload.state) return;
      if (!acceptRealtimeState(payload.state)) return;
      render();
      syncPlayer();
    };
    socket.onerror = () => {};
    socket.onclose = () => {
      if (realtimeSocket !== socket || !realtimeStarted) return;
      realtimeSocket = null;
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

window.watchPartyRealtime = {
  start: startRealtimeSocket,
  stop: stopRealtimeSocket,
  resetRevision: revision => { realtimeRevision = Number.isFinite(Number(revision)) ? Number(revision) : -1; },
  connected: () => realtimeSocket?.readyState === WebSocket.OPEN
};
