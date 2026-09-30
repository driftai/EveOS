function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function formatTime(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const whole = Math.floor(seconds);
  const hours = Math.floor(whole / 3600);
  const minutes = Math.floor((whole % 3600) / 60);
  const secs = whole % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
    : `${minutes}:${String(secs).padStart(2, '0')}`;
}

function summarizeIntervals(values) {
  if (!values?.length) {
    return { count:0, avgMs:null, p95Ms:null, worstMs:null, over50Ms:0, over100Ms:0 };
  }
  const sorted=[...values].sort((a,b)=>a-b);
  const pick=p=>sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))];
  return {
    count:values.length,
    avgMs:values.reduce((sum,value)=>sum+value,0)/values.length,
    p95Ms:pick(.95),
    worstMs:sorted.at(-1),
    over50Ms:values.filter(value=>value>50).length,
    over100Ms:values.filter(value=>value>100).length
  };
}

async function playbackSnapshot(frame) {
  return frame.evaluate(() => {
    const video=document.querySelector('#mediaVideo');
    if(video&&video.readyState>=1){
      return {
        mode:'direct',
        ready:true,
        currentTime:Number(video.currentTime)||0,
        duration:Number.isFinite(video.duration)?Number(video.duration):0,
        paused:!!video.paused,
        ended:!!video.ended,
        state:null,
        stateName:video.ended?'ENDED':video.paused?'PAUSED':'PLAYING',
        readyState:Number(video.readyState)||0,
        networkState:Number(video.networkState)||0,
        loadedFraction:null,
        videoId:'',
        currentSrc:video.currentSrc||video.src||''
      };
    }
    try{
      const player=typeof ytPlayer!=='undefined'?ytPlayer:null;
      const ready=typeof ytPlayerReady!=='undefined'&&!!ytPlayerReady;
      const state=ready&&player?Number(player.getPlayerState?.()):-1;
      const names={[-1]:'UNSTARTED',0:'ENDED',1:'PLAYING',2:'PAUSED',3:'BUFFERING',5:'CUED'};
      const iframe=player?.getIframe?.()||document.querySelector('#player iframe');
      return {
        mode:iframe?'youtube-embed':null,
        ready:!!(ready&&player&&iframe),
        currentTime:Number(player?.getCurrentTime?.())||0,
        duration:Number(player?.getDuration?.())||0,
        paused:state!==1,
        ended:state===0,
        state,
        stateName:names[state]||String(state),
        readyState:null,
        networkState:null,
        loadedFraction:Number(player?.getVideoLoadedFraction?.())||0,
        videoId:String(player?.getVideoData?.()?.video_id||''),
        currentSrc:String(iframe?.src||'')
      };
    }catch(error){
      return {mode:null,ready:false,currentTime:0,duration:0,paused:true,ended:false,state:null,stateName:'ERROR',error:String(error)};
    }
  });
}

async function waitForPlayable(frame, timeoutMs, log) {
  const started=Date.now();
  let lastLog=0;
  let snapshot=null;
  while(Date.now()-started<timeoutMs){
    snapshot=await playbackSnapshot(frame);
    if(snapshot.ready)return snapshot;
    const elapsed=Date.now()-started;
    if(elapsed-lastLog>=10000){
      lastLog=elapsed;
      log(`waiting for player… ${Math.round(elapsed/1000)}s mode=${snapshot.mode||'none'} state=${snapshot.stateName||'n/a'}`);
    }
    await sleep(500);
  }
  return snapshot||await playbackSnapshot(frame);
}

async function outerLayoutSnapshot(page) {
  return page.evaluate(() => {
    const snap=element=>{
      if(!element)return null;
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom,
        display:style.display,position:style.position,overflow:style.overflow,
        overflowX:style.overflowX,overflowY:style.overflowY};
    };
    const root=document.documentElement,body=document.body;
    return {
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
      root:{clientWidth:root.clientWidth,clientHeight:root.clientHeight,scrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight},
      body:body?{clientWidth:body.clientWidth,clientHeight:body.clientHeight,scrollWidth:body.scrollWidth,scrollHeight:body.scrollHeight}:null,
      overlay:snap(document.querySelector('#watchfusion-overlay')),
      frame:snap(document.querySelector('#watchfusion-overlay .watchfusion-frame'))
    };
  });
}

