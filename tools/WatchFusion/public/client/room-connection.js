let lastRoomStateReceipt = null;
function noteRoomStateReceipt(){lastRoomStateReceipt={room:roomId,member:session?.memberId,at:performance.now()};}
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
  noteRoomStateReceipt();
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
  if (!nextState || (roomId && nextState.roomId && nextState.roomId !== roomId)) return false;
  const revision = Number(nextState.revision), current = Number(state?.revision);
  if (Number.isFinite(revision) && Number.isFinite(current)) {
    if (revision < current || (revision === current && Number(nextState.serverTime) < Number(state.serverTime))) return false;
  }
  state = nextState;
  noteRoomStateReceipt();
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

// One bounded request, including its body; a stalled network must not hold a poll or ping forever.
async function roomRequest(url, init, timeoutMs = 3500) {
  const controller = new AbortController(), timer = setTimeout(() => controller.abort(), timeoutMs), began = performance.now();
  try {
    const response = await fetch(url, {...init, signal:controller.signal}), receivedAt = Date.now();
    const data = response.ok ? await response.json() : {};
    if (controller.signal.aborted || performance.now()-began >= timeoutMs) throw new Error('Room request timed out');
    return {response, data, receivedAt};
  } finally { clearTimeout(timer); }
}

function startStatePolling() {
  if (remotePollTimer) return;
  const poll = async () => {
    if (!roomId || !session || remotePollBusy) return;
    const polledRoom = roomId;
    const polledMember = session.memberId;
    remotePollBusy = true;
    try {
      let requestSentAt = Date.now();
      let reply = await roomRequest(apiUrl(`/api/rooms/${polledRoom}/state`), {headers:{'x-member-id':polledMember},cache:'no-store'});
      if (roomId !== polledRoom || session?.memberId !== polledMember) return;
      if (reply.response.status === 401) {
        requestSentAt = Date.now();
        reply = await roomRequest(apiUrl(`/api/rooms/${polledRoom}/join`), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:currentName(),accountId,memberId:polledMember,roomCode:roomCode||undefined}),cache:'no-store'});
      }
      const {response:res,data,receivedAt} = reply;
      if (roomId !== polledRoom || session?.memberId !== polledMember) return;
      if (res.status === 410 || res.status === 404) { leaveRoom('Room is no longer active.'); return; }
      if (!res.ok) throw new Error('room poll failed');
      if (data.state?.serverTime) updateServerClock(data.state.serverTime, requestSentAt, receivedAt);
      if (data.session?.memberId) { session = data.session; saveRoomSession(session, roomId, roomCode, joinCode); }
      if (data.state) {
        const authorityBefore = playbackAuthorityKey(state);
        if (applyIncomingRoomState(data.state)) { render(); syncPlaybackForAuthorityChange(authorityBefore); }
      }
      setStatus('Connected');
    } catch { if (roomId === polledRoom && session?.memberId === polledMember) setStatus('Reconnecting…'); }
    finally { remotePollBusy = false; }
  };
  poll();
  remotePollTimer = setInterval(poll, 1000);
}

let pingTimer = null, pingPending = false, pingRecovery = null;
async function pingServerClock(recoverMembership = false) {
  if (!session || !roomId || pingPending) return;
  const activeRoom = roomId, activeMember = session.memberId, sentAt = Date.now(); pingPending = true;
  try {
    const {response,data,receivedAt} = await roomRequest(apiUrl(`/api/rooms/${activeRoom}/ping`), {method:'POST',headers:{'x-member-id':activeMember},cache:'no-store'});
    if (roomId !== activeRoom || session?.memberId !== activeMember) return;
    if (response.ok) { pingRecovery = null; updateServerClock(data.serverTime, sentAt, receivedAt, data.serverReceivedAt); }
    else if (response.status === 401 && recoverMembership && !remotePollTimer && !remotePollBusy && !roomResumePromise &&
        (pingRecovery?.room !== activeRoom || performance.now()-pingRecovery.at >= 30000)) {
      pingRecovery = {room:activeRoom,at:performance.now()}; void resumeRoomSession(); // membership rejection only, bounded retries
    }
  } catch {} finally { pingPending = false; }
}
function startPing() {
  if (pingTimer) clearInterval(pingTimer);
  pingServerClock();
  pingTimer = setInterval(() => void pingServerClock(true), 10000);
}
let roomResumePromise = null;
function syncResumedPlayback() {
  if (state?.source?.kind === 'media') window.mediaPlayback?.sync?.();
  else syncPlayer();
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
      const {response:res,data,receivedAt} = await roomRequest(apiUrl(`/api/rooms/${encodeURIComponent(activeRoom)}/join`), {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:currentName(),accountId,memberId:activeMember,roomCode:roomCode||undefined}),cache:'no-store'});
      if (roomId !== activeRoom || session?.memberId !== activeMember) return false;
      if (res.status === 410 || res.status === 404) { leaveRoom('Room is no longer active.'); return false; }
      if (!res.ok) throw new Error('room resume failed');
      if (data.state?.serverTime) updateServerClock(data.state.serverTime, sentAt, receivedAt);
      if (data.session?.memberId) { session=data.session;saveRoomSession(session,activeRoom,roomCode,joinCode); }
      if (data.state) { applyIncomingRoomState(data.state);hydrateRoomUi(); }
      connectEvents();
      pingServerClock();
      syncResumedPlayback();
      return true;
    } catch { if(roomId===activeRoom && session?.memberId===activeMember)setStatus('Reconnecting…');return false; }
  })().finally(()=>{roomResumePromise=null;});
  return roomResumePromise;
}
function resumeVisibleRoom() { if (document.visibilityState === 'visible') resumeRoomSession(); }
window.addEventListener('pageshow', resumeRoomSession);
function resumeFocusedRoom(){
  const age=performance.now()-(lastRoomStateReceipt?.at??-Infinity);
  const connected=window.watchPartyRealtime?.connected?.()===true || eventSource?.readyState===1 || !!remotePollTimer;
  // Focus within a healthy embedded room is not a request to rejoin/replay it.
  if(document.visibilityState==='visible' && connected && lastRoomStateReceipt?.room===roomId &&
      lastRoomStateReceipt?.member===session?.memberId && age>=0 && age<=15000) return;
  return resumeRoomSession();
}
window.addEventListener('focus', resumeFocusedRoom);
document.addEventListener('visibilitychange', resumeVisibleRoom);
