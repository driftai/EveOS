(() => {
  let timer=null, nudgeUsed=false, stabilizing=false, attemptedVideoId='', generation=0;
  const BUFFER_GRACE_MS=1200, NUDGE_GRACE_MS=900, BUFFER_AHEAD_SEC=3;

  function eligible(){
    return !!state?.source?.videoId && (!roomId || isHost()) && !window.watchFusionLinkedTab?.active?.();
  }
  function clearTimer(){ if(timer)clearTimeout(timer);timer=null; }
  function bufferedAhead(){
    const duration=Number(ytPlayer?.getDuration?.())||0;
    const fraction=Number(ytPlayer?.getVideoLoadedFraction?.());
    const current=Number(ytPlayer?.getCurrentTime?.())||0;
    if(!(duration>0)||!Number.isFinite(fraction))return 0;
    return Math.max(0,duration*Math.max(0,Math.min(1,fraction))-current);
  }
  function sourceUrl(){
    const source=state?.source||{};
    return source.originalUrl||`https://www.youtube.com/watch?v=${source.videoId||''}`;
  }
  async function stabilize(){
    if(stabilizing||!eligible())return;
    const source={...(state?.source||{})}, videoId=source.videoId;
    if(!videoId||attemptedVideoId===videoId)return;
    attemptedVideoId=videoId;stabilizing=true;clearTimer();
    const token=++generation;
    const position=Number(ytPlayer?.getCurrentTime?.())||Number(state?.playback?.position)||0;
    const wasPaused=state?.playback?.paused===true;
    const url=sourceUrl();
    try{
      try{ytPlayer?.pauseVideo?.();}catch{}
      if(roomId)await command('pause',{position,buffering:true});
      setStatus('Stabilizing YouTube locally… caching the source once for smooth playback.');
      const response=await fetch(apiUrl('/voxelvision/api/youtube/import'),{
        method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',
        body:JSON.stringify({url,quality:'max'})
      });
      const data=await response.json().catch(()=>({}));
      if(!response.ok||!data?.mediaUrl)throw new Error(data?.error||'Local YouTube cache was unavailable.');
      if(token!==generation||state?.source?.videoId!==videoId)return;
      const candidate={url:data.mediaUrl,type:'file',provider:'youtube-cache',server:'local-cache',
        title:data.title||source.title||'YouTube',audio:null,subtitles:[],referer:url};
      const loaded=await window.watchFusionMediaResolver?.loadCandidate?.(candidate,url);
      if(!loaded)throw new Error('Cached media could not replace the YouTube embed.');
      await window.mediaPlayback?.ensureSource?.(state?.source);
      await window.mediaPlayback?.restore?.({position,paused:wasPaused});
      if(roomId){
        await command('seek',{position});
        if(!wasPaused)await command('play',{position});
      }
      setStatus('Stable local YouTube playback ready.');
    }catch(error){
      if(token===generation)setStatus(`YouTube is still network-buffering · local stabilization unavailable: ${error?.message||'unknown error'}`);
    }finally{
      if(token===generation)stabilizing=false;
    }
  }
  function schedule(delay=BUFFER_GRACE_MS){
    clearTimer();
    timer=setTimeout(()=>{
      timer=null;
      if(!eligible()||ytPlayer?.getPlayerState?.()!==YT.PlayerState.BUFFERING)return;
      if(!nudgeUsed&&bufferedAhead()>=BUFFER_AHEAD_SEC){
        nudgeUsed=true;try{ytPlayer?.playVideo?.();}catch{}
        schedule(NUDGE_GRACE_MS);return;
      }
      void stabilize();
    },delay);
  }
  function observe(playerState){
    if(!eligible()){clearTimer();return false;}
    if(playerState===YT.PlayerState.BUFFERING){schedule();return true;}
    clearTimer();
    if(playerState===YT.PlayerState.PLAYING){nudgeUsed=false;return false;}
    if(playerState===YT.PlayerState.ENDED||playerState===YT.PlayerState.PAUSED)nudgeUsed=false;
    return false;
  }
  function reset(){clearTimer();generation+=1;stabilizing=false;nudgeUsed=false;attemptedVideoId='';}
  window.watchFusionYoutubeStability={observe,reset,stabilize};
})();