async function innerLayoutSnapshot(frame) {
  return frame.evaluate(() => {
    const snap=element=>{
      if(!element)return null;
      const rect=element.getBoundingClientRect(),style=getComputedStyle(element);
      return {x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom,
        display:style.display,position:style.position,overflow:style.overflow,
        overflowX:style.overflowX,overflowY:style.overflowY};
    };
    const root=document.documentElement,body=document.body;
    const video=document.querySelector('#mediaVideo');
    let youtubeIframe=null;
    try{
      youtubeIframe=(typeof ytPlayer!=='undefined'&&ytPlayer?.getIframe?.())||document.querySelector('#player iframe');
    }catch{youtubeIframe=document.querySelector('#player iframe');}
    const oversized=[...document.querySelectorAll('body *')].map(element=>{
      const rect=element.getBoundingClientRect();
      if(!rect.width||!rect.height)return null;
      if(rect.right<=innerWidth+2&&rect.bottom<=innerHeight+2&&rect.width<=innerWidth+2&&rect.height<=innerHeight+2)return null;
      return {tag:element.tagName,id:element.id||'',className:typeof element.className==='string'?element.className.slice(0,120):'',
        x:rect.x,y:rect.y,width:rect.width,height:rect.height,right:rect.right,bottom:rect.bottom};
    }).filter(Boolean).slice(0,16);
    return {
      viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio},
      root:{clientWidth:root.clientWidth,clientHeight:root.clientHeight,scrollWidth:root.scrollWidth,scrollHeight:root.scrollHeight},
      body:body?{clientWidth:body.clientWidth,clientHeight:body.clientHeight,scrollWidth:body.scrollWidth,scrollHeight:body.scrollHeight}:null,
      mediaStage:snap(document.querySelector('#mediaStage')),
      playerHost:snap(document.querySelector('#playerHost')||document.querySelector('.player.panel')),
      player:snap(document.querySelector('#player')),
      youtubeIframe:snap(youtubeIframe),
      directVideo:snap(video),
      findMediaPanel:snap(document.querySelector('#findMediaPanel')),
      playbackMode:snap(document.querySelector('#youtubePlaybackMode')),
      oversized
    };
  });
}

