(() => {
  let timer=null, nudgeUsed=false, stabilizing=false, attemptedVideoId='', generation=0;
  let pausedIntent=false, bufferSample=null, stallChecks=0;
  const BUFFER_GRACE_MS=1800, STALL_CHECK_MS=1500, STALL_CHECKS=3, BUFFER_AHEAD_SEC=3;

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
  function sampleBuffer(){
    return {fraction:Number(ytPlayer?.getVideoLoadedFraction?.())||0,current:Number(ytPlayer?.getCurrentTime?.())||0};
  }
  function bufferProgressed(next){
    return !bufferSample||next.fraction-bufferSample.fraction>.002||next.current-bufferSample.current>.15;
  }
  function sourceUrl(){
    const source=state?.source||{};
    return source.originalUrl||`https://www.youtube.com/watch?v=${source.videoId||''}`;
  }
  async function fallbackCandidate(url){
    const direct=await fetch(apiUrl('/voxelvision/api/youtube/stream'),{
      method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({url})
    });
    const directData=await direct.json().catch(()=>({}));
    if(direct.ok&&directData?.mediaUrl)return {url:directData.mediaUrl,type:directData.mediaType||'hls',provider:'youtube-direct',server:'youtube-direct',
      title:directData.title||'YouTube',audio:null,subtitles:[],referer:url};
    const cached=await fetch(apiUrl('/voxelvision/api/youtube/import'),{
      method:'POST',headers:{'Content-Type':'application/json'},cache:'no-store',body:JSON.stringify({url,quality:'max'})
    });
    const cachedData=await cached.json().catch(()=>({}));
    if(!cached.ok||!cachedData?.mediaUrl)throw new Error(cachedData?.error||directData?.error||'YouTube fallback was unavailable.');
    return {url:cachedData.mediaUrl,type:'file',provider:'youtube-cache',server:'local-cache',
      title:cachedData.title||'YouTube',audio:null,subtitles:[],referer:url};
  }
  async function stabilize(options={}){
    if(stabilizing||!eligible())return;
    if(options.resume===true)pausedIntent=false;
    const source={...(state?.source||{})}, videoId=source.videoId;
    if(!videoId||attemptedVideoId===videoId)return;
    attemptedVideoId=videoId;stabilizing=true;clearTimer();
    const token=++generation;
    const position=Number(ytPlayer?.getCurrentTime?.())||Number(state?.playback?.position)||0;
    const wasPaused=roomId?state?.playback?.paused===true:pausedIntent;
    const url=sourceUrl();
    try{
      try{ytPlayer?.pauseVideo?.();}catch{}
      if(roomId)await command('pause',{position,buffering:true});
      setStatus('Stabilizing YouTube playback… resolving a direct stream.');
      const candidate=await fallbackCandidate(url);
      if(token!==generation||state?.source?.videoId!==videoId)return;
      const loaded=await window.watchFusionMediaResolver?.loadCandidate?.(candidate,url);
      if(!loaded)throw new Error('Cached media could not replace the YouTube embed.');
      if(!await window.mediaPlayback?.ensureSource?.(state?.source))throw new Error('Resolved YouTube media did not become playable.');
      await window.mediaPlayback?.restore?.({position,paused:wasPaused});
      if(roomId){
        await command('seek',{position});
        if(!wasPaused)await command('play',{position});
      }
      setStatus(candidate.provider==='youtube-direct'?'Stable direct YouTube playback ready.':'Stable local YouTube playback ready.');
    }catch(error){
      if(token===generation){
        if(!wasPaused){try{ytPlayer?.playVideo?.();}catch{}if(roomId)await command('play',{position});}
        setStatus(`YouTube is still network-buffering · local stabilization unavailable: ${error?.message||'unknown error'}`);
      }
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
        schedule(STALL_CHECK_MS);return;
      }
      const next=sampleBuffer();
      if(bufferProgressed(next)){bufferSample=next;stallChecks=0;schedule(STALL_CHECK_MS);return;}
      bufferSample=next;stallChecks+=1;
      if(stallChecks<STALL_CHECKS){schedule(STALL_CHECK_MS);return;}
      void stabilize();
    },delay);
  }
  function observe(playerState){
    if(!eligible()){clearTimer();return false;}
    if(playerState===YT.PlayerState.BUFFERING){schedule();return true;}
    clearTimer();bufferSample=null;stallChecks=0;
    if(playerState===YT.PlayerState.PLAYING){pausedIntent=false;nudgeUsed=false;return false;}
    if(playerState===YT.PlayerState.ENDED||playerState===YT.PlayerState.PAUSED){pausedIntent=true;nudgeUsed=false;}
    return false;
  }
  function reset(){clearTimer();generation+=1;stabilizing=false;nudgeUsed=false;attemptedVideoId='';pausedIntent=false;bufferSample=null;stallChecks=0;}
  window.watchFusionYoutubeStability={observe,reset,stabilize};
})();
