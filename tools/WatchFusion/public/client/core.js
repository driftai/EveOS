let ytPlayer = null;
let ytReady = false;
let ytPlayerReady = false;
let pendingVideoId = null;
let roomId = null;
let roomCode = null;
let joinCode = null;
let session = null;
function makeClientId() {
  try {
    if (globalThis.isSecureContext && globalThis.crypto?.randomUUID) {
      return globalThis.crypto.randomUUID().replaceAll('-', '');
    }
  } catch {}
  try {
    if (globalThis.crypto?.getRandomValues) {
      const bytes = new Uint8Array(16);
      globalThis.crypto.getRandomValues(bytes);
      return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
    }
  } catch {}
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
const storage = {
  get(key, fallback = null) { try { return globalThis.localStorage?.getItem(key) ?? fallback; } catch { return fallback; } },
  set(key, value) { try { globalThis.localStorage?.setItem(key, value); } catch {} },
  remove(key) { try { globalThis.localStorage?.removeItem(key); } catch {} }
};
let accountId = storage.get('wp-account-id');
if (!accountId) { accountId = makeClientId(); storage.set('wp-account-id', accountId); }
let eventSource = null;
let state = null;
let applyingRemote = false;
let playerPrimed = false;
let primingPlayer = false;
let sourceInputDirty = false;
let userGesturePrimeInstalled = false;
let autoplayWasBlocked = false;
let playerInitializing = false;
let userGesturePrimeUsed = false;
let remotePollTimer = null;
let remotePollBusy = false;
let serverClockOffsetMs = 0;
let serverClockRttMs = Infinity;
const isTryCloudflare = /(^|\.)trycloudflare\.com$/i.test(location.hostname);
const eveosShareParams = new URLSearchParams(location.search);
const eveosShareMode = ['lan', 'cloudflare'].includes(eveosShareParams.get('eveosShareMode')) ? eveosShareParams.get('eveosShareMode') : 'local';
let eveosShareBaseUrl = null;
try {
  const candidate = new URL(eveosShareParams.get('eveosShareUrl') || '');
  if (/^https?:$/.test(candidate.protocol)) eveosShareBaseUrl = candidate.origin;
} catch {}
const PLAYER_AUDIO_PREFS_KEY = 'wp-youtube-audio-prefs-v1';
let playerAudioPrefs = loadPlayerAudioPrefs();
let suppressAudioPersistence = false;
let roomAudioGuardUntil = 0;
let roomAudioCommandTimer = null;
let roomAudioCandidateKey = '';

const $ = (id) => document.getElementById(id);

function loadPlayerAudioPrefs() {
  try {
    const raw = storage.get(PLAYER_AUDIO_PREFS_KEY);
    if (!raw) return { volume: 100, muted: false };
    const parsed = JSON.parse(raw);
    const volume = Math.max(0, Math.min(100, Number(parsed?.volume)));
    return { volume: Number.isFinite(volume) ? volume : 100, muted: !!parsed?.muted };
  } catch { return { volume: 100, muted: false }; }
}
function savePlayerAudioPrefs(player = ytPlayer) {
  if (!player || suppressAudioPersistence) return;
  try {
    const volume = Math.max(0, Math.min(100, Number(player.getVolume?.()) ?? playerAudioPrefs.volume ?? 100));
    const muted = !!player.isMuted?.();
    playerAudioPrefs = { volume, muted };
    storage.set(PLAYER_AUDIO_PREFS_KEY, JSON.stringify(playerAudioPrefs));
  } catch {}
}
function restorePlayerAudioPrefs(player = ytPlayer) {
  if (!player) return;
  const storedVolume = Number(playerAudioPrefs?.volume);
  const volume = Number.isFinite(storedVolume) ? Math.max(0, Math.min(100, storedVolume)) : 100;
  const muted = !!playerAudioPrefs?.muted;
  suppressAudioPersistence = true;
  try { player.setVolume?.(volume); muted ? player.mute?.() : player.unMute?.(); } catch {}
  setTimeout(() => { suppressAudioPersistence = false; }, 0);
}
function authoritativeRoomAudio() {
  if (!roomId || !state?.playback) return null;
  const rawVolume = Number(state.playback.volume);
  return { volume: Number.isFinite(rawVolume) ? Math.min(100, Math.max(0, rawVolume)) : 100, muted: !!state.playback.muted };
}
function clearRoomAudioCandidate() {
  if (roomAudioCommandTimer) clearTimeout(roomAudioCommandTimer);
  roomAudioCommandTimer = null;
  roomAudioCandidateKey = '';
}
function applyRoomAudioState(player = ytPlayer, forceUnmute = false) {
  const audio = authoritativeRoomAudio();
  if (!player || !audio) return false;
  const autoplayGuard = !forceUnmute && !isHost() && autoplayWasBlocked && !userGesturePrimeUsed;
  const targetMuted = audio.muted || autoplayGuard;
  clearRoomAudioCandidate();
  roomAudioGuardUntil = performance.now() + 650;
  suppressAudioPersistence = true;
  try {
    const currentVolume = Number(player.getVolume?.());
    if (!Number.isFinite(currentVolume) || Math.abs(currentVolume - audio.volume) > 0.5) player.setVolume?.(audio.volume);
    if (!!player.isMuted?.() !== targetMuted) targetMuted ? player.mute?.() : player.unMute?.();
  } catch {}
  setTimeout(() => { suppressAudioPersistence = false; }, 0);
  return true;
}
function publishRoomAudioState(volume, muted) {
  if (!roomId || !session || !isHost() || performance.now() < roomAudioGuardUntil) return;
  const nextVolume = Math.min(100, Math.max(0, Number(volume) || 0));
  const nextMuted = !!muted;
  const current = authoritativeRoomAudio();
  if (current && Math.abs(current.volume - nextVolume) <= 0.5 && current.muted === nextMuted) {
    clearRoomAudioCandidate();
    return;
  }
  const candidateKey = `${Math.round(nextVolume * 2) / 2}:${nextMuted ? 1 : 0}`;
  if (roomAudioCandidateKey === candidateKey && roomAudioCommandTimer) return;
  if (roomAudioCommandTimer) clearTimeout(roomAudioCommandTimer);
  roomAudioCandidateKey = candidateKey;
  roomAudioCommandTimer = setTimeout(() => {
    roomAudioCommandTimer = null;
    if (!roomId || !session || !isHost() || !ytPlayer || !ytPlayerReady || performance.now() < roomAudioGuardUntil) {
      roomAudioCandidateKey = '';
      return;
    }
    let actualVolume = nextVolume;
    let actualMuted = nextMuted;
    try {
      const sampledVolume = Number(ytPlayer.getVolume?.());
      if (Number.isFinite(sampledVolume)) actualVolume = Math.min(100, Math.max(0, sampledVolume));
      actualMuted = !!ytPlayer.isMuted?.();
    } catch {}
    const actualKey = `${Math.round(actualVolume * 2) / 2}:${actualMuted ? 1 : 0}`;
    if (actualKey !== roomAudioCandidateKey) {
      roomAudioCandidateKey = '';
      publishRoomAudioState(actualVolume, actualMuted);
      return;
    }
    roomAudioCandidateKey = '';
    const latest = authoritativeRoomAudio();
    if (latest && Math.abs(latest.volume - actualVolume) <= 0.5 && latest.muted === actualMuted) return;
    command('volume', { volume: actualVolume, muted: actualMuted }).catch(() => setStatus('Room audio sync is reconnecting…'));
  }, 350);
}
function observeYouTubeAudio() {
  if (!ytPlayer || !ytPlayerReady || primingPlayer || playerInitializing) return;
  try {
    const volume = Math.min(100, Math.max(0, Number(ytPlayer.getVolume?.()) || 0));
    const muted = !!ytPlayer.isMuted?.();
    const changed = Math.abs((Number(playerAudioPrefs?.volume) || 0) - volume) > 0.5 || !!playerAudioPrefs?.muted !== muted;
    if (roomId) {
      if (isHost()) { if (changed) savePlayerAudioPrefs(); publishRoomAudioState(volume, muted); }
    } else if (changed) savePlayerAudioPrefs();
  } catch {}
}
function updateServerClock(serverTime, sentAt, receivedAt) {
  const server = Number(serverTime);
  if (!Number.isFinite(server)) return;
  const t0 = Number(sentAt), t1 = Number(receivedAt);
  if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 < t0) return;
  const rtt = t1 - t0;
  if (rtt > serverClockRttMs) return;
  serverClockRttMs = rtt;
  serverClockOffsetMs = server - (t0 + rtt / 2);
}
function estimatedServerNow() { return Date.now() + serverClockOffsetMs; }
window.watchPartyClock = {
  offsetMs: () => serverClockOffsetMs,
  rttMs: () => Number.isFinite(serverClockRttMs) ? serverClockRttMs : null,
  now: estimatedServerNow,
  update: updateServerClock
};
const lobby = $('lobby');
const app = $('app');
let ytApiPromise = null;
window.onYouTubeIframeAPIReady = () => {
  ytReady = !!window.YT?.Player;
  if (ytApiResolve) ytApiResolve(window.YT);
  if (state?.source?.videoId) ensurePlayer(state.source.videoId);
};
let ytApiResolve = null;
function loadYouTubeApi() {
  if (window.YT?.Player) { ytReady = true; return Promise.resolve(window.YT); }
  if (ytApiPromise) return ytApiPromise;
  ytApiPromise = new Promise((resolve, reject) => {
    ytApiResolve = resolve;
    const timeout = setTimeout(() => { ytApiResolve = null; reject(new Error('The YouTube player took too long to initialize.')); }, 10000);
    const existing = document.querySelector('script[src="https://www.youtube.com/iframe_api"]');
    if (!existing) {
      const script = document.createElement('script');
      script.src = 'https://www.youtube.com/iframe_api';
      script.async = true;
      script.onerror = () => { clearTimeout(timeout); ytApiResolve = null; reject(new Error('The YouTube player API could not be loaded.')); };
      document.head.appendChild(script);
    }
    const originalResolve = resolve;
    resolve = value => { clearTimeout(timeout); ytReady = !!value?.Player; originalResolve(value); };
  }).finally(() => { ytApiResolve = null; });
  return ytApiPromise;
}
function roomFromUrl() { const match = location.pathname.match(/^\/watch\/([A-Za-z0-9_-]{3,32})$/i); return match ? match[1].toUpperCase() : null; }
function makeRoomId() { return makeClientId().replaceAll('-', '').slice(0, 6).toUpperCase(); }
function currentName() { return storage.get('wp-name') || 'Guest'; }
function setName(value) { storage.set('wp-name', value); }
function sessionKey(id) { return `wp-session-${String(id).toUpperCase()}`; }
function loadSavedSession(id) { try { const raw=storage.get(sessionKey(id)); return raw ? JSON.parse(raw) : null; } catch { return null; } }
function saveSession(id, value) { storage.set(sessionKey(id), JSON.stringify(value)); }
function saveRoomSession(value, ...ids) {
  for (const id of new Set(ids.filter(Boolean).map(item=>String(item).toUpperCase()))) saveSession(id, value);
}
function isHost() { return !!session && (state?.hostId === session.publicId || state?.hostId === session.memberId); }
function setStatus(text) { $('syncStatus').textContent = text; }
let lanBaseUrl = null;
let lanNetworkInfo = null;
let serverLanMode = false;
let transportBaseUrl = '';
let networkInfoReady = Promise.resolve();
function apiUrl(path) { const value=String(path||''); return transportBaseUrl ? `${transportBaseUrl}${value.startsWith('/')?value:`/${value}`}` : value; }
function eventStreamUrl(path) { return apiUrl(path); }

