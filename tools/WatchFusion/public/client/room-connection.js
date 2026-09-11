async function join(id, name, roomCodeHint = null) {
  await networkInfoReady;
  const requestedId = String(id || '').trim().toUpperCase();
  if (!/^[A-Z0-9_-]{3,32}$/.test(requestedId)) return alert('Enter a valid room code');
  roomId = requestedId;
  roomCode = roomCodeHint || (/^[0-9]{1,12}$/.test(requestedId) ? requestedId : null);
  history.replaceState({}, '', `/watch/${requestedId}`);
  setName(name || currentName());
  eventSource?.close(); eventSource = null;
  window.watchPartyRealtime?.stop?.();
  setStatus('Connecting to room…');

  let saved = null, res = null, data = null;
  try {
    saved = loadSavedSession(requestedId);
    const startedAt = Date.now();
    res = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(requestedId)}/join`), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:currentName(),accountId,memberId:saved?.memberId||undefined,roomCode:roomCode||undefined}),cache:'no-store'});
    const receivedAt = Date.now();
    data = await res.json().catch(() => ({}));
    if (data?.state?.serverTime) updateServerClock(data.state.serverTime, startedAt, receivedAt);
  } catch {
    setStatus('Connection failed');
    return alert('Could not reach WatchParty.');
  }
  if (!res.ok) {
    if (saved) storage.remove(sessionKey(requestedId));
    setStatus('Room not found');
    return alert(data.error || 'Could not join room.');
  }
  session = data.session;
  state = data.state;
  roomId = session.roomId || data.state?.roomId || requestedId;
  roomCode = data.state?.roomCode || session.roomCode || null;
  joinCode = data.state?.joinCode || session.joinCode || roomCode || roomId;
  history.replaceState({}, '', `/watch/${roomId}`);
  saveSession(roomId, session);
  lobby.hidden = true; app.hidden = false;
  $('roomPill').textContent = displayRoomLabel();
  $('roomPill').title = `Copy join code: ${joinCode}`;
  window.watchPartyRealtime?.resetRevision?.(state?.revision);
  if (state?.serverTime) updateServerClock(state.serverTime, Date.now(), Date.now());
  render(); connectEvents(); startPing();
  if (state?.source?.videoId) { setStatus('Joining current playback…'); ensurePlayer(state.source.videoId); }
}

function connectEvents() {
  eventSource?.close(); eventSource = null;
  if (remotePollTimer) { clearInterval(remotePollTimer); remotePollTimer = null; }
  window.watchPartyRealtime?.stop?.();

  const fallback = () => {
    window.watchPartyRealtime?.stop?.();
    if (isTryCloudflare) return startStatePolling();
    return startSseEvents();
  };
  if (window.watchPartyRealtime?.start) return window.watchPartyRealtime.start(fallback);
  return fallback();
}

function applyIncomingRoomState(nextState) {
  const revision = Number(nextState?.revision);
  const current = Number(state?.revision);
  if (Number.isFinite(revision) && Number.isFinite(current) && revision < current) return false;
  if (nextState?.serverTime) updateServerClock(nextState.serverTime, Date.now(), Date.now());
  state = nextState;
  return true;
}

function startSseEvents() {
  eventSource = new EventSource(eventStreamUrl(`/api/rooms/${roomId}/events?memberId=${encodeURIComponent(session.memberId)}`));
  eventSource.onmessage = (e) => {
    let payload;
    try { payload = JSON.parse(e.data); } catch { return; }
    if (payload.type === 'room-deleted') { leaveRoom('Room deleted by the host.'); return; }
    if (payload.type !== 'state') return;
    if (!applyIncomingRoomState(payload.state)) return;
    render(); syncPlayer();
  };
  eventSource.onerror = () => { eventSource?.close(); eventSource = null; startStatePolling(); setStatus('Reconnecting…'); };
  eventSource.onopen = () => setStatus('Connected');
}

function startStatePolling() {
  if (remotePollTimer) return;
  const poll = async () => {
    if (!roomId || !session || remotePollBusy) return;
    remotePollBusy = true;
    try {
      const sentAt = Date.now();
      const res = await fetch(apiUrl(`/api/rooms/${roomId}/join`), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:currentName(),accountId,memberId:session.memberId,roomCode:roomCode||undefined}),cache:'no-store'});
      const receivedAt = Date.now();
      if (res.status === 410) { leaveRoom('Room was deleted.'); return; }
      if (!res.ok) throw new Error('room poll failed');
      const data = await res.json();
      if (data.state?.serverTime) updateServerClock(data.state.serverTime, sentAt, receivedAt);
      if (data.session?.memberId) { session = data.session; saveSession(roomId, session); }
      if (data.state && applyIncomingRoomState(data.state)) { render(); syncPlayer(); }
      setStatus('Connected');
    } catch { setStatus('Reconnecting…'); }
    finally { remotePollBusy = false; }
  };
  poll();
  remotePollTimer = setInterval(poll, 1000);
}

let pingTimer = null;
function pingServerClock() {
  if (!session || !roomId) return;
  const sentAt = Date.now();
  fetch(apiUrl(`/api/rooms/${roomId}/ping`), {method:'POST',headers:{'x-member-id':session.memberId}})
    .then(async response => { const receivedAt = Date.now(); const data = await response.json().catch(() => ({})); updateServerClock(data.serverTime, sentAt, receivedAt); })
    .catch(() => {});
}
function startPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingServerClock();
  pingTimer = setInterval(pingServerClock, 10000);
}
