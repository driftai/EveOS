(() => {
  // Room selection and transcript rendering stay available to human observers.
  // Structural edits are independently gated by dex-human-control.js.
  const GEMINI_ROOM_AUDIO_EVENT = 'nexus-gemini-link-room-audio';
  const MAX_ROOM_AUDIO_ATTACHMENTS = 48;

  function createView({ state, el, protocol, onRoomSelect }) {
  const roomAudio = new Map();

  function audioKey(roomId, requestId) {
    return `${String(roomId || '')}:${String(requestId || '')}`;
  }

  function rememberRoomAudio(message = {}) {
    if (message.providerId !== 'gemini-link-chat' || message.type !== 'response_audio') return false;
    if (message.encoding && message.encoding !== 'pcm_s16le') return false;
    const correlation = message.correlation || {};
    const roomId = String(correlation.roomId || '');
    const requestId = String(message.requestId || '');
    const correlatedRequestId = String(correlation.requestId || requestId);
    const chunk = String(message.audio || '');
    if (!roomId || !requestId || correlatedRequestId !== requestId || !chunk) return false;
    const key = audioKey(roomId, requestId);
    const sampleRate = Math.max(8000, Number(message.sampleRate || 24000));
    const channels = Math.max(1, Math.min(2, Number(message.channels || 1)));
    const prior = roomAudio.get(key);
    const compatible = prior
      && prior.encoding === (message.encoding || 'pcm_s16le')
      && prior.sampleRate === sampleRate
      && prior.channels === channels;
    const chunks = compatible && Array.isArray(prior.chunks)
      ? [...prior.chunks, chunk]
      : [chunk];
    roomAudio.delete(key);
    roomAudio.set(key, {
      chunks,
      encoding: message.encoding || 'pcm_s16le',
      sampleRate,
      channels,
      audioOwner: 'nexus-browser',
      autoplay: false,
      requestId
    });
    while (roomAudio.size > MAX_ROOM_AUDIO_ATTACHMENTS) {
      const oldest = roomAudio.keys().next().value;
      if (oldest == null) break;
      roomAudio.delete(oldest);
    }
    return true;
  }

  function roomAudioForMessage(room, message) {
    if (message?.audio?.base64 || message?.audio?.audio || message?.audio?.chunks?.length) return message.audio;
    const receipt = (room?.finalReceipts || []).find((entry) => entry.messageId === message?.id);
    if (!receipt?.requestId) return null;
    return roomAudio.get(audioKey(room.id, receipt.requestId)) || null;
  }

  function attachRoomAudio(host, attachment, messageId, attempt = 0) {
    if (!host || !attachment) return;
    const audioApi = globalThis.BrowserAiBridgeGeminiLinkAudio;
    if (audioApi?.attachManual) {
      audioApi.attachManual(host, attachment, `dex:${messageId}`);
      return;
    }
    if (attempt >= 20) return;
    setTimeout(() => {
      if (host.isConnected !== false) attachRoomAudio(host, attachment, messageId, attempt + 1);
    }, 50);
  }

  function renderRooms() {
    el.dexRoomList.replaceChildren();
    for (const room of state.rooms) {
      const button = document.createElement('button');
      button.className = `dex-room-item${room.id === state.activeRoomId ? ' active' : ''}`;
      button.dataset.roomId = room.id;
      button.textContent = `${room.name} · ${room.members.length}`;
      button.addEventListener('click', () => {
        onRoomSelect(room);
      });
      el.dexRoomList.append(button);
    }
  }

  let lastTranscriptRoomId = null;
  function renderTranscript(room) {
    const sameRoom = room?.id === lastTranscriptRoomId;
    const oldTop = el.dexTranscript.scrollTop;
    const nearBottom = el.dexTranscript.scrollHeight - oldTop - el.dexTranscript.clientHeight < 48;
    el.dexTranscript.replaceChildren();
    if (!room) return;
    for (const message of room.messages) {
      const article = document.createElement('article');
      article.className = `dex-message ${message.senderKind}`;
      const meta = document.createElement('div');
      meta.className = 'dex-message-meta';
      meta.textContent = message.senderKind === 'user'
        ? `User (${message.senderName})`
        : message.senderName || 'Dex';
      const body = document.createElement('div');
      body.className = 'dex-message-body';
      body.textContent = message.senderKind === 'system'
        ? message.text
        : protocol.messageWrapper(message);
      article.append(meta, body);
      const attachment = message.senderKind === 'agent' ? roomAudioForMessage(room, message) : null;
      if (attachment) attachRoomAudio(article, attachment, message.id);
      el.dexTranscript.append(article);
    }
    lastTranscriptRoomId = room.id;
    el.dexTranscript.scrollTop = sameRoom && !nearBottom
      ? Math.min(oldTop, el.dexTranscript.scrollHeight)
      : el.dexTranscript.scrollHeight;
  }

  function onGeminiRoomAudio(event) {
    const message = event?.detail || {};
    if (!rememberRoomAudio(message)) return;
    const roomId = String(message.correlation?.roomId || '');
    if (roomId && roomId === state.activeRoomId) {
      const room = state.rooms.find((entry) => entry.id === roomId) || null;
      if (room) renderTranscript(room);
    }
  }

  globalThis.addEventListener?.(GEMINI_ROOM_AUDIO_EVENT, onGeminiRoomAudio);
  return { renderRooms, renderTranscript, rememberRoomAudio };
  }

  const api = { createView, GEMINI_ROOM_AUDIO_EVENT };
  globalThis.BrowserAiBridgeDexRoomView = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
