// Presentation-only projection of the native Piano queue's confirmed audio owner.
// The server owns transport and timing. Nothing here starts, stops or resets audio.
export function setupNativeQueuePresentation({ api, native, els, recorder, youtubePiano,
  internalMode, internalTimeline, adoptSong, applyPlaybackOverrides, refreshStats,
  getSheetEventTotal, updateStatus }) {
  let projected = '', ticket = 0;
  async function project(data = {}) {
    const songId = String(data.songId || ''), sessionId = String(data.sessionId || '');
    const key = `${sessionId}:${songId}`;
    if (!sessionId || !songId || !internalMode() || projected === key) return;
    projected = key;
    const request = ++ticket;
    try {
      const result = await api.songs({ fresh: true });
      if (request !== ticket) return;
      const song = (result.songs || []).find(item => String(item.id) === songId);
      if (!song) throw new Error('The server-owned queue song is missing from Piano Library.');
      // New receipt replaces the old-song event timeline without touching audio.
      if (!native.adoptQueuedSession(data.status)) throw new Error('Missing native session receipt.');
      const performance = adoptSong(song);
      if (performance.length) recorder.load(performance); else recorder.clear();
      els.title.value = song.artist ? `${song.title} — ${song.artist}` : (song.title || 'Untitled sheet');
      els.sheet.value = song.sheet || '';
      els.sheet.dataset.source = song.source || 'Local library';
      els.sheet.dataset.sourceUrl = song.source_url || '';
      els.sheet.dataset.timingProfile = song.timing_profile || 'expressive';
      youtubePiano.showDiagnostics(song.transcription_diagnostics || null);
      const custom = song.identifiers?.custom || {};
      const preferredInterval = Number(custom.override_interval || song.recommended_interval_ms || 0);
      if (preferredInterval > 0) {
        const minimum = Number(els.interval.min || 25), maximum = Number(els.interval.max || 500);
        els.interval.value = String(Math.max(minimum, Math.min(maximum, Math.round(preferredInterval / 5) * 5)));
      }
      applyPlaybackOverrides(song);
      await refreshStats();
      if (request !== ticket) return;
      try {
        const timeline = await internalTimeline();
        if (request === ticket) native.adoptQueuedSession(data.status, timeline);
      } catch (_) { /* The server's progress stays authoritative. */ }
      if (request !== ticket) return;
      const current = nativeStatus();
      updateStatus(current);
      els.statusChip.dataset.state = current.status;
      els.statusText.textContent = current.message || 'Server-owned Piano playing';
      window.dispatchEvent(new CustomEvent('piano:sheet-progress-status', {
        detail: { ...current, timing_profile: els.sheet.dataset.timingProfile,
          sheet_total: getSheetEventTotal() }
      }));
    } catch (error) {
      if (request === ticket) {
        projected = '';
        console.warn('[Piano queue] Cannot project confirmed native song:', String(error?.message || error));
      }
    }
  }
  function nativeStatus() {
    // This native adapter owns the session snapshot; avoid accessing stale Browser PCM.
    return native.snapshot();
  }
  window.addEventListener('piano:native-queue-track', event => { void project(event.detail); });
  return { project };
}
