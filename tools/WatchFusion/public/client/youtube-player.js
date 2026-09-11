function installUserGesturePrime() {
  if (!roomId || userGesturePrimeInstalled) return;
  userGesturePrimeInstalled = true;
  const handler = async () => {
    if (!roomId || playerPrimed || !ytPlayer || !ytPlayerReady || !pendingVideoId || !autoplayWasBlocked) return;
    const wasApplyingRemote = applyingRemote;
    suppressAudioPersistence = true;
    applyingRemote = true;
    try {
      ytPlayer.mute?.();
      ytPlayer.playVideo?.();
      const started = performance.now();
      let playing = false;
      while (performance.now() - started < 2000) {
        if (ytPlayer.getPlayerState?.() === YT.PlayerState.PLAYING) { playing = true; break; }
        await new Promise(resolve => setTimeout(resolve, 50));
      }
      if (!playing) return;
      if (state?.playback?.paused) {
        ytPlayer.pauseVideo?.();
        ytPlayer.seekTo?.(Number(state?.playback?.position) || 0, true);
      }
      restorePlayerAudioPrefs();
      playerPrimed = true;
      autoplayWasBlocked = false;
      userGesturePrimeUsed = true;
      playerInitializing = false;
    } catch {}
    finally {
      applyingRemote = wasApplyingRemote;
      suppressAudioPersistence = false;
    }
  };
  window.addEventListener('pointerdown', handler, {passive:true});
  window.addEventListener('touchstart', handler, {passive:true});
  window.addEventListener('keydown', handler, {passive:true});
}
