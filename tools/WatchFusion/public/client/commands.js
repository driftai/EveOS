function ensurePlayer(videoId) {
  if (!videoId) return;
  const previousPending = pendingVideoId;
  pendingVideoId = videoId;
  if (previousPending && previousPending !== videoId) {
    playerPrimed = false;
    playerInitializing = false;
    autoplayWasBlocked = false;
  }
  window.mediaPlayback?.clear?.();
  const host = $('playerHost') || document.querySelector('.player.panel');
  if (host) {
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
  loadYouTubeApi().then(() => {
    if (!pendingVideoId) return;
    if (!ytPlayer) {
      ytPlayerReady = false;
      playerInitializing = true;
      ytPlayer = new YT.Player('player', {
        videoId: pendingVideoId,
        playerVars: {
          autoplay: 1,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin
        },
        events: {
          onReady: async () => {
            ytPlayerReady = true;
            try {
              const frame = ytPlayer.getIframe?.();
              if (frame) {
                frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
                frame.style.display = 'block';
                frame.hidden = false;
              }
            } catch {}
            const desired = pendingVideoId;
            if (desired) {
              const current = ytPlayer.getVideoData?.()?.video_id || '';
              if (current !== desired) {
                applyingRemote = true;
                ytPlayer.cueVideoById(desired);
                await waitForPlayerCued(desired);
              }
            }
            if (roomId) {
              await primeYouTubePlayer();
              syncPlayer();
              if (playerPrimed) playerInitializing = false;
            } else {
              restorePlayerAudioPrefs();
              playerPrimed = true;
              playerInitializing = false;
              try { ytPlayer.playVideo?.(); } catch {}
            }
          },
          onStateChange: onYouTubeStateChange,
          onPlaybackRateChange: onYouTubeRateChange,
          onVolumeChange: onYouTubeVolumeChange,
          onAutoplayBlocked: () => {
            if (roomId) {
              autoplayWasBlocked = true;
              installUserGesturePrime();
            }
          },
          onError: onYouTubeError
        }
      });
      return;
    }

    if (!ytPlayerReady) return;
    const currentId = ytPlayer.getVideoData?.()?.video_id || '';
    if (currentId !== pendingVideoId) {
      if (!roomId) {
        ytPlayer.loadVideoById ? ytPlayer.loadVideoById(pendingVideoId) : ytPlayer.cueVideoById(pendingVideoId);
        playerPrimed = true;
        playerInitializing = false;
        return;
      }
      applyingRemote = true;
      playerInitializing = true;
      ytPlayer.cueVideoById(pendingVideoId);
      waitForPlayerCued(pendingVideoId).then(async () => {
        await primeYouTubePlayer(true);
        applyingRemote = false;
        if (playerPrimed) playerInitializing = false;
        syncPlayer();
      }).catch(() => {
        applyingRemote = false;
        playerInitializing = false;
        syncPlayer();
      });
    } else {
      if (roomId) {
        primeYouTubePlayer().then(() => { syncPlayer(); });
      } else {
        playerPrimed = true;
        playerInitializing = false;
        try { ytPlayer.playVideo?.(); } catch {}
      }
    }
  }).catch((error) => {
    setStatus(error?.message || 'YouTube player failed to initialize.');
  });
}

function waitForPlayerCued(videoId, timeoutMs = 2500) {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (!ytPlayer || !ytPlayerReady) return reject(new Error('YouTube player is not ready.'));
      const current = ytPlayer.getVideoData?.()?.video_id || '';
      if (current === videoId) return resolve();
      if (performance.now() - started >= timeoutMs) return reject(new Error('YouTube player did not finish loading the selected video.'));
      setTimeout(tick, 50);
    };
    tick();
  });
}

function primeYouTubePlayer(force = false) {
  installUserGesturePrime();
  if (!ytPlayer || !ytPlayerReady || primingPlayer) return Promise.resolve();
  if (playerPrimed && !force) return Promise.resolve();

  primingPlayer = true;
  suppressAudioPersistence = true;
  const targetPosition = Number(state?.playback?.position) || 0;
  const wasApplyingRemote = applyingRemote;
  applyingRemote = true;

  return new Promise((resolve) => {
    let settled = false;
    let sawPlaying = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try {
        ytPlayer.pauseVideo?.();
        ytPlayer.seekTo?.(targetPosition, true);
      } catch {}
      playerPrimed = sawPlaying;
      if (!sawPlaying) {
        autoplayWasBlocked = true;
        installUserGesturePrime();
      }
      primingPlayer = false;
      restorePlayerAudioPrefs();
      applyingRemote = wasApplyingRemote;
      setTimeout(() => { suppressAudioPersistence = false; }, 0);
      resolve();
    };

    const timeout = setTimeout(finish, 2500);
    const start = () => {
      try {
        const stateNow = ytPlayer.getPlayerState?.();
        if (stateNow === YT.PlayerState.PLAYING) {
          sawPlaying = true;
          clearTimeout(timeout);
          finish();
          return;
        }
        ytPlayer.mute?.();
        ytPlayer.playVideo?.();
        const watch = setInterval(() => {
          if (ytPlayer?.getPlayerState?.() === YT.PlayerState.PLAYING) {
            sawPlaying = true;
            clearInterval(watch);
            clearTimeout(timeout);
            finish();
          }
        }, 40);
        setTimeout(() => clearInterval(watch), 2200);
      } catch {
        clearTimeout(timeout);
        finish();
      }
    };

    const stateNow = ytPlayer.getPlayerState?.();
    if (stateNow === YT.PlayerState.PLAYING || stateNow === YT.PlayerState.PAUSED || stateNow === YT.PlayerState.CUED) start();
    else setTimeout(start, 50);
  });
}

