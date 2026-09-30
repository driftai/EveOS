(() => {
  let switching = false;

  function youtubeVideoId(value) {
    const text = String(value || '').trim();
    const match = text.match(/(?:[?&]v=|youtu\.be\/|youtube\.com\/(?:embed|shorts)\/)([A-Za-z0-9_-]{11})/i)
      || text.match(/^([A-Za-z0-9_-]{11})$/);
    return match?.[1] || '';
  }
  function sourceUrl(source = state?.source) {
    if (source?.originalUrl && youtubeVideoId(source.originalUrl)) return source.originalUrl;
    if (source?.referer && youtubeVideoId(source.referer)) return source.referer;
    const videoId = source?.videoId || youtubeVideoId(source?.url);
    return videoId ? `https://www.youtube.com/watch?v=${videoId}` : '';
  }
  function mode(source = state?.source) {
    const url = sourceUrl(source);
    if (!url) return null;
    return source?.kind === 'media' ? 'direct' : 'embed';
  }
  function canSwitch() {
    return (!roomId || isHost()) && !window.watchFusionLinkedTab?.active?.();
  }
  function playbackSnapshot() {
    const direct = mode() === 'direct';
    return direct
      ? { position: Number(mediaVideo?.currentTime) || Number(state?.playback?.position) || 0,
          paused: mediaVideo ? !!mediaVideo.paused : state?.playback?.paused !== false }
      : { position: Number(ytPlayer?.getCurrentTime?.()) || Number(state?.playback?.position) || 0,
          paused: ytPlayer?.getPlayerState?.() !== window.YT?.PlayerState?.PLAYING };
  }
  function render() {
    const root = $('youtubePlaybackMode');
    if (!root) return;
    const current = mode();
    root.hidden = !current;
    if (!current) return;
    const disabled = switching || !canSwitch();
    const embed = $('youtubeEmbedModeBtn'), direct = $('youtubeDirectModeBtn');
    embed?.setAttribute('aria-pressed', String(current === 'embed'));
    direct?.setAttribute('aria-pressed', String(current === 'direct'));
    if (embed) embed.disabled = disabled || current === 'embed';
    if (direct) direct.disabled = disabled || current === 'direct';
    const hint = $('youtubePlaybackModeHint');
    if (hint) hint.textContent = current === 'embed'
      ? 'Full YouTube controls and native streaming.'
      : 'Compatibility stream without YouTube controls.';
  }
  async function switchToEmbed() {
    if (switching || mode() !== 'direct' || !canSwitch()) return false;
    const url = sourceUrl(), videoId = youtubeVideoId(url), snapshot = playbackSnapshot();
    if (!videoId) return false;
    switching = true; render(); setStatus('Switching to the full YouTube player…');
    try {
      if (!await loadYoutubeInput(url)) throw new Error('YouTube player could not be restored.');
      await waitForPlayerCued(videoId, 6000);
      if (roomId) await command(snapshot.paused ? 'pause' : 'play', { position: snapshot.position });
      else {
        try { ytPlayer?.seekTo?.(snapshot.position, true); snapshot.paused ? ytPlayer?.pauseVideo?.() : ytPlayer?.playVideo?.(); } catch {}
      }
      setStatus('YouTube player ready · full YouTube controls available.');
      return true;
    } catch (error) {
      setStatus(error?.message || 'YouTube player could not be restored.');
      return false;
    } finally { switching = false; render(); }
  }
  async function switchToDirect() {
    if (switching || mode() !== 'embed' || !canSwitch()) return false;
    const snapshot = playbackSnapshot();
    switching = true; render();
    try {
      return !!await window.watchFusionYoutubeStability?.stabilize?.({ manual: true, paused: snapshot.paused });
    } finally { switching = false; render(); }
  }

  $('youtubeEmbedModeBtn')?.addEventListener('click', () => { void switchToEmbed(); });
  $('youtubeDirectModeBtn')?.addEventListener('click', () => { void switchToDirect(); });
  window.watchFusionYoutubePlaybackMode = { mode, render, sourceUrl, switchToEmbed, switchToDirect };
})();
