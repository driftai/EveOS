// Minimal message port for the EveOS song-first surface. The existing Piano app owns playback.
export function setupPianoFrontendPort({ api, play, pause, stop, status }) {
  if (window.parent === window) return;
  let parentOrigin = '';
  try { parentOrigin = new URL(document.referrer).origin; } catch (_) {}
  if (!parentOrigin || parentOrigin === 'null' || !/^https?:/.test(parentOrigin)) return;
  const parent = window.parent;
  const reply = (payload) => parent.postMessage(payload, parentOrigin);
  const commands = new Set(['list', 'status', 'play', 'pause', 'stop']);
  let inFlight = false;
  window.addEventListener('message', async event => {
    const data = event.data;
    if (event.source !== parent || event.origin !== parentOrigin || data?.type !== 'eveos:piano-frontend-command') return;
    if (!Number.isSafeInteger(data.id) || !commands.has(data.action)) return;
    const result = { type: 'piano:eveos-frontend-response', id: data.id };
    try {
      if (data.action === 'list') {
        const body = await api.songs({ fresh: true });
        result.songs = (Array.isArray(body.songs) ? body.songs : []).map(song => ({
          id: String(song.id || ''), title: String(song.title || 'Untitled'), artist: String(song.artist || ''),
          kind: song.performance?.length ? 'recording' : 'song'
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
  reply({ type: 'piano:eveos-frontend-ready' });
}