function onYouTubeError(event) {
  const code = Number(event?.data);
  if (code === 2) return setStatus('YouTube rejected the video ID.');
  if (code === 5) return setStatus('YouTube could not play this video in the embedded player.');
  if (code === 100) return setStatus('This video is unavailable or private.');
  if (code === 101 || code === 150) return setStatus('The owner has disabled playback outside YouTube.');
  setStatus(`YouTube error ${code || 'unknown'}`);
}

function hostPlaybackEventAllowed(playerState) {
  if (!state || primingPlayer || playerInitializing || !isHost()) return false;
  if (!applyingRemote) return true;

  // Programmatic playback caused by an authoritative room update should not
  // echo back as a new host command. A contradictory event is different: it
  // represents a user transition and must be accepted even during the short
  // remote-apply window.
  if (playerState === YT.PlayerState.PLAYING) return !!state.playback.paused;
  if (playerState === YT.PlayerState.PAUSED) return !state.playback.paused;
  return false;
}

function onYouTubeStateChange(event) {
  if (!hostPlaybackEventAllowed(event.data)) return;

  const position = Number(ytPlayer?.getCurrentTime?.()) || 0;
  const duration = Number(ytPlayer?.getDuration?.()) || 0;

  if (event.data === YT.PlayerState.ENDED) {
    // Natural completion is authoritative room state. Do not use a timer or
    // position heuristic; the YouTube event itself defines the transition.
    command('pause', {
      position: Math.max(position, duration),
      ended: true
    });
    return;
  }

  if (event.data === YT.PlayerState.PLAYING) {
    const replaying = !!state.playback.ended;
    const playPosition = replaying ? 0 : position;

    if (replaying) {
      // YouTube's visible Replay control emits PLAYING from ENDED. Reset the
      // local player immediately, then make the server timeline authoritative.
      try { ytPlayer.seekTo?.(0, true); } catch {}
    }

    if (!primingPlayer) ytPlayer.unMute?.();
    command('play', { position: playPosition });
    return;
  }

  if (event.data === YT.PlayerState.PAUSED) {
    command('pause', { position });
  }
}

function onYouTubeRateChange() {
  if (!state || applyingRemote || primingPlayer || !isHost()) return;
  command('rate', { rate: ytPlayer?.getPlaybackRate?.() || 1 });
}
function onYouTubeVolumeChange() {
  savePlayerAudioPrefs();
}
function syncPlayer(options = {}) {
  if (!roomId || !state?.source?.videoId || !ytPlayer || !ytPlayerReady) return;
  const loadedId = ytPlayer.getVideoData?.()?.video_id;
  if (loadedId && loadedId !== state.source.videoId) {
    ensurePlayer(state.source.videoId);
    return;
  }
  if (!isHost() && typeof window.applyAdaptiveViewerSync === 'function') {
    // Playback lifecycle ownership stays here. Adaptive sync is a focused
    // viewer-correction service and must not replace this function wholesale.
    window.applyAdaptiveViewerSync(Boolean(options?.force));
    return;
  }

  const target = Number(state.playback.position) || 0;
  applyingRemote = true;
  try {
    const current = ytPlayer.getCurrentTime?.() || 0;
    if (Math.abs(current - target) > 0.8) ytPlayer.seekTo(target, true);
    if (ytPlayer.setPlaybackRate && Math.abs((ytPlayer.getPlaybackRate?.() || 1) - state.playback.rate) > 0.01) {
      ytPlayer.setPlaybackRate(state.playback.rate);
    }
    if (state.playback.paused) {
      ytPlayer.pauseVideo();
    } else {
      restorePlayerAudioPrefs();
      ytPlayer.playVideo();
    }
  } finally {
    setTimeout(() => { applyingRemote = false; }, 250);
  }
}
