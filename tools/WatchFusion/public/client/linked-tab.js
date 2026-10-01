(() => {
  const CONTROL_ECHO_TTL_MS=2500;
  let link=null,peer=null,lastMetadata={},loadedPageUrl='',resolvingUrl='',pendingUrl='',resolveRevision=0,applying=false;
  let lastMirrorAnchor=null,mirrorInFlight=false,queuedMirror=null;
  const pendingControls=new Map();

  function active(){return !!link;}
  function canControl(){return roomId?isHost():true;}
  function setApplying(value){applying=!!value;}
  function status(message){if($('liveStatus'))$('liveStatus').textContent=message;}
  function clock(value){const n=Math.max(0,Math.floor(Number(value)||0));return `${Math.floor(n/60)}:${String(n%60).padStart(2,'0')}`;}
  async function post(path,body={}){
    const res=await fetch(apiUrl(path),{method:'POST',headers:{'Content-Type':'application/json',...(session?.memberId?{'x-member-id':session.memberId}:{})},body:JSON.stringify(body)});
    const data=await res.json().catch(()=>({}));if(!res.ok)throw new Error(data.error||data.message||'Linked-tab request failed.');return data;
  }
  function renderControls(metadata=lastMetadata){
    if(!active())return;
    document.querySelector('.watch-shell')?.classList.add('linked-tab-active');
    const controls=$('liveControls');if(controls)controls.hidden=false;
    $('liveVideo').hidden=true;$('liveListen').hidden=true;$('liveStats').hidden=true;$('liveAudioSyncWrap').hidden=true;$('liveQueueTools').hidden=true;$('liveQueueWrap').hidden=true;
    $('liveTitle').textContent=metadata.title||'Attached tab';$('liveGroup').textContent='State link';
    $('liveToggle').textContent=metadata.paused?'Play':'Pause';$('liveTime').textContent=`${clock(metadata.currentTime)} / ${clock(metadata.duration)}`;
    if(document.activeElement!==$('liveSeek')){$('liveSeek').max=metadata.duration||0;$('liveSeek').value=metadata.currentTime||0;}
    if(document.activeElement!==$('liveRate'))$('liveRate').value=String(metadata.rate||1);
    if(document.activeElement!==$('liveVolume'))$('liveVolume').value=metadata.volume??1;
    for(const button of controls.querySelectorAll('[data-live-action]'))button.disabled=!canControl();
    for(const id of ['liveSeek','liveRate','liveVolume'])$(id).disabled=!canControl();
    $('liveStop').hidden=false;$('linkTabBtn').textContent='Unlink playing tab';$('linkTabBtn').setAttribute('aria-pressed','true');
  }
  function restoreUi(){
    document.querySelector('.watch-shell')?.classList.remove('linked-tab-active');
    $('linkTabBtn').textContent='Link a playing tab';$('linkTabBtn').setAttribute('aria-pressed','false');
    if(state?.source?.kind!=='live')$('liveControls').hidden=true;
    $('liveListen').hidden=false;$('liveStats').hidden=false;
  }
  function control(action,value){
    if(!peer||!canControl())return false;
    const numeric=Number(value)||0;
    if(['seek','play','pause','rate','volume'].includes(action))pendingControls.set(action,{value:numeric,at:performance.now(),sampledAt:Date.now()});
    peer.control(action,numeric);return true;
  }
  function pendingSatisfied(action,pending,metadata){
    if(action==='seek')return Math.abs((Number(metadata.currentTime)||0)-pending.value)<=0.65;
    if(action==='play')return metadata.paused===false;
    if(action==='pause')return metadata.paused===true;
    if(action==='rate')return Math.abs((Number(metadata.rate)||1)-pending.value)<=0.02;
    if(action==='volume')return Math.abs((Number(metadata.volume)||0)-pending.value)<=0.03;
    return true;
  }
  function applyPendingControls(metadata={}){
    const next={...metadata},now=performance.now();
    for(const [action,pending] of pendingControls){
      if(now-pending.at>CONTROL_ECHO_TTL_MS||pendingSatisfied(action,pending,metadata)){pendingControls.delete(action);continue;}
      if(action==='seek'||action==='play'||action==='pause'){
        next.currentTime=pending.value;next.sampledAt=pending.sampledAt;
        if(action==='play')next.paused=false;
        if(action==='pause')next.paused=true;
      }else if(action==='rate')next.rate=pending.value;
      else if(action==='volume')next.volume=pending.value;
    }
    return next;
  }
  function followLocal(metadata,force=false){
    if(!state?.source)return;
    applying=true;
    try{
      if(state.source.kind==='media')window.mediaPlayback?.followAttached?.(metadata,{force});
      else if(state.source.videoId||state.source.kind==='youtube')window.watchFusionYoutubeFollow?.(metadata,{force});
    }finally{setTimeout(()=>{applying=false;},320);}
  }
  async function mirrorNow(metadata,force=false){
    if(!active()||!loadedPageUrl)return;
    const plan=window.WatchFusionLinkedPlaybackSync?.mirrorPlan?.(metadata,lastMirrorAnchor,{force});
    if(!plan?.publish)return false;
    if(!roomId){
      if(state?.playback)state.playback={...state.playback,position:plan.target,paused:!!metadata.paused,ended:!!metadata.ended,
        rate:Number(metadata.rate)||1,volume:Math.max(0,Math.min(100,(Number(metadata.volume)||0)*100)),muted:Number(metadata.volume)===0,updatedAt:Date.now()};
      lastMirrorAnchor=plan.anchor;return true;
    }
    if(!isHost())return;
    if(mirrorInFlight){queuedMirror={metadata:{...metadata},force:queuedMirror?.force===true||force};return false;}
    const activeLink=link;
    mirrorInFlight=true;
    try{
      const ok=await command('mirror',{position:plan.target,paused:!!metadata.paused,ended:!!metadata.ended,
        rate:Number(metadata.rate)||1,volume:Math.max(0,Math.min(100,(Number(metadata.volume)||0)*100)),muted:Number(metadata.volume)===0});
      if(ok&&link===activeLink)lastMirrorAnchor=plan.anchor;
      return ok;
    }finally{
      mirrorInFlight=false;
      const queued=queuedMirror;queuedMirror=null;
      if(queued)void mirrorNow(queued.metadata,queued.force);
    }
  }
  function scheduleMirror(metadata,force=false){
    lastMetadata=metadata;if(!loadedPageUrl)return;
    void mirrorNow(metadata,force);
  }
  async function followUrl(url){
    const value=String(url||'').trim();if(!/^https?:\/\//i.test(value)||value===loadedPageUrl||value===resolvingUrl)return;
    if(resolvingUrl){pendingUrl=value;return;}
    const revision=++resolveRevision;resolvingUrl=value;pendingUrl='';status('Attached tab changed · resolving its playable source…');
    const ok=await window.watchFusionMediaResolver?.resolveAndLoad?.(value,{silent:true});
    if(revision!==resolveRevision)return;
    resolvingUrl='';
    if(ok){loadedPageUrl=value;lastMirrorAnchor=null;queuedMirror=null;pendingControls.clear();renderControls(lastMetadata);followLocal(lastMetadata,true);scheduleMirror(lastMetadata,true);status('Attached tab state linked · WatchFusion is playing the resolved source.');}
    else status('Attached tab is connected, but its playable source could not be resolved yet.');
    const queued=pendingUrl;pendingUrl='';
    if(queued&&queued!==loadedPageUrl)void followUrl(queued);
  }
  function onMetadata(metadata={}){
    lastMetadata=applyPendingControls({...lastMetadata,...metadata});renderControls(lastMetadata);
    const pageUrl=String(lastMetadata.pageUrl||'');
    if(pageUrl&&pageUrl!==loadedPageUrl){void followUrl(pageUrl);return;}
    followLocal(lastMetadata);scheduleMirror(lastMetadata);
  }
  function connectPeer(){
    peer?.stop();if(!link)return;
    peer=new WatchFusionLivePeer({base:location.origin,id:link.id,token:link.publisherToken,roomId,memberId:session?.memberId,
      onStatus:message=>status(message==='Source connected'?'Attached tab connected · matching media source…':message),
      onMetadata,onReady:()=>status('Waiting for attached tab state…')});
  }
  async function start(){
    if(roomId&&!isHost())return setStatus('Only the host can attach the room source.');
    if(active())return stop();
    if(state?.source?.kind==='live'&&state.source.mode==='audioflix')await window.unloadWatchFusionMedia?.();
    const created=await post('/api/live',{});link=created;loadedPageUrl='';resolvingUrl='';pendingUrl='';lastMetadata={};lastMirrorAnchor=null;queuedMirror=null;pendingControls.clear();resolveRevision++;
    const pairing=new URL(location.origin);pairing.hash=`live=${created.id}.${created.publisherToken}`;
    $('livePairLink').value=pairing.href;$('livePairHelp').hidden=false;$('findMediaPanel').hidden=false;renderControls({});
    status('Pair the source tab. WatchFusion will resolve its URL and keep only playback state attached.');connectPeer();
  }
  async function stop(options={}){
    if(!link)return true;
    const old=link;link=null;resolveRevision++;resolvingUrl='';pendingUrl='';loadedPageUrl='';lastMirrorAnchor=null;queuedMirror=null;pendingControls.clear();
    peer?.stop();peer=null;await post(`/api/live/${old.id}/stop`,old).catch(()=>{});
    $('livePairHelp').hidden=true;restoreUi();if(!options.quiet)setStatus('Source tab unlinked · the page was restored to normal.');return true;
  }
  function reconnect(){if(!link)return start();connectPeer();return true;}
  $('linkTabBtn').onclick=()=>{void(active()?stop():start());};
  window.watchFusionLinkedTab={active,applying:()=>applying,setApplying,control,start,stop,reconnect,render:renderControls,metadata:()=>lastMetadata};
})();