async function loadNetworkInfo() {
  try {
    const res = await fetch(apiUrl('/api/network-info'), { cache: 'no-store' });
    if (!res.ok) throw new Error('network diagnostics unavailable');
    const data = await res.json();
    lanNetworkInfo = data;
    transportBaseUrl = data?.requestIsVirtual ? (data?.transportBridge || '') : '';
    if (transportBaseUrl) setStatus(`Virtual adapter bridged via ${transportBaseUrl}`);
    serverLanMode = data?.localOnly === false || data?.localMode === false;
    if (!serverLanMode) { lanBaseUrl=null; $('copyLanBtn').hidden=true; return; }
    lanBaseUrl = data?.preferredLanHost || data?.lanHosts?.[0]
      || data?.preferredLanAddress || data?.lanAddresses?.[0] || null;
    $('copyLanBtn').hidden = !lanBaseUrl;
  } catch {
    if (isReachableLanHost(location.hostname)) { serverLanMode=true; lanBaseUrl=location.origin; $('copyLanBtn').hidden=false; }
  }
}
function isReachableLanHost(hostname) { return /^(10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[0-1])\.)/.test(hostname) || /(?:^|\.)sslip\.io$/i.test(hostname); }
function shareRoomToken() { return joinCode || roomCode || roomId; }
function roomLink(baseUrl) {
  const token = shareRoomToken();
  return baseUrl && token ? `${String(baseUrl).replace(/\/$/, '')}/watch/${encodeURIComponent(token)}` : null;
}
function lanRoomLink() { return roomLink(lanBaseUrl); }
function localRoomLink() { return roomLink(`http://127.0.0.1:${location.port||'9087'}`); }
function shareRoomLink() {
  const token = shareRoomToken();
  if (!token) return null;
  if (eveosShareBaseUrl && eveosShareMode !== 'local') return roomLink(eveosShareBaseUrl);
  if (isTryCloudflare) return roomLink(location.origin);
  if (serverLanMode && lanBaseUrl) return lanRoomLink();
  if (isReachableLanHost(location.hostname)) return roomLink(location.origin);
  if (/^(localhost|127\.0\.0\.1|127-0-0-1\.sslip\.io)$/i.test(location.hostname)) return localRoomLink() || roomLink(location.origin);
  return roomLink(location.origin);
}
function replaceRoomHistory(id = null) {
  const url = new URL(location.href);
  url.pathname = id ? `/watch/${encodeURIComponent(id)}` : '/';
  url.hash = '';
  history.replaceState({}, '', `${url.pathname}${url.search}`);
  queueMicrotask(()=>window.watchFusionEveBridge?.heartbeat?.());
}
function displayRoomLabel() { return !roomId ? 'No room' : roomCode ? `ROOM ${roomId} · ${roomCode}` : `ROOM ${roomId}`; }
async function copyText(value) {
  const text=String(value||''); if(!text) return false;
  try { if(navigator.clipboard?.writeText){ await navigator.clipboard.writeText(text); return true; } } catch {}
  try { const area=document.createElement('textarea'); area.value=text; area.setAttribute('readonly',''); area.style.position='fixed'; area.style.opacity='0'; document.body.appendChild(area); area.select(); const copied=document.execCommand('copy'); area.remove(); return copied; } catch { return false; }
}
function setCopyButtonFeedback(button, copied, idleLabel='Copy') {
  if(!button)return;
  const previousTimer=Number(button.dataset.copyFeedbackTimer||0);
  if(previousTimer)clearTimeout(previousTimer);
  button.textContent=copied?'Copied ✓':'Copy failed';
  button.classList.toggle('is-copied',copied);
  button.classList.toggle('is-copy-failed',!copied);
  button.setAttribute('aria-label',copied?'Copied to clipboard':'Copy failed');
  const timer=setTimeout(()=>{
    button.textContent=idleLabel;
    button.classList.remove('is-copied','is-copy-failed');
    button.setAttribute('aria-label',idleLabel);
    delete button.dataset.copyFeedbackTimer;
  },1800);
  button.dataset.copyFeedbackTimer=String(timer);
}
async function copyJoinCode() { const code=joinCode||roomCode||roomId; if(!code)return; setStatus(await copyText(code)?`Join code ${code} copied`:`Join code: ${code}`); }
function leaveRoom(message='') {
  eventSource?.close(); eventSource=null;
  window.watchPartyRealtime?.stop?.();
  if(remotePollTimer){clearInterval(remotePollTimer);remotePollTimer=null;}
  if(pingTimer){clearInterval(pingTimer);pingTimer=null;}
  clearRoomAudioCandidate();
  roomAudioGuardUntil=0;
  roomId=null; roomCode=null; joinCode=null; session=null; playerPrimed=false; playerInitializing=false; autoplayWasBlocked=false;
  renderedChatSignature='';
  state = null;
  replaceRoomHistory();
  app.hidden=false;
  lobby.hidden=true;
  if ($('partyDetails')) $('partyDetails').hidden = true;
  if ($('soloPartyHint')) $('soloPartyHint').hidden = false;
  if ($('startPartyBtn')) $('startPartyBtn').hidden = false;
  if ($('openRoomBtn')) $('openRoomBtn').hidden = false;
  if ($('syncBtn')) $('syncBtn').hidden = true;
  if ($('copyBtn')) $('copyBtn').hidden = true;
  if ($('copyLanBtn')) $('copyLanBtn').hidden = true;
  if ($('deleteRoomBtn')) $('deleteRoomBtn').hidden = true;
  $('roomPill').textContent = 'Solo';
  $('roomPill').disabled = true;
  if(message)setStatus(message);
}
function escapeHtml(v){return String(v).replace(/[&<>'"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));}
