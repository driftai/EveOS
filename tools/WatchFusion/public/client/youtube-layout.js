(() => {
  let host = null, resizeObserver = null, mutationObserver = null, toolbarObserver = null;
  let fullButton = null, exitButton = null, fallbackRow = null, fadeTimer = null, lease = null, serial = 0;
  const screenStyle = {position:'fixed', top:'0', right:'0', bottom:'0', left:'0', width:'100vw', height:'100vh',
    'min-width':'0', 'min-height':'0', 'aspect-ratio':'auto', 'max-width':'none', 'max-height':'none',
    'margin-top':'0','margin-right':'0','margin-bottom':'0','margin-left':'0', 'padding-top':'0','padding-right':'0','padding-bottom':'0','padding-left':'0', 'z-index':'2147483647', 'background-color':'#000', 'border-radius':'0',
    display:'block', overflow:'hidden', 'box-sizing':'border-box'};
  const frameStyle = {position:'absolute', top:'50%', left:'50%', right:'auto', bottom:'auto',
    transform:'translate(-50%, -50%)', margin:'0', display:'block', 'z-index':'1'};
  const ancestorStyle = {'overflow-x':'visible', 'overflow-y':'visible',
    transform:'none', filter:'none', 'backdrop-filter':'none', perspective:'none', contain:'none',
    'content-visibility':'visible', 'will-change':'auto', 'clip-path':'none', 'z-index':'auto'};
  function apply(element, values) {
    const old = Object.keys(values).map(key => [key,element.style.getPropertyValue(key),element.style.getPropertyPriority(key)]);
    for(const [key,value] of Object.entries(values))element.style.setProperty(key,value,'important');
    return () => {for(const [key,value,priority] of old){if(value)element.style.setProperty(key,value,priority);else element.style.removeProperty(key);}};
  }
  function note(action, mode) {window.watchFusionRoomSyncLog?.note?.('ui-intent',{action,hidden:document.hidden===true,mode});}
  function youtubeFrame(target=host){return target?.querySelector('iframe#player')||null;}
  function placeButton(){
    if(!fullButton||!host)return;
    const stop=document.getElementById('liveStop'), controls=document.getElementById('liveControls');
    if(stop?.parentElement && controls && !controls.hidden){if(stop.nextElementSibling!==fullButton||fullButton.parentElement!==stop.parentElement)stop.after(fullButton);}
    else if(controls?.parentElement && fallbackRow){if(fullButton.parentElement!==fallbackRow)fallbackRow.appendChild(fullButton);}
    if(fallbackRow)fallbackRow.style.setProperty('display',fullButton.parentElement===fallbackRow&&!lease?'flex':'none','important');
    fullButton.hidden=!!lease;
    if(lease)fullButton.style.setProperty('display','none','important');else fullButton.style.removeProperty('display');
  }
  function fadeExit(){
    clearTimeout(fadeTimer);fadeTimer=null;if(!lease||!exitButton)return;
    fadeTimer=setTimeout(()=>{if(lease&&exitButton&&!exitButton.matches?.(':hover, :focus-visible'))exitButton.style.setProperty('opacity','0');},1800);
  }
  function revealExit(){if(!lease||!exitButton)return;exitButton.style.setProperty('opacity','1');fadeExit();
  }
  function clearFrameSize(frame){if(!frame)return;for(const k of ['width','height','max-width','max-height'])frame.style.removeProperty(k);}
  function fit(){
    if(!host?.isConnected)return;
    placeButton();const frame=youtubeFrame();
    if(lease&&lease.frame!==frame){lease.restoreFrame?.();lease.frame=frame;lease.restoreFrame=frame?apply(frame,frameStyle):null;}
    if(!frame)return;
    const maxWidth=host.clientWidth,maxHeight=host.clientHeight;if(maxWidth<2||maxHeight<2)return;
    const width=Math.min(maxWidth,maxHeight*16/9),height=width*9/16;
    if(lease&&exitButton){
      // Reserve the provider's top controls when the video fills the viewport.
      const padding=(maxHeight-height)/2;
      const top=padding>=48?8:Math.max(8,Math.min(maxHeight-48,padding+Math.max(64,Math.min(104,height*.10))));
      exitButton.style.setProperty('top',`${Math.round(top)}px`);
    }
    frame.style.width=`${Math.max(2,Math.floor(width))}px`;frame.style.height=`${Math.max(2,Math.floor(height))}px`;
    frame.style.maxWidth='100%';frame.style.maxHeight='100%';
  }
  function redraw(){fit();requestAnimationFrame(fit);}
  function clearLease(exitNative=true){
    if(!lease)return;const prev=lease;lease=null;serial++;
    prev.restoreFrame?.();prev.restoreHost();for(const restore of prev.restoreAncestors.reverse())restore();
    for(const [node,x,y] of prev.scroll){node.scrollLeft=x;node.scrollTop=y;}
    clearTimeout(fadeTimer);fadeTimer=null;exitButton.hidden=true;exitButton.style.setProperty('display','none','important');fullButton.setAttribute('aria-pressed','false');placeButton();
    if(exitNative&&document.fullscreenElement===prev.host)try{Promise.resolve(document.exitFullscreen?.()).catch(()=>{});}catch{}
    note('room-fullscreen-exit',prev.mode);redraw();
  }
  function enter(){
    if(lease||!host?.isConnected)return;
    // A viewport lease does not move or recreate the iframe. Neutralize clipping
    // and fixed containing blocks in the actual embedded ancestor chain.
    const target=host, restoreAncestors=[], scroll=[];
    for(let node=target.parentElement;node;node=node.parentElement){scroll.push([node,node.scrollLeft,node.scrollTop]);restoreAncestors.push(apply(node,ancestorStyle));}
    const token=++serial;lease={host:target,restoreHost:apply(target,screenStyle),restoreAncestors,scroll,frame:null,restoreFrame:null,mode:'viewport'};
    exitButton.hidden=false;exitButton.style.setProperty('display','block','important');fullButton.setAttribute('aria-pressed','true');placeButton();revealExit();
    note('room-fullscreen-enter','viewport');redraw();
    // The container (not the video) may use the browser's top layer. If a parent
    // iframe denies permission or the TV lacks the API, retain viewport mode.
    if(document.fullscreenEnabled&&typeof target.requestFullscreen==='function'&&!document.fullscreenElement){
      try{Promise.resolve(target.requestFullscreen()).then(()=>{
        if(token!==serial||lease?.host!==target){if(lease?.host!==target&&document.fullscreenElement===target)Promise.resolve(document.exitFullscreen?.()).catch(()=>{});return;}
        if(document.fullscreenElement===target){lease.mode='native-container';redraw();}
      }).catch(()=>{});}catch{}
    }
  }
  function onFullscreenChange(){
    if(!lease)return;
    const element=document.fullscreenElement;
    if(element===lease.host){lease.mode='native-container';redraw();}
    else if(!element&&lease.mode==='native-container')clearLease(false);
  }
  function escapeScreen(event){if(event.key==='Escape'&&lease){event.preventDefault();clearLease();}}
  function attachButtons(){
    if(fullButton)return;
    fullButton=document.createElement('button');fullButton.type='button';fullButton.id='watchFusionRoomFullscreen';fullButton.className='secondary';fullButton.textContent='Room fullscreen';fullButton.setAttribute('aria-pressed','false');
    fullButton.addEventListener('click',()=>lease?clearLease():enter());
    const controls=document.getElementById('liveControls');
    if(controls?.parentElement){fallbackRow=document.createElement('div');fallbackRow.id='watchFusionRoomFullscreenToolbar';fallbackRow.style.cssText='display:none;flex:0 0 auto;justify-content:flex-end;padding:4px 8px;box-sizing:border-box;';controls.before(fallbackRow);}
    placeButton();
    exitButton=document.createElement('button');exitButton.type='button';exitButton.id='watchFusionRoomFullscreenExit';exitButton.textContent='Exit fullscreen';exitButton.hidden=true;
    exitButton.style.cssText='position:absolute;top:8px;right:8px;z-index:20;padding:8px 12px;background:#181818e8;color:white;border:1px solid #888;border-radius:6px;font:inherit;cursor:pointer;transition:opacity .18s ease;';
    exitButton.style.setProperty('display','none','important');exitButton.addEventListener('click',()=>clearLease());host.appendChild(exitButton);
    for(const k of ['pointerenter','focus','pointermove'])exitButton.addEventListener(k,revealExit);
    for(const k of ['pointerleave','blur'])exitButton.addEventListener(k,fadeExit);
    host.addEventListener?.('pointermove',revealExit);document.addEventListener('keyup',revealExit);
    document.addEventListener('keydown',escapeScreen);document.addEventListener('fullscreenchange',onFullscreenChange);
    if(controls&&typeof MutationObserver==='function'){toolbarObserver=new MutationObserver(placeButton);toolbarObserver.observe(controls,{attributes:true,attributeFilter:['hidden','class']});}
  }
  function deactivate(){
    if(!host)return;const previous=host;clearLease();fullButton?.remove();exitButton?.remove();fallbackRow?.remove();fullButton=exitButton=fallbackRow=null;clearTimeout(fadeTimer);fadeTimer=null;previous.removeEventListener?.('pointermove',revealExit);document.removeEventListener('keyup',revealExit);
    document.removeEventListener('keydown',escapeScreen);document.removeEventListener('fullscreenchange',onFullscreenChange);
    resizeObserver?.disconnect();mutationObserver?.disconnect();toolbarObserver?.disconnect();resizeObserver=mutationObserver=toolbarObserver=null;
    host=null;previous.classList.remove('youtube-active');clearFrameSize(youtubeFrame(previous));
  }
  function activate(target=document.getElementById('playerHost')){
    if(!target)return;if(host!==target){deactivate();host=target;}
    host.classList.add('youtube-active');attachButtons();
    if(!resizeObserver&&typeof ResizeObserver==='function'){resizeObserver=new ResizeObserver(fit);resizeObserver.observe(host);}
    if(!mutationObserver&&typeof MutationObserver==='function'){mutationObserver=new MutationObserver(fit);mutationObserver.observe(host,{childList:true,subtree:true});}
    requestAnimationFrame(fit);setTimeout(fit,0);
  }
  window.watchFusionYoutubeLayout=Object.freeze({activate,deactivate,refresh:fit,fullscreenActive:()=>!!lease});
})();