async function installDiagnostics(page, frame) {
  await page.evaluate(() => {
    const diag={raf:[],last:0,longTasks:[]};window.__wfOuterPresentDiag=diag;
    const tick=now=>{if(diag.last)diag.raf.push(now-diag.last);diag.last=now;diag.rafId=requestAnimationFrame(tick);};
    diag.rafId=requestAnimationFrame(tick);
    try{diag.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())diag.longTasks.push({start:entry.startTime,duration:entry.duration});});
      diag.observer.observe({type:'longtask',buffered:true});}catch{}
  });
  await frame.evaluate(() => {
    const diag={raf:[],lastRaf:0,frames:[],lastFrame:0,events:[],samples:[],longTasks:[],lastYoutubeState:null};
    window.__wfInnerPresentDiag=diag;
    const raf=now=>{if(diag.lastRaf)diag.raf.push(now-diag.lastRaf);diag.lastRaf=now;diag.rafId=requestAnimationFrame(raf);};
    diag.rafId=requestAnimationFrame(raf);
    const video=document.querySelector('#mediaVideo');
    if(video){
      for(const name of ['loadedmetadata','durationchange','waiting','stalled','playing','canplay','seeking','seeked','ended','error']){
        video.addEventListener(name,()=>diag.events.push({name,at:performance.now(),time:Number(video.currentTime)||0}),{passive:true});
      }
      if(typeof video.requestVideoFrameCallback==='function'){
        const frameTick=now=>{if(diag.lastFrame)diag.frames.push(now-diag.lastFrame);diag.lastFrame=now;video.requestVideoFrameCallback(frameTick);};
        video.requestVideoFrameCallback(frameTick);
      }
      video.play?.().catch(()=>{});
    }else{
      try{if(typeof ytPlayer!=='undefined'&&ytPlayerReady)ytPlayer.playVideo?.();}catch{}
    }
    try{diag.observer=new PerformanceObserver(list=>{for(const entry of list.getEntries())diag.longTasks.push({start:entry.startTime,duration:entry.duration});});
      diag.observer.observe({type:'longtask',buffered:true});}catch{}
    diag.timer=setInterval(()=>{
      const direct=document.querySelector('#mediaVideo');
      if(direct){
        const snap=window.watchFusionMediaDiagnostics?.snapshot?.()||{};
        diag.samples.push({at:performance.now(),mode:'direct',...snap,ended:!!direct.ended,stateName:direct.ended?'ENDED':direct.paused?'PAUSED':'PLAYING'});
        return;
      }
      try{
        const player=typeof ytPlayer!=='undefined'?ytPlayer:null;
        const ready=typeof ytPlayerReady!=='undefined'&&!!ytPlayerReady;
        const state=ready&&player?Number(player.getPlayerState?.()):-1;
        const names={[-1]:'UNSTARTED',0:'ENDED',1:'PLAYING',2:'PAUSED',3:'BUFFERING',5:'CUED'};
        const snap={at:performance.now(),mode:'youtube-embed',currentTime:Number(player?.getCurrentTime?.())||0,
          duration:Number(player?.getDuration?.())||0,paused:state!==1,ended:state===0,state,stateName:names[state]||String(state),
          loadedFraction:Number(player?.getVideoLoadedFraction?.())||0,videoId:String(player?.getVideoData?.()?.video_id||'')};
        diag.samples.push(snap);
        if(diag.lastYoutubeState!==null&&diag.lastYoutubeState!==state){
          diag.events.push({name:`youtube-state-${names[state]||state}`,at:performance.now(),time:snap.currentTime,state});
        }
        if(diag.lastYoutubeState!==0&&state===0)diag.events.push({name:'ended',at:performance.now(),time:snap.currentTime,state});
        diag.lastYoutubeState=state;
      }catch(error){diag.samples.push({at:performance.now(),mode:'youtube-embed',error:String(error)});}
    },250);
  });
}

async function collectDiagnostics(page, frame) {
  const outer=await page.evaluate(() => {
    const diag=window.__wfOuterPresentDiag||{raf:[],longTasks:[]};
    if(diag.rafId)cancelAnimationFrame(diag.rafId);diag.observer?.disconnect?.();
    return {raf:diag.raf,longTasks:diag.longTasks};
  });
  const inner=await frame.evaluate(() => {
    const diag=window.__wfInnerPresentDiag||{raf:[],frames:[],events:[],samples:[],longTasks:[]};
    if(diag.timer)clearInterval(diag.timer);if(diag.rafId)cancelAnimationFrame(diag.rafId);diag.observer?.disconnect?.();
    const first=diag.samples[0]||{},last=diag.samples.at(-1)||{};
    return {raf:diag.raf,frames:diag.frames,events:diag.events,longTasks:diag.longTasks,samples:diag.samples,
      elapsedPlaybackSec:Math.max(0,(Number(last.currentTime)||0)-(Number(first.currentTime)||0)),start:first,end:last};
  });
  return {outer,inner};
}

function analyzeSamples(samples) {
  let activePairs=0,stalledPairs=0,bufferingSamples=0;
  for(let i=1;i<samples.length;i+=1){
    const a=samples[i-1],b=samples[i];
    if(a.stateName==='BUFFERING')bufferingSamples+=1;
    const active=a.mode==='direct'?!a.paused&&Number(a.readyState)>=2:a.state===1;
    if(!active)continue;
    activePairs+=1;
    if((Number(b.currentTime)||0)-(Number(a.currentTime)||0)<0.05)stalledPairs+=1;
  }
  return {activePairs,stalledPairs,stalledRatio:activePairs?stalledPairs/activePairs:0,bufferingSamples};
}

module.exports={
  sleep,formatTime,summarizeIntervals,playbackSnapshot,waitForPlayable,
  outerLayoutSnapshot,innerLayoutSnapshot,installDiagnostics,collectDiagnostics,analyzeSamples
};
