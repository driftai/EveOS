// Revision-owned Official Spotify Embed failures: persist a visible marker and
// emit one terminal queue receipt only after the backend exhausts bounded Play.
window.EveAudioflixSpotifyEdgeFailures = window.EveAudioflixSpotifyEdgeFailures || {};
(function () {
  'use strict';
  const ns = window.EveAudioflixSpotifyEdgeFailures;
  if (ns.ready) return;
  let lastTerminal = '';
  const text = value => String(value || '').trim();
  function patch(item, availability, reason = '') {
    if (!item?.id) return false;
    const current = window.EveAudioflixState?.ensure?.()?.music
      ?.find(entry => String(entry.id) === String(item.id));
    if (!current) return false;
    const nextReason = text(reason).slice(0, 180);
    if (current.spotifyAvailability === availability
        && text(current.spotifyAvailabilityReason) === nextReason) return false;
    window.EveAudioflixState?.updateItem?.('music', current.id, {
      spotifyAvailability: availability,
      spotifyAvailabilityReason: nextReason,
      spotifyAvailabilityCheckedAt: availability ? Date.now() : 0
    }, { reason: 'audioflix-spotify-availability' });
    return true;
  }
  function observe(status, item, notify) {
    if (!item?.id || !Number.isSafeInteger(status?.mediaRevision)) return false;
    const failure = status.failure || {};
    const exact = Number(failure.revision) === status.mediaRevision;
    if (exact && failure.terminal === true) {
      patch(item, 'unavailable', failure.reason || 'Spotify could not play this official embed.');
      const key = `${item.id}:${status.mediaRevision}`;
      if (lastTerminal !== key) {
        lastTerminal = key;
        notify?.('Spotify URL unavailable; advancing the queue.', true, { terminal: true });
      }
      return true;
    }
    if ((status.autoPlayStatus === 'confirmed' || (status.routeConfirmed === true
        && status.state?.paused === false && Number(status.state?.currentTime || 0) > 0))
        && item.spotifyAvailability) {
      patch(item, '', '');
      lastTerminal = '';
    }
    return false;
  }
  function begin(item) { if (item?.id) lastTerminal = ''; }
  Object.assign(ns, { ready: true, begin, observe });
})();
