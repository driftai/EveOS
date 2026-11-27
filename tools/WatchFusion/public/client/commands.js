function ensurePlayer(videoId, recoveryStart = null) {
  if (!videoId) return;
  const recoveryRoom = Number.isFinite(recoveryStart) ? roomId : null, recoveryEpoch = state?.presentationEpoch;
  const previousPending = pendingVideoId;
  pendingVideoId = videoId;
  showYouTubePlayer();
  if (continueLinkedViewerTrack(videoId, previousPending)) return;
  if (previousPending && previousPending !== videoId) {
    playerPrimed = false;
    playerInitializing = false;
    autoplayWasBlocked = false;
  }
  loadYouTubeApi().then(() => {
    if (pendingVideoId !== videoId) return;
    if (!ytPlayer) {
      ytPlayerReady = false;
      playerInitializing = true;
      ytPlayer = new YT.Player('player', {
        videoId: pendingVideoId,
        playerVars: {
          ...(Number.isFinite(recoveryStart) ? {start:Math.max(0, Math.floor(recoveryStart))} : {}),
          autoplay: 1,
          controls: 1,
          rel: 0,
          modestbranding: 1,
          playsinline: 1,
          origin: window.location.origin
        },
        events: {
          onReady: async event => {
            if (event?.target && event.target !== ytPlayer) return;
            const readyPlayer=ytPlayer;ytPlayerReady = true;
            window.watchFusionYoutubeLayout?.refresh?.();
            try {
              const frame = ytPlayer.getIframe?.();
              if (frame) {
                frame.setAttribute('allow', 'autoplay; encrypted-media; picture-in-picture');
                frame.style.display = 'block';
                frame.hidden = false;
              }
            } catch {}
            const desired = pendingVideoId;
            if (recoveryRoom && recoveryRoom === roomId && state?.presentationEpoch === recoveryEpoch &&
                desired === videoId && state.source?.videoId === videoId && !isHost() && followsRoomPlayback()) {
              const recovering = ytPlayer;
              // The constructor already loaded this track at the live position. A
              // slow video ID on ready must not cue it again from zero.
              try { await waitForPlayerCued(videoId); } catch { /* normal sync retries a mismatched player */ }
              if (ytPlayer === recovering && roomId === recoveryRoom && state?.presentationEpoch === recoveryEpoch && state.source?.videoId === videoId) {
                playerInitializing = false;
                syncPlayer();
              }
              return;
            }
            if (desired) {
              const current = ytPlayer.getVideoData?.()?.video_id || '';
              if (current !== desired) {
                applyingRemote = true;
                ytPlayer.cueVideoById(desired);
                await waitForPlayerCued(desired);if(ytPlayer!==readyPlayer||pendingVideoId!==desired)return;
              }
            }
            if (roomId) {
              await primeYouTubePlayer();
              // Allow manual host playback after blocked autoplay.
              playerInitializing = false;
              syncHydratedPlayer(desired);
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
          onAutoplayBlocked: event => {
            if (event?.target && event.target !== ytPlayer) return; window.WatchFusionRoomAudioUnlock?.autoplayBlocked?.();
            if(ytPlayer?.getPlayerState?.()!==1)window.WatchFusionLinkedAcquisition?.terminal?.('autoplay-blocked',event);
            const playingState = window.YT?.PlayerState?.PLAYING ?? 1;
            const alreadyPlaying = ytPlayer?.getPlayerState?.() === playingState;
            if (roomId && !userGesturePrimeUsed && !alreadyPlaying) {
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
      const desired = pendingVideoId;
      ytPlayer.cueVideoById(desired);
      waitForPlayerCued(desired).then(async () => {
        await primeYouTubePlayer(true);
        applyingRemote = false;
        playerInitializing = false;
        syncHydratedPlayer(desired);
      }).catch(() => {
        applyingRemote = false;
        playerInitializing = false;
        syncHydratedPlayer(desired);
      });
    } else {
      if (roomId) {
        primeYouTubePlayer().then(() => {
          playerInitializing = false;
          syncHydratedPlayer(pendingVideoId);
        });
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
      if (!ytPlayer || !ytPlayerReady) {
        if (performance.now() - started >= timeoutMs) return reject(new Error('YouTube player is not ready.'));
        setTimeout(tick, 50);
        return;
      }
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
  const player = ytPlayer, video = pendingVideoId, room = roomId, epoch = state?.presentationEpoch;
  const same = () => ytPlayer === player && pendingVideoId === video && roomId === room && state?.presentationEpoch === epoch;
  primingPlayer = true; window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
  suppressAudioPersistence = true;
  const wasApplyingRemote = applyingRemote;
  applyingRemote = true;
  return new Promise(resolve => {
    let settled = false, sawPlaying = false, first = null, watch = null, timeout = null, warm = false;
    const finish = () => {
      if (settled) return;
      settled = true; clearInterval(watch); clearTimeout(timeout);
      if (!same()) { primingPlayer = false; applyingRemote = wasApplyingRemote; suppressAudioPersistence = false; resolve(); return; }
      try {
        window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
        // Only warm a paused room, never pause an already-running join to prime it.
        if (state?.playback?.paused) {
          player.pauseVideo?.();
          const target = Number(state.playback.position) || 0;
          const current = Number(player.getCurrentTime?.());
          if (!followsRoomPlayback() && (!Number.isFinite(current) || Math.abs(current-target)>.5)) player.seekTo?.(target, true);
        }
      } catch {}
      playerPrimed = warm;
      if (!warm) { autoplayWasBlocked = true; installUserGesturePrime(); }
      primingPlayer = false;
      if (!applyRoomAudioState()) restorePlayerAudioPrefs();
      applyingRemote = wasApplyingRemote;
      setTimeout(() => { suppressAudioPersistence = false; }, 0);
      window.watchFusionRoomSyncLog?.note?.('startup-prime-result', {reason:warm?'motion-confirmed':sawPlaying?'decoder-unverified':'play-unconfirmed'});
      resolve();
    };
    const observe = () => {
      if (!same()) return finish();
      try {
        if (player.getPlayerState?.() !== YT.PlayerState.PLAYING) { first = null; return; }
        sawPlaying = true;
        const at = performance.now(), pos = Number(player.getCurrentTime?.());
        if (!Number.isFinite(pos)) { first = null; return; }
        if (!first) { first = {at,pos}; return; }
        const elapsed = at-first.at, advance = pos-first.pos;
        if (elapsed < 200) return;
        const rate = Number(player.getPlaybackRate?.()) || 1;
        if (advance >= elapsed/1000*rate*.5 && advance <= elapsed/1000*rate*1.5+.04) {
          warm = true; finish();
        } else if (elapsed >= 500 || advance < -.08 || advance > elapsed/1000*rate*1.5+.04) first = {at,pos};
      } catch { finish(); }
    };
    timeout = setTimeout(finish, state?.playback?.paused ? 4500 : 2500);
    try {
      if (state?.playback?.paused) player.mute?.();
      if (player.getPlayerState?.() !== YT.PlayerState.PLAYING) { player.mute?.(); player.playVideo?.(); }
      watch = setInterval(observe, 50); observe();
    } catch { finish(); }
  });
}
function onYouTubeError(event) {
  if (event?.target && event.target !== ytPlayer) return;
  const code = Number(event?.data); if([2,100,101,150,153].includes(code))window.WatchFusionLinkedAcquisition?.terminal?.('provider-error',event);
  try { const h=location.hostname, reference=/(?:^|\.)sslip\.io$/i.test(h)?'sslip':/^(localhost|127\.0\.0\.1)$/i.test(h)?'loopback':/^(?:\d{1,3}\.){3}\d{1,3}$/.test(h)?'raw-ip':/(?:^|\.)trycloudflare\.com$/i.test(h)?'cloudflare':'other';window.watchFusionRoomSyncLog?.note?.('media-player-error',{reason:'youtube-player-error',status:code,reference}); }catch{}
  if ([101,150,153].includes(code) && window.watchFusionLinkedTab?.active?.()) {
    const fallback = typeof location !== 'undefined' && /^(localhost|127\.0\.0\.1|(?:\d{1,3}\.){3}\d{1,3})$/i.test(location.hostname);
    if(fallback)window.watchFusionEveBridge?.originFailure?.(code);
    return setStatus(fallback ? 'YouTube embedding failed on a fallback origin. Unload media, refresh EveOS WatchFusion, and re-link to retry on SSLIP.' : 'YouTube embedding failed. The linked source was preserved; try another video or unlink before changing playback mode.');
  }
  if (code === 2) return setStatus('YouTube rejected the video ID.');
  if (code === 5) return setStatus('YouTube could not play this video in the embedded player.');
  if (code === 100) return setStatus('This video is unavailable or private.');
  if (code === 101 || code === 150) {
    setStatus('This video blocks embedding · switching to Direct video compatibility mode…');
    void window.watchFusionYoutubeStability?.stabilize?.({ blocked: true });
    return;
  }
  setStatus(`YouTube error ${code || 'unknown'}`);
}
function hostPlaybackEventAllowed(playerState) {
  if (!state || primingPlayer || playerInitializing || followsRoomPlayback()) return false;
  if (!applyingRemote) return true;
  // Programmatic playback caused by an authoritative room update should not
  // echo back as a new host command. A contradictory event is different: it
  // represents a user transition and must be accepted even during the short
  // remote-apply window.
  if (playerState === YT.PlayerState.PLAYING) return !!state.playback.paused;
  if (playerState === YT.PlayerState.PAUSED) return !state.playback.paused;
  return false;
}
// Automatic room corrections are local player operations, never commands to the
// attached source. Keep native iframe controls working outside correction jobs.
function linkedRoomViewerCorrectionActive(){
  return !!(roomId && state?.linkedSourceActive === true && followsRoomPlayback() &&
    (applyingRemote || playerInitializing || primingPlayer || window.watchFusionViewerArbiter?.owns?.() || window.watchFusionHostZeroCenter?.isApplying?.() ||
     window.WatchFusionZeroConverge?.isApplying?.()));
}
function onYouTubeStateChange(event) {
  if(event?.target&&event.target!==ytPlayer)return;
  const linked = window.watchFusionLinkedTab;
  if (linked?.active?.() && (!roomId || isHost())) { // v13.10.7: solo embedded controls drive the source too
    window.watchFusionYoutubeStability?.observe?.(event.data);
    const previewGuard=window.WatchFusionPlaylistContinuity?.guardPreviewEvent?.(event.data,linked.metadata?.(),ytPlayer?.getVideoData?.()?.video_id,state?.source?.videoId);
    if (linked.applying?.() || window.WatchFusionLinkedAcquisition?.holding?.() || linkedRoomViewerCorrectionActive() || primingPlayer || previewGuard) {linkedYoutubePositionSample=null;return;}
    const paused = event.data === YT.PlayerState.PAUSED;
    const position = Number(ytPlayer?.getCurrentTime?.()) || 0;
    if (paused || event.data === YT.PlayerState.PLAYING) {
      const matchesSource = linked.metadata?.()?.paused === paused;
      if (!matchesSource && !linked.pendingControl?.('play') && !linked.pendingControl?.('pause')) linked.control(paused ? 'pause' : 'play', position);
    } else if (event.data === YT.PlayerState.BUFFERING && window.WatchFusionLinkedPlaybackSync?.positionJumped(position, linkedYoutubePositionSample)) linked.control('seek', position);
    if (event.data !== YT.PlayerState.BUFFERING) sampleLinkedYoutubePosition(false);
    return;
  }
  if (window.watchFusionYoutubeStability?.observe?.(event.data)) return;
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

    command('play', { position: playPosition });
    return;
  }

  if (event.data === YT.PlayerState.PAUSED) {
    command('pause', { position });
  }
}
function onYouTubeRateChange(event) {
  if(event?.target&&event.target!==ytPlayer||window.WatchFusionLinkedAcquisition?.holding?.())return;
  if(linkedRoomViewerCorrectionActive()||window.watchFusionHostZeroCenter?.isApplying?.()||window.WatchFusionZeroConverge?.isApplying?.()||window.WatchFusionSoloLinkSync?.isApplying?.())return;
  if(window.watchFusionLinkedTab?.active?.()&&(!roomId||isHost())){if(!window.watchFusionLinkedTab?.applying?.())window.watchFusionLinkedTab.control('rate',ytPlayer?.getPlaybackRate?.()||1);return;}
  if (!state || applyingRemote || primingPlayer || followsRoomPlayback()) return;
  command('rate', { rate: ytPlayer?.getPlaybackRate?.() || 1 });
}
function onYouTubeVolumeChange(event){
  if(event?.target&&event.target!==ytPlayer||window.WatchFusionLinkedAcquisition?.holding?.())return;
  if(window.watchFusionLinkedTab?.active?.()&&(!roomId||isHost())&&!window.watchFusionLinkedTab?.applying?.()){
    // A decoder reset is not a new room-volume intent.
    if(roomId && state?.roomAudioPinned){applyRoomAudioState();return;}
    if(ytPlayer?.isMuted?.())return;
    const observed=Number(ytPlayer?.getVolume?.());if(!Number.isFinite(observed)||observed<=0)return;
    window.watchFusionLinkedTab.control('volume',observed/100);return;
  }
  observeYouTubeAudio();
}
function requestViewerPlayback() {
  if (!ytPlayer || !ytPlayerReady || !state?.playback || state.playback.paused || state.playback.ended) return;
  const playingState = window.YT?.PlayerState?.PLAYING ?? 1;
  const bufferingState = window.YT?.PlayerState?.BUFFERING ?? 3;
  const playerState = ytPlayer.getPlayerState?.();
  if (playerState === bufferingState) return;
  const alreadyPlaying = playerState === playingState;
  if (alreadyPlaying) {
    playerPrimed = true;
    playerInitializing = false;
    if (!autoplayWasBlocked || userGesturePrimeUsed) applyRoomAudioState(ytPlayer, userGesturePrimeUsed);
    return;
  }
  if (requestViewerPlayback.checkTimer) return;
  const mutedRetry = autoplayWasBlocked && !userGesturePrimeUsed, requestedVideo = state.source?.videoId;
  try {
    window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
    if (mutedRetry) ytPlayer.mute?.();
    else if (!applyRoomAudioState(ytPlayer, userGesturePrimeUsed)) restorePlayerAudioPrefs();
    ytPlayer.playVideo?.();
  } catch {}
  requestViewerPlayback.checkTimer = setTimeout(() => {
    requestViewerPlayback.checkTimer = null;
    if (!ytPlayer || state?.source?.videoId !== requestedVideo || state?.playback?.paused || state?.playback?.ended) return;
    if (ytPlayer.getPlayerState?.() === bufferingState) return;
    if (ytPlayer.getPlayerState?.() === playingState) {
      playerPrimed = true;
      playerInitializing = false;
      if (userGesturePrimeUsed) {
        autoplayWasBlocked = false;
        applyRoomAudioState(ytPlayer, true);
      } else if (mutedRetry) {
        setStatus('Synchronized playback is muted · tap WatchFusion once for audio');
      }
      return;
    }
    autoplayWasBlocked = !userGesturePrimeUsed;
    if (autoplayWasBlocked) installUserGesturePrime();
    try {
      if (autoplayWasBlocked) ytPlayer.mute?.();
      ytPlayer.playVideo?.();
    } catch {}
    if (autoplayWasBlocked) setStatus('Starting synchronized playback muted · tap WatchFusion once for audio');
  }, 320);
}
function syncHydratedPlayer(videoId = state?.source?.videoId) {
  const expected = String(videoId || '');
  if (expected && state?.source?.videoId !== expected) return false;
  const forceViewer = followsRoomPlayback();
  syncPlayer({ hydrateHost: true, force: forceViewer });
  if (forceViewer && expected) {
    setTimeout(() => {
      if (!roomId || !followsRoomPlayback() || !ytPlayerReady || state?.source?.videoId !== expected) return;
      if ((ytPlayer?.getVideoData?.()?.video_id || '') !== expected) return;
      syncPlayer();
    }, 350);
  }
  return true;
}
function syncPlayer(options = {}) {
  if (!roomId || !state?.source?.videoId || !ytPlayer || !ytPlayerReady) return;
  const loadedId = ytPlayer.getVideoData?.()?.video_id;
  if (loadedId && loadedId !== state.source.videoId) {
    ensurePlayer(state.source.videoId);
    return;
  }
  if (!followsRoomPlayback() && options.hydrateHost !== true) return;
  if (followsRoomPlayback() && typeof window.applyAdaptiveViewerSync === 'function') {
    // Playback lifecycle ownership stays here. Adaptive sync is a focused
    // viewer-correction service and must not replace this function wholesale.
    window.applyAdaptiveViewerSync(Boolean(options.force), false, options.explicitSync === true);
    return;
  }
  const target = Number(state.playback.position) || 0;
  applyingRemote = true;
  try {
    applyRoomAudioState();
    const current = ytPlayer.getCurrentTime?.() || 0;
    if (Math.abs(current - target) > 0.8) ytPlayer.seekTo(target, true);
    if (ytPlayer.setPlaybackRate && Math.abs((ytPlayer.getPlaybackRate?.() || 1) - state.playback.rate) > 0.01) {
      ytPlayer.setPlaybackRate(state.playback.rate);
    }
    if (state.playback.paused) {
      ytPlayer.pauseVideo();
    } else {
      ytPlayer.playVideo();
    }
  } finally {
    setTimeout(() => { applyingRemote = false; }, 250);
  }
}
let linkedYoutubePositionSample=null;
function sampleLinkedYoutubePosition(forwardSeek = true){
  if(linkedRoomViewerCorrectionActive()){linkedYoutubePositionSample=null;return;}
  const linked=window.watchFusionLinkedTab;
  if(!linked?.active?.()||!ytPlayer||!ytPlayerReady||linked.applying?.()||playerInitializing||window.WatchFusionLinkedAcquisition?.holding?.()){if(!linked?.active?.()||linked?.applying?.())linkedYoutubePositionSample=null;return;}
  const playerState=ytPlayer.getPlayerState?.();
  if(playerState===YT.PlayerState.BUFFERING)return;
  const position=Number(ytPlayer.getCurrentTime?.())||0,now=performance.now(),rate=Number(ytPlayer.getPlaybackRate?.())||1;
  const jumped=window.WatchFusionLinkedPlaybackSync?.positionJumped?.(position,linkedYoutubePositionSample,now)===true;
  if(forwardSeek&&jumped&&(!roomId||isHost())&&!window.WatchFusionSoloLinkSync?.isApplying?.())linked.control('seek',position);
  linkedYoutubePositionSample={position,at:now,playing:playerState===YT.PlayerState.PLAYING,rate};
}
setInterval(()=>{observeYouTubeAudio();sampleLinkedYoutubePosition();},250);
function followAttachedYouTube(metadata = {}, options = {}) {
  if(window.WatchFusionLinkedAcquisition?.observe?.(options.sourceSample||metadata))return false;
  if(!ytPlayer||!ytPlayerReady)return false;
  const current=Number(ytPlayer.getCurrentTime?.())||0,playerState=ytPlayer.getPlayerState?.();
  const plan=window.WatchFusionLinkedPlaybackSync?.youtubePlan(metadata,playerState,current,options);
  if(!plan)return false;
  if(!roomId&&!options.force&&metadata.paused===false&&!metadata.ended&&playerState===1&&Date.now()-Number(metadata.sampledAt)>900)return true;
  const rate=Math.min(2,Math.max(.25,Number(metadata.rate)||1)),volume=metadata.volume;
  const rateChanged=!window.watchFusionHostZeroCenter?.isApplying?.() && !window.WatchFusionZeroConverge?.isApplying?.() && !window.WatchFusionSoloLinkSync?.isApplying?.() && Math.abs((Number(ytPlayer.getPlaybackRate?.())||1)-rate)>.01;
  const volumeChanged=Number.isFinite(volume)&&Math.abs((Number(ytPlayer.getVolume?.())||0)-Math.max(0,Math.min(1,volume))*100)>.5;
  if(!plan.seek&&!plan.pause&&!plan.play&&!rateChanged&&!volumeChanged)return true;
  const audioOnly=!roomId&&!plan.seek&&!plan.pause&&!plan.play&&!rateChanged&&volumeChanged,applyKind=audioOnly?'solo-audio':undefined;
  window.watchFusionLinkedTab?.setApplying?.(true,applyKind);applyingRemote=true;
  try{
    if(plan.seek){window.watchFusionLinkedTab?.suppressPlaybackEcho?.();ytPlayer.seekTo?.(plan.target,true);linkedYoutubePositionSample={position:plan.target,at:performance.now(),playing:metadata.paused!==true,rate};}
    if(rateChanged)ytPlayer.setPlaybackRate?.(rate);
    if(volumeChanged)ytPlayer.setVolume?.(Math.max(0,Math.min(1,volume))*100);
    if(plan.pause)ytPlayer.pauseVideo?.();else if(plan.play)ytPlayer.playVideo?.();
  }catch{}
  finally{setTimeout(()=>{applyingRemote=false;window.watchFusionLinkedTab?.setApplying?.(false,applyKind);},250);}
  return true;
}
window.watchFusionYoutubeFollow=followAttachedYouTube;
