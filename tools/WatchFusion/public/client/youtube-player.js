function installUserGesturePrime() {
  if (!roomId || userGesturePrimeInstalled) return;
  userGesturePrimeInstalled = true;
  const handler = async event => {
    if (event?.target?.closest?.('#syncRoomLog')) return;
    if (!roomId || !ytPlayer || !ytPlayerReady || !pendingVideoId || !autoplayWasBlocked) return;
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
      if (!applyRoomAudioState(ytPlayer, true)) restorePlayerAudioPrefs();
      playerPrimed = true;
      autoplayWasBlocked = false;
      userGesturePrimeUsed = true;
      playerInitializing = false;
      setStatus('Synchronized playback audio enabled');
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

// render() and the room transport callback can both request the next song before
// the iframe reports its new video ID. A primed follower needs one native load.
let linkedViewerTrack = null;
function continueLinkedViewerTrack(videoId, previousVideoId) {
  const player = ytPlayer, epoch = state?.presentationEpoch;
  if (!roomId || !ytPlayerReady || !player || !state?.linkedSourceActive ||
      state.source?.videoId !== videoId || isHost() || !followsRoomPlayback()) {
    linkedViewerTrack = null;
    return false;
  }
  const previous = linkedViewerTrack;
  const samePlayer = previous && previous.room === roomId && previous.player === player;
  if (samePlayer && previous.videoId === videoId && previous.epoch === epoch &&
      (previous.pending || player.getVideoData?.()?.video_id === videoId)) return true;
  linkedViewerTrack = null;
  if (!previousVideoId || previousVideoId === videoId || !playerPrimed || primingPlayer ||
      typeof player.loadVideoById !== 'function' || typeof player.cueVideoById !== 'function') return false;

  const track = {room:roomId, player, videoId, epoch, pending:true};
  const startSeconds = window.watchFusionYouTubeTarget?.(estimatedServerNow(), 0) ?? state.playback.position;
  const target = {videoId, startSeconds:Math.max(0, Number(startSeconds) || 0)};
  playerInitializing = true;
  linkedViewerTrack = track;
  window.watchFusionViewerArbiter?.intent?.('transport');
  try {
    if (state.playback.paused || state.playback.ended) player.cueVideoById(target);
    else player.loadVideoById(target);
  } catch {
    linkedViewerTrack = null;
    playerInitializing = false;
    return false;
  }
  function finish(matched) {
    if (linkedViewerTrack !== track || player !== ytPlayer || roomId !== track.room ||
        state?.source?.videoId !== videoId || state.presentationEpoch !== epoch) return;
    track.pending = false;
    playerInitializing = false;
    if (matched) syncPlayer();
    else { linkedViewerTrack = null; syncHydratedPlayer(videoId); }
  }
  waitForPlayerCued(videoId).then(() => finish(true), () => finish(false));
  return true;
}

function showYouTubePlayer() {
  window.mediaPlayback?.clear?.();
  const host = $('playerHost') || document.querySelector('.player.panel');
  if (host) {
    window.watchFusionYoutubeLayout?.activate?.(host);
    if (!$('player')) {
      const p = document.createElement('div');
      p.id = 'player';
      host.insertBefore(p, host.firstChild);
    }
    const p = $('player');
    if (p) {
      p.hidden = false;
      p.style.display = 'block';
    }
    const nuvioFrame = $('nuvioFrame');
    if (nuvioFrame) {
      nuvioFrame.hidden = true;
      nuvioFrame.style.display = 'none';
    }
    const nuvioToolbar = $('nuvioToolbar');
    if (nuvioToolbar) {
      nuvioToolbar.hidden = true;
    }
    const voxelVisionFrame = $('voxelVisionFrame');
    if (voxelVisionFrame) {
      voxelVisionFrame.hidden = true;
      voxelVisionFrame.style.display = 'none';
    }
    const voxelVisionToolbar = $('voxelVisionToolbar');
    if (voxelVisionToolbar) voxelVisionToolbar.hidden = true;
    host.classList.remove('nuvio-active', 'voxelvision-active');
  }
}
