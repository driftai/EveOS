/* In-memory, redacted room-timing trace. No microphone, URLs, tokens or automatic uploads. */
(() => {
  const panel = document.getElementById('syncRoomLog');
  const area = document.getElementById('syncRoomLogText');
  if (!panel || !area) return;
  const copy = document.getElementById('syncRoomLogCopy');
  const clear = document.getElementById('syncRoomLogClear');
  const count = document.getElementById('syncRoomLogCount');
  const MAX_ENTRIES = 90, MAX_AGE = 180000;
  let entries = [], roomScope = '', lastPeers = new Map(), lastKey = '', lastAt = 0, requestAt = -Infinity;
  let lastRendered = '';
  const finite = value => typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : null;
  const memberName = id => (state?.members || []).find(m => m.id === id)?.name || 'Viewer';
  const currentScope = () => roomId && session && state?.presentationEpoch != null
    ? [roomId, session.memberId, state.presentationEpoch].join(':') : '';
  function strip(peer, now) {
    const phase = finite(peer.positionMs - peer.roomPositionMs);
    const last = lastPeers.get(peer.member);
    const corrections = finite(peer.corrections);
    const signals = [];
    if (!peer.ready || (phase !== null && Math.abs(phase) > 10000)) signals.push('UNTRUSTED_PLAYER_OFFSET');
    if (now - peer.sampledAt > 2700) signals.push('STALE_PLAYER_REPORT');
    if (peer.buffering) signals.push('BUFFERING');
    if (last && last.corrections !== null && corrections !== null && corrections > last.corrections)
      signals.push('SEEK_COUNT_INCREASED_' + (corrections - last.corrections));
    if (last && last.phase !== null && phase !== null && Math.abs(phase - last.phase) > 900)
      signals.push('PLAYER_PHASE_JUMP');
    lastPeers.set(peer.member, {phase, corrections});
    return {device:memberName(peer.member), playing:peer.playing, buffering:peer.buffering,
      reportAgeMs:finite(now - peer.sampledAt), playerOffsetMs:phase,
      rttMs:finite(peer.rttMs), sourceAgeMs:finite(peer.sourceAgeMs),
      corrections, action:peer.recentCorrection || null,
      filteredDriftMs:finite(peer.filteredDriftMs),
      seekHealth:peer.seekHealth || null,
      signals};
  }
  function render() {
    if (!panel.open) return;
    refreshScope();
    prune();
    const recent = entries.slice(-15).map(item => {
      const peers = item.peers.map(p => `${p.device}: ${p.playerOffsetMs === null ? '?' : p.playerOffsetMs + 'ms'} · ${p.corrections ?? '-'} seeks${p.signals.length ? ' [' + p.signals.join(',') + ']' : ''}`).join(' / ');
      return `${item.at.slice(11,19)} ${item.ref || 'room-clock'} | ${peers}`;
    }).join('\n');
    if (recent !== lastRendered) {area.value = recent || 'Gathering room timing…'; lastRendered = recent;}
    if (count) count.textContent = entries.length + ' snapshots · recent history';
  }
  function emit(now, peers, coordination) {
    const rows = peers.map(p => strip(p, now)).sort((a,b) => a.device.localeCompare(b.device));
    const ref = coordination?.reference || window.watchFusionPlayout?.status?.()?.reference || 'room-clock';
    const phaseMs = finite(coordination?.phaseMs);
    const row = {at:new Date().toISOString(), ref, referencePhaseMs:phaseMs,
      uncertaintyMs:finite(coordination?.uncertaintyMs), sourceBuffering:!!coordination?.authorityBuffering,
      peers:rows};
    const key = JSON.stringify([ref,phaseMs,rows.map(p => [p.device,p.playerOffsetMs,p.corrections,p.action,p.buffering,p.signals])]);
    const changed = key !== lastKey && rows.some(p=>p.signals.length) || ref !== (entries.at(-1)?.ref);
    if (!changed && now - lastAt < 4500) return;
    lastKey = key; lastAt = now;
    entries.push(row); prune();
    render();
  }
  function refreshScope() {
    const scope = currentScope();
    if (scope === roomScope) return;
    roomScope = scope;
    entries = [];
    lastPeers.clear();
    lastKey = lastRendered = '';
    lastAt = 0;
    requestAt = -Infinity;
    area.value = '';
  }
  function prune() {
    entries = entries.filter(row => Date.now() - Date.parse(row.at) < MAX_AGE).slice(-MAX_ENTRIES);
  }
  function wantsSample() {
    refreshScope();
    const now = performance.now();
    return !!roomScope && now - requestAt >= 2300;
  }
  function observe(peers, coordination) {
    refreshScope();
    if (!roomScope) return;
    requestAt = performance.now();
    if (peers.length) emit(estimatedServerNow(), peers, coordination);
    else render();
  }
  function exported() {
    refreshScope();
    prune();
    return JSON.stringify({format:'WatchFusion room sync trace v2', generatedAt:new Date().toISOString(),
      disclosure:'Player timing only; microphone/speaker output not measured',
      snapshots:entries},null,2);
  }
  async function copyLog() {
    const content = exported();
    try {
      if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(content);
      else {
        area.value=content;area.focus();area.select();
        if (!document.execCommand('copy')) throw new Error('copy failed');
      }
      copy.textContent='Copied';setTimeout(()=>copy.textContent='Copy log',1500);
    } catch {area.value=content;area.focus();area.select();copy.textContent='Select to copy';}
  }
  copy?.addEventListener('click', () => void copyLog());
  clear?.addEventListener('click', () => {entries=[];lastPeers.clear();lastKey='';lastRendered='';render();});
  panel.addEventListener('toggle', render);
  window.watchFusionRoomSyncLog = {export:exported, wantsSample, observe};
})();
