async function join(id, name, roomCodeHint = null, options = {}) {
  await networkInfoReady;
  const requestedId = String(id || '').trim().toUpperCase();
  const quiet=options.quiet===true,attempts=Math.max(1,Math.min(4,Number(options.attempts)||1));
  const retryDelayMs=Math.max(0,Number(options.retryDelayMs)||0),timeoutMs=Math.max(0,Number(options.timeoutMs)||0);
  const fail=(message,status='Connection failed')=>{setStatus(status);if(!quiet)alert(message);return false;};
  if (!/^[A-Z0-9_-]{3,32}$/.test(requestedId)) return fail('Enter a valid room code');
  roomId = requestedId;
  roomCode = roomCodeHint || (/^[0-9]{1,12}$/.test(requestedId) ? requestedId : null);
  replaceRoomHistory(requestedId);
  setName(name || currentName());
  eventSource?.close(); eventSource = null;
  window.watchPartyRealtime?.stop?.();
  setStatus('Connecting to room…');

  let saved = loadSavedSession(requestedId) || loadSavedSession(roomCodeHint), res = null, data = null;
  for(let attempt=0;attempt<attempts;attempt+=1){
    const controller=timeoutMs?new AbortController():null;
    const timer=controller?setTimeout(()=>controller.abort(),timeoutMs):null;
    try {
      const startedAt = Date.now();
      res = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(requestedId)}/join`), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:currentName(),accountId,memberId:saved?.memberId||undefined,roomCode:roomCode||undefined}),cache:'no-store',signal:controller?.signal});
      const receivedAt = Date.now();
      data = await res.json().catch(() => ({}));
      if (data?.state?.serverTime) updateServerClock(data.state.serverTime, startedAt, receivedAt);
      if(res.ok||res.status<500)break;
    } catch {
      res=null;data=null;
    } finally {
      if(timer)clearTimeout(timer);
    }
    if(attempt+1<attempts){
      setStatus('Reconnecting to room…');
      if(retryDelayMs)await new Promise(resolve=>setTimeout(resolve,retryDelayMs));
    }
  }
  if (!res) return fail('Could not reach WatchParty.');
  if (!res.ok) {
    if (saved) storage.remove(sessionKey(requestedId));
    return fail(data?.error || 'Could not join room.','Room not found');
  }
  session = data.session;
  state = data.state;
  roomId = session.roomId || data.state?.roomId || requestedId;
  roomCode = data.state?.roomCode || session.roomCode || null;
  joinCode = data.state?.joinCode || session.joinCode || roomCode || roomId;
  replaceRoomHistory(joinCode || roomId);
  saveRoomSession(session, requestedId, roomId, roomCode, joinCode);
  lobby.hidden = true; app.hidden = false;
  $('roomPill').textContent = displayRoomLabel();
  $('roomPill').title = `Copy join code: ${joinCode}`;
  window.watchPartyRealtime?.resetRevision?.(state?.revision);
  renderedChatSignature = '';
  render(); connectEvents(); startPing();
  const joinedMemberId = session.memberId;
  requestAnimationFrame(() => { if (session?.memberId === joinedMemberId) hydrateRoomUi(); });
  if (state?.source?.videoId) { setStatus('Joining current playback…'); ensurePlayer(state.source.videoId); }
  return true;
}
function hydrateRoomUi() {
  if (!state) return;
  renderedChatSignature = '';
  render();
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
    const authorityBefore = playbackAuthorityKey(state);
    if (!applyIncomingRoomState(payload.state)) return;
    render(); syncPlaybackForAuthorityChange(authorityBefore);
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
      if (data.session?.memberId) { session = data.session; saveRoomSession(session, roomId, roomCode, joinCode); }
      if (data.state) {
        const authorityBefore = playbackAuthorityKey(state);
        if (applyIncomingRoomState(data.state)) { render(); syncPlaybackForAuthorityChange(authorityBefore); }
      }
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
let roomResumePromise = null;
function syncResumedPlayback() {
  if (state?.source?.kind === 'media') window.mediaPlayback?.sync?.({ force: true });
  else syncPlayer({ force: true });
}
async function resumeRoomSession() {
  if (!roomId || !session) return false;
  if (roomResumePromise) return roomResumePromise;
  const activeRoom = roomId;
  const activeMember = session.memberId;
  roomResumePromise = (async () => {
    setStatus('Catching up…');
    try {
      const sentAt = Date.now();
      const res = await fetch(apiUrl(`/api/rooms/${encodeURIComponent(activeRoom)}/join`), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:currentName(),accountId,memberId:activeMember,roomCode:roomCode||undefined}),cache:'no-store'});
      const receivedAt = Date.now();
      if (roomId !== activeRoom || session?.memberId !== activeMember) return false;
      if (res.status === 410 || res.status === 404) { leaveRoom('Room is no longer active.'); return false; }
      if (!res.ok) throw new Error('room resume failed');
      const data = await res.json();
      if (data.state?.serverTime) updateServerClock(data.state.serverTime, sentAt, receivedAt);
      if (data.session?.memberId) { session=data.session;saveRoomSession(session,activeRoom,roomCode,joinCode); }
      if (data.state) { applyIncomingRoomState(data.state);hydrateRoomUi(); }
      connectEvents();
      pingServerClock();
      syncResumedPlayback();
      const resumedMember=session?.memberId;
      setTimeout(()=>{if(roomId===activeRoom&&session?.memberId===resumedMember)syncResumedPlayback();},250);
      return true;
    } catch { setStatus('Reconnecting…');return false; }
  })().finally(()=>{roomResumePromise=null;});
  return roomResumePromise;
}
function resumeVisibleRoom() { if (document.visibilityState === 'visible') resumeRoomSession(); }
window.addEventListener('pageshow', resumeRoomSession);
window.addEventListener('focus', resumeRoomSession);
document.addEventListener('visibilitychange', resumeVisibleRoom);
