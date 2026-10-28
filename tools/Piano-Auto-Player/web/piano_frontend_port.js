// Minimal message port for the EveOS song-first surface. The existing Piano app owns playback.
export function setupPianoFrontendPort({ api, play, pause, stop, status }) {
  if (window.parent === window) return;
  const parent = window.parent;
  let parentOrigin = '';
  try {
    const candidate = new URL(document.referrer).origin;
    if (candidate && candidate !== 'null' && /^https?:/.test(candidate)) parentOrigin = candidate;
  } catch (_) {}
  const replyTarget = parentOrigin || '*';
  const reply = payload => parent.postMessage(payload, replyTarget);
  let announceTimer = 0;
  let announceAttempts = 0;
  const stopAnnouncing = () => { if (announceTimer) clearTimeout(announceTimer); announceTimer = 0; };
  const announce = () => {
    reply({ type: 'piano:eveos-frontend-ready' });
    window.__eveosPianoFrontendPortAnnouncements = Number(window.__eveosPianoFrontendPortAnnouncements || 0) + 1;
  };
  const pulseReady = () => {
    announce();
    announceAttempts += 1;
    if (announceAttempts < 12) announceTimer = setTimeout(pulseReady, 350);
  };
  const commands = new Set(['list', 'status', 'play', 'pause', 'stop']);
  let inFlight = false;
  window.__eveosPianoFrontendPortReady = true;
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== parent) return;
    if (parentOrigin && event.origin !== parentOrigin) return;
    // EveOS sends this after iframe load. Reannounce so an opaque/file parent can
    // recover even if the initial ready message raced host mounting.
    if (data?.type === 'eveos:audioflix-context') { announce(); return; }
    if (data?.type !== 'eveos:piano-frontend-command') return;
    if (!Number.isSafeInteger(data.id) || !commands.has(data.action)) return;
    stopAnnouncing();
    const result = { type: 'piano:eveos-frontend-response', id: data.id };
    try {
      if (data.action === 'list') {
        const body = await api.songs({ fresh: true });
        result.songs = (Array.isArray(body.songs) ? body.songs : []).map(song => ({
          id: String(song.id || ''), title: String(song.title || 'Untitled'), artist: String(song.artist || ''),
          kind: song.performance?.length ? 'recording' : 'song', updated_at: Number(song.updated_at || 0)
        }));
      } else if (data.action === 'status') result.status = String(status()?.status || 'idle');
      else {
        if (inFlight) throw new Error('Piano is processing another command.');
        inFlight = true;
        try {
          if (data.action === 'play') {
            if (typeof data.songId !== 'string' || !data.songId || data.songId.length > 180) throw new Error('Invalid song selection.');
            const body = await api.songs({ fresh: true });
            const song = (body.songs || []).find(item => item.id === data.songId);
            if (!song) throw new Error('This song is no longer in your Piano library. Refresh the list.');
            await play(song);
          } else if (data.action === 'pause') await pause();
          else await stop();
        } finally { inFlight = false; }
      }
    } catch (error) { result.error = String(error?.message || 'Piano command failed.').slice(0, 180); }
    reply(result);
  });
  window.addEventListener('piano:unified-refresh-requested', () => reply({ type: 'piano:eveos-library-changed' }));
  pulseReady();
}
