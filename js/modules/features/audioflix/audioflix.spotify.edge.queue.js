// Native Official Embed queue ownership: browser only arms and adopts receipts.
// No browser-side Play on native Ended, no duplicate provider session.
window.EveAudioflixSpotifyEdgeQueue = window.EveAudioflixSpotifyEdgeQueue || {};
(() => {
  'use strict';
  const ns = window.EveAudioflixSpotifyEdgeQueue;
  if (ns.ready) return;
  let lease = null, intent = 0, busy = false, refusedRun = -1, explicitOwner = false, pageToken = '';
  const reported = new Set();
  const owner = () => window.EveAudioflix?.queueConnection;
  const snap = () => owner()?.snapshot?.();
  const native = () => window.EveAudioflixNative;
  const edge = () => window.EveAudioflixSpotifyEdge;
  const media = () => window.EveAudioflixSpotifyMedia;
  const state = () => window.EveAudioflixState?.ensure?.() || {};
  const request = (action, payload = {}) => native()?.request?.('/api/audioflix/spotify-edge/command', {
    method: 'POST', timeout: 8000, body: JSON.stringify({action, payload})
  });
  function eligible(q) {
    if (!q?.isPlaying || !Array.isArray(q.entries) || q.entries.length < 2
        || q.entries.length > 96 || (q.shuffle && q.loop) || q.repeatOne) return null;
    const source = new Map((state().music || []).map(track => [String(track.id), track]));
    const entries = [];
    for (const entry of q.entries) {
      const track = source.get(String(entry.id));
      if (!track || window.EveAudioflixPlaybackPolicy?.resolve?.(track)?.spotifyMethod !== 'embed') return null;
      const identity = media()?.fromItem?.(track);
      if (!identity?.spotifyUri) return null;
      entries.push({spotifyUri:identity.spotifyUri, itemId:String(entry.id),
        gain:window.EveAudioflixSpotifyVolume?.effectiveGain?.(track.volume ?? 1) ?? 1});
    }
    return entries;
  }
  async function arm() {
    const q = snap(), e = edge()?.snapshot?.(), entries = eligible(q);
    if (!explicitOwner || !e?.active || !entries || busy || lease?.runId === q.playbackRunId
        || refusedRun === q.playbackRunId || document.visibilityState === 'hidden') return false;
    const serial = ++intent; busy = true;
    try {
      const observed = await native()?.request?.('/api/audioflix/spotify-edge/status', {
        method: 'GET', timeout: 3000 });
      if (!observed?.running || observed.identity !== entries[q.currentIndex]?.spotifyUri) return false;
      const reply = await request('queue-arm', {entries, index:q.currentIndex, runId:q.playbackRunId,
        expectedRevision:observed.mediaRevision, loop:q.loop===true});
      if (serial !== intent || q.playbackRunId !== snap()?.playbackRunId) {
        if (reply?.queueLease?.leaseId) void request('queue-disarm', {leaseId:reply.queueLease.leaseId});
        return false;
      }
      if (reply?.ok && reply.queueLease?.state === 'active') {
        lease = {...reply.queueLease}; reported.clear();
        console.info('[Audioflix] Native Edge queue continuation armed for this run.');
        return true;
      }
      refusedRun = q.playbackRunId;
      return false;
    } catch { refusedRun = q.playbackRunId; return false; }
    finally { busy = false; }
  }
  function isDelegated() {
    const q = snap();
    return !!lease && q?.playbackRunId === lease.runId
      && ['active','finished','uncertain'].includes(lease.state);
  }
  function paintFailures(receipt) {
    if (!Array.isArray(receipt?.failures)) return;
    const tracks = new Map((state().music || []).map(item => [String(item.id), item]));
    for (const failure of receipt.failures) {
      if (!failure || !Number.isSafeInteger(failure.revision)) continue;
      const id = String(failure.itemId ?? '');
      const key = `${receipt.leaseId}:${id}:${failure.revision}`;
      if (reported.has(key)) continue;
      const track = tracks.get(id);
      if (!track || window.EveAudioflixPlaybackPolicy?.resolve?.(track)?.spotifyMethod !== 'embed') continue;
      const permanent = ['provider-track-unavailable','provider-region-unavailable'].includes(failure.kind);
      const availability = permanent ? 'unavailable' : 'failed';
      const reason = String(failure.reason || 'Spotify playback could not be confirmed.').slice(0, 180);
      if (track.spotifyAvailability !== availability || track.spotifyAvailabilityReason !== reason) {
        window.EveAudioflixState?.updateItem?.('music', track.id, {
          spotifyAvailability: availability, spotifyAvailabilityReason: reason,
          spotifyAvailabilityCheckedAt: Date.now()
        }, {reason: 'audioflix-spotify-availability'});
      }
      window.EveAudioflixLibraryNext?.setHealth?.(track.id, {
        status: 'error', provider: 'spotify', source: 'spotify-provider-error', reason
      });
      reported.add(key);
    }
  }
  function reconcile(status) {
    const receipt = status?.edgeQueue;
    if (!isDelegated() || !receipt || receipt.leaseId !== lease.leaseId
        || receipt.runId !== lease.runId) return false;
    paintFailures(receipt);
    if (receipt.state === 'uncertain') {
      lease.state = 'uncertain'; return false; // never replay an ambiguous switch
    }
    if (!['active','finished'].includes(receipt.state)) return false;
    const q = snap();
    const index = Number(receipt.index);
    if (!Number.isInteger(index) || index < 0 || index >= q.entries.length
        || String(q.entries[index]?.id) !== receipt.itemId) return false;
    lease = {...receipt};
    const needsAdopt = q.currentIndex !== index || (receipt.state === 'finished' && q.isPlaying);
    if (!needsAdopt) return false;
    const next = owner()?.adoptManagedSpotify?.({runId:receipt.runId, index,
      itemId:receipt.itemId, finished:receipt.state==='finished'});
    if (!next) return false;
    edge()?.adoptQueueReceipt?.(status);
    return true; // edge.poll does not update again after adoption
  }
  function invalidate() {
    ++intent;
    const prior = lease; lease = null; refusedRun = -1; reported.clear();
    if (prior?.leaseId) void request('queue-disarm', {leaseId:prior.leaseId}).catch(() => {});
  }
  function onChange() { invalidate(); }
  window.addEventListener('eve:audioflix-queue-changed', onChange);
  window.addEventListener('eve:audioflix-playback', (event) => {
    if (!event.detail?.edgeEmbed || !event.detail?.item?.id) return;
    queueMicrotask(() => { void arm(); });
  });
  // A deferred first transport sometimes reports status before the queue marks itself playing.
  // This bounded visible-only check is for arming/presentation, never for Ended/Play.
  setInterval(() => { if (document.visibilityState === 'visible') void arm(); void recoverReloadOwner(); }, 2500);
  // sessionStorage belongs to this tab and survives reload, unlike page-local JS.
  // Only an exact native owner token can stop Spotify; never stop by window title/PID.
  const PAGE_TICKET_KEY = 'eveos.audioflix.spotify.edge.page-ticket.v1';
  const pageBase = () => {
    const saved = String(window.EveAudioflixState?.ensure?.()?.nativeBridgeBase || '');
    return /^http:\/\/127\.0\.0\.1:\d+$/i.test(saved) ? saved : 'http://127.0.0.1:8765';
  };
  function getTicket() {
    try {
      const ticket = JSON.parse(sessionStorage.getItem(PAGE_TICKET_KEY) || 'null');
      return ticket && /^[0-9a-f]{32}$/.test(ticket.token)
        && /^http:\/\/127\.0\.0\.1:\d+$/i.test(ticket.base)
        && Date.now() - Number(ticket.at) < 8 * 3600000 && Number(ticket.at) <= Date.now()
        ? ticket : null;
    } catch { return null; } // file:// storage can be disabled by browser policy
  }
  function remember(ticket) {
    try { sessionStorage.setItem(PAGE_TICKET_KEY, JSON.stringify(ticket)); }
    catch { /* pagehide has its own bounded transport fallback */ }
  }
  function forget(token) {
    try {
      if (getTicket()?.token === token) sessionStorage.removeItem(PAGE_TICKET_KEY);
    } catch { /* storage may be inaccessible */ }
  }
  let recovering = false, recoveringToken = '';
  async function recoverReloadOwner() {
    const ticket = getTicket();
    if (!ticket || recovering || ticket.token === pageToken || recoveringToken === ticket.token) return;
    recovering = true;
    try {
      // The native command validates the token and generation before touching its Edge host.
      const result = await request('page-stop-owned', {token:ticket.token});
      if (result?.ok === true || result?.bridgeReached === true) {
        forget(ticket.token);
        recoveringToken = ticket.token; // At most one definitive attempt per tab load
      }
    } catch { /* native may not be ready at reload startup; retry later */ }
    finally { recovering = false; }
  }
  // A new document with the same tab's ticket takes responsibility for a lost beacon.
  queueMicrotask(() => { void recoverReloadOwner(); });
  async function claimPageOwner(receipt) {
    explicitOwner = true;
    if (!receipt?.running || !Number.isSafeInteger(receipt.mediaRevision)) return false;
    const token = Array.from(crypto.getRandomValues(new Uint8Array(16)),
      value => value.toString(16).padStart(2, '0')).join('');
    pageToken = token;
    remember({token, base:pageBase(), at:Date.now()});
    try {
      const result = await request('page-register', {token, revision:receipt.mediaRevision,
        spotifyUri:receipt.identity});
      if (result?.ok) return true;
      if (result?.bridgeReached === true) { forget(token); if (pageToken === token) pageToken = ''; }
    } catch { /* A missing registration cannot authorize a broad Stop. */ }
    console.warn('[Audioflix] Exact Spotify page ownership not confirmed; reload cleanup may need retry.');
    return false;
  }
  function unloadingStop(action, payload) {
    const url = pageBase() + '/api/audioflix/spotify-edge/command';
    const body = JSON.stringify({action, payload});
    // Queueing a beacon is not proof of delivery. Also request keepalive, and
    // retain a tab-only recovery ticket for the new page when both are dropped.
    try { navigator.sendBeacon?.(url, new Blob([body], {type:'text/plain'})); }
    catch { /* keepalive may still work */ }
    try { void fetch(url, {method:'POST',body,keepalive:true,
      headers:{'Content-Type':'text/plain'}}).catch(() => {}); }
    catch { /* next page retries only the same exact native owner token */ }
  }
  let unloaded = false;
  function stopOnUnload() {
    if (unloaded) return; unloaded = true;
    const token = explicitOwner && pageToken;
    const ticket = explicitOwner && lease?.leaseId;
    ++intent; lease = null; pageToken = '';
    if (token) unloadingStop('page-stop-owned', {token});
    else if (ticket) unloadingStop('queue-stop-owned', {leaseId:ticket});
  }
  window.addEventListener('pagehide', stopOnUnload);
  window.addEventListener('beforeunload', stopOnUnload);
  Object.assign(ns, {ready:true, claimPageOwner, recoverReloadOwner,
    arm, reconcile, isDelegated, invalidate, snapshot:() => ({...lease})});
})();
