(() => {
  function ensureGeminiLinkAudioModule() {
    if (globalThis.BrowserAiBridgeGeminiLinkAudio || typeof document === 'undefined') return;
    if (document.querySelector('script[data-nexus-gemini-link-audio]')) return;
    const script = document.createElement('script');
    script.src = '/gemini-link-audio.js?v=71d418e084d0';
    script.async = false;
    script.dataset.nexusGeminiLinkAudio = '1';
    document.head.appendChild(script);
  }

  ensureGeminiLinkAudioModule();

  function createClient({
    url, hello, onMessage = () => {}, onOpen = () => {},
    onPhase = () => {}, onMalformed = () => {},
    reconnectDelayMs = 300, reconnectMaxDelayMs = 2000, disconnectGraceMs = 8000,
    WebSocketImpl = globalThis.WebSocket, timers = globalThis
  } = {}) {
    let socket = null;
    let reconnectTimer = null;
    let disconnectTimer = null;
    let phase = 'connecting';
    let epoch = 0;
    let reconnectAttempt = 0;
    let stopped = false;

    function snapshot(extra = {}) {
      return { phase, epoch, dispatchReady: phase === 'connected', ...extra };
    }
    function transition(next, extra = {}) {
      if (phase === next && !Object.keys(extra).length) return snapshot();
      phase = next;
      const value = snapshot(extra);
      onPhase(value);
      return value;
    }
    function clearDisconnectTimer() {
      if (disconnectTimer != null) timers.clearTimeout(disconnectTimer);
      disconnectTimer = null;
    }
    function send(payload) {
      if (!socket || socket.readyState !== WebSocketImpl.OPEN || phase !== 'connected') return false;
      const outgoing = payload?.type === 'send_prompt' && !Number.isFinite(Number(payload.clientSentAt))
        ? { ...payload, clientSentAt: Date.now() } : payload;
      socket.send(JSON.stringify(outgoing));
      return true;
    }
    function connect() {
      if (stopped || (socket && [WebSocketImpl.OPEN, WebSocketImpl.CONNECTING].includes(socket.readyState))) return false;
      if (reconnectTimer != null) timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      if (phase !== 'reconnecting') transition('connecting');
      const next = new WebSocketImpl(typeof url === 'function' ? url() : url);
      socket = next;
      next.addEventListener('open', () => {
        if (socket !== next) return;
        clearDisconnectTimer();
        reconnectAttempt = 0;
        epoch += 1;
        transition('connected');
        if (hello) send(typeof hello === 'function' ? hello() : hello);
        onOpen(snapshot());
      });
      next.addEventListener('message', (event) => {
        try {
          const message = JSON.parse(event.data);
          if (globalThis.BrowserAiBridgeGeminiLinkAudio?.handle?.(message) === true) return;
          onMessage(message);
        } catch (error) { onMalformed(error); }
      });
      next.addEventListener('close', (event = {}) => {
        if (socket !== next) return;
        socket = null;
        if (stopped) return;
        transition('reconnecting', { closeCode: event.code || null, closeReason: String(event.reason || '') });
        clearDisconnectTimer();
        disconnectTimer = timers.setTimeout(() => {
          disconnectTimer = null;
          if (phase !== 'connected') transition('disconnected');
        }, disconnectGraceMs);
        const delay = Math.min(reconnectMaxDelayMs,
          reconnectDelayMs * (2 ** Math.min(reconnectAttempt, 3)));
        reconnectAttempt += 1;
        reconnectTimer = timers.setTimeout(connect, delay);
      });
      next.addEventListener('error', () => {
        try { if (next.readyState !== WebSocketImpl.CLOSED) next.close(); } catch {}
      });
      return true;
    }
    function stop() {
      stopped = true;
      clearDisconnectTimer();
      if (reconnectTimer != null) timers.clearTimeout(reconnectTimer);
      reconnectTimer = null;
      socket?.close?.();
      socket = null;
    }

    return { connect, send, stop, snapshot: () => snapshot() };
  }

  const api = { createClient };
  globalThis.BrowserAiBridgeUiSocket = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
