/*
 * Adaptive YouTube viewer drift correction.
 * Lifecycle ownership stays in commands.js; this service only converges viewers.
 */
(() => {
  // YouTube only exposes coarse playback-rate steps. Do not speed a phone up for
  // sub-frame / network-jitter-sized offsets; that creates the visible "phone is faster"
  // effect we are trying to remove. Correct only sustained drift outside this deadband.
  const SUPPORTED_RATES=[0.25,0.5,0.75,1,1.25,1.5,2],SOFT_DRIFT_SEC=0.20,HARD_DRIFT_SEC=1.25,SYNC_TOLERANCE_SEC=0.12,SEEK_COOLDOWN_MS=2500,TICK_MS=250;
  let anchorKey='',anchorPosition=0,anchorServerTime=0,seekCooldownUntil=0,lastStatus='',viewerSawEnded=false,replayKey='';
  const nearestHigherRate=base=>SUPPORTED_RATES.find(rate=>rate>base+0.001)||base;
  const nearestLowerRate=base=>{for(let i=SUPPORTED_RATES.length-1;i>=0;i--)if(SUPPORTED_RATES[i]<base-0.001)return SUPPORTED_RATES[i];return base;};
  function syncStateKey(){const p=state?.playback;return p?[state?.revision,p.updatedAt,p.projectedAt,p.position,p.rate,p.paused,p.ended].join('|'):'';}
  function refreshAnchor(force=false){if(!state?.playback)return;const key=syncStateKey();if(!force&&key&&key===anchorKey)return;anchorKey=key;anchorPosition=Number(state.playback.position)||0;anchorServerTime=Number(state.playback.projectedAt)||Number(state.serverTime)||Date.now();}
  function serverNow(){return typeof estimatedServerNow==='function'?estimatedServerNow():Date.now();}
  function predictedPosition(){const p=state?.playback;if(!p)return 0;if(p.paused||p.ended)return Number(p.position)||0;refreshAnchor(false);return Math.max(0,anchorPosition+Math.max(0,(serverNow()-anchorServerTime)/1000)*(Number(p.rate)||1));}
  function statusForDrift(diff){const abs=Math.abs(diff);if(abs<=SYNC_TOLERANCE_SEC)return isTryCloudflare?'Connected (remote sync)':'Connected';return `Catching up · ${abs.toFixed(1)}s ${diff>0?'behind':'ahead'}`;}
  function markStable(resume=false){const visible=$('syncStatus')?.textContent||'';if(lastStatus!=='stable'||(resume&&/^(Catching up|Re-synced)/.test(visible)))setStatus(statusForDrift(0));lastStatus='stable';}
  function playbackSnapshotKey(){const p=state?.playback;return p?[state?.revision,p.updatedAt,p.position,p.paused,p.ended].join('|'):'';}
  function restartViewerFromEnded(target,baseRate){const key=playbackSnapshotKey();if(!key||key===replayKey)return false;replayKey=key;viewerSawEnded=false;try{const startSeconds=Math.max(0,Number(target)||0);if(typeof ytPlayer.loadVideoById==='function')ytPlayer.loadVideoById({videoId:state.source.videoId,startSeconds});else ytPlayer.seekTo?.(startSeconds,true);ytPlayer.setPlaybackRate?.(baseRate);requestViewerPlayback();return true;}catch{return false;}}
  function applyViewerCorrection(force=false){if(!roomId||!state?.source?.videoId||!ytPlayer||!ytPlayerReady||isHost())return;applyRoomAudioState();refreshAnchor(false);const baseRate=Math.min(2,Math.max(0.25,Number(state.playback.rate)||1)),current=Number(ytPlayer.getCurrentTime?.())||0,target=predictedPosition(),diff=target-current,abs=Math.abs(diff),nowMs=performance.now();if(state.playback.ended){viewerSawEnded=true;try{ytPlayer.setPlaybackRate?.(baseRate);if(abs>SYNC_TOLERANCE_SEC)ytPlayer.seekTo?.(target,true);ytPlayer.pauseVideo?.();}catch{}markStable(true);return true;}if(state.playback.paused){viewerSawEnded=false;try{ytPlayer.setPlaybackRate?.(baseRate);if(abs>SYNC_TOLERANCE_SEC)ytPlayer.seekTo?.(target,true);ytPlayer.pauseVideo?.();}catch{}markStable(true);return true;}if(viewerSawEnded&&target<=1.5&&restartViewerFromEnded(target,baseRate)){anchorPosition=target;anchorServerTime=serverNow();return true;}viewerSawEnded=false;if(force){try{ytPlayer.setPlaybackRate?.(baseRate);ytPlayer.seekTo?.(target,true);requestViewerPlayback();}catch{}anchorPosition=target;anchorServerTime=serverNow();seekCooldownUntil=nowMs+SEEK_COOLDOWN_MS;lastStatus='resyncing';setStatus('Re-synced');return true;}if(abs>=HARD_DRIFT_SEC&&nowMs>=seekCooldownUntil){try{ytPlayer.setPlaybackRate?.(baseRate);ytPlayer.seekTo?.(target,true);}catch{}anchorPosition=target;anchorServerTime=serverNow();seekCooldownUntil=nowMs+SEEK_COOLDOWN_MS;lastStatus='resyncing';setStatus('Re-synced');}else if(abs>=SOFT_DRIFT_SEC||(lastStatus==='catching-up'&&abs>SYNC_TOLERANCE_SEC)){try{ytPlayer.setPlaybackRate?.(diff>0?nearestHigherRate(baseRate):nearestLowerRate(baseRate));}catch{}lastStatus='catching-up';setStatus(statusForDrift(diff));}else{try{ytPlayer.setPlaybackRate?.(baseRate);}catch{}markStable();}requestViewerPlayback();return true;}
  window.applyAdaptiveViewerSync=applyViewerCorrection;
  const originalRender=render;render=function watchPartyAdaptiveRender(){refreshAnchor(true);return originalRender();};
  const syncButton=$('syncBtn');if(syncButton)syncButton.onclick=()=>syncPlayer({force:true});
  setInterval(()=>{try{if(!roomId||!state?.source?.videoId||!ytPlayer||!ytPlayerReady||isHost())return;applyViewerCorrection(false);}catch{}},TICK_MS);
  document.addEventListener('visibilitychange',()=>{if(document.visibilityState==='visible'){refreshAnchor(true);if(roomId&&!isHost())applyViewerCorrection(false);}});
})();
