function initNuvioProvider() {
  if (typeof window === 'undefined' || !window.watchPartyProviders) return;

  const frame = () => document.getElementById('nuvioFrame');
  const setToolbarVisible = visible => { const toolbar = document.getElementById('nuvioToolbar'); if (toolbar) toolbar.hidden = !visible; };
  const setNuvioVisible = visible => { const target = frame(); if (!target) return; target.hidden = !visible; target.style.display = visible ? 'block' : 'none'; setToolbarVisible(visible); };
  const setPlayerNuvioClass = visible => document.getElementById('playerHost')?.classList.toggle('nuvio-active', visible);

  function setActiveSourceTab(kind) {
    const isNuvio = kind === 'nuvio';
    const activeId = isNuvio ? 'shortcutNuvioBtn' : 'resolveTabBtn';
    document.querySelectorAll('.source-tab').forEach(tab => tab.classList.toggle('active', tab.id === activeId));
    const label = document.getElementById('sourceModeLabel');
    if (label) label.textContent = isNuvio ? 'Nuvio' : (kind === 'youtube' ? 'YouTube' : (kind === 'media' ? 'External media' : 'Ready'));
  }

  function triggerAppBack() {
    try {
      const win = frame()?.contentWindow;
      const doc = frame()?.contentDocument;
      if (win?.NuvioRouter && typeof win.NuvioRouter.back === 'function') return win.NuvioRouter.back();
      const event = new KeyboardEvent('keydown', { key:'Escape', code:'Escape', keyCode:27, which:27, bubbles:true, cancelable:true });
      doc?.dispatchEvent(event); doc?.body?.dispatchEvent(event);
    } catch {}
  }
  function triggerAppHome() {
    try { const win = frame()?.contentWindow; if (win?.NuvioRouter && typeof win.NuvioRouter.navigate === 'function') win.NuvioRouter.navigate('home'); } catch {}
  }
  function closeNuvioView() {
    const target = frame();
    setNuvioVisible(false);
    setPlayerNuvioClass(false);
    window.mediaPlayback?.clear?.();
    window.watchFusionNuvioViewport?.reset?.();
    if (target) { try { target.src = 'about:blank'; target.dataset.watchFusionNuvioReady = '0'; } catch {} }
    if (typeof roomId !== 'undefined' && roomId) {
      setActiveSourceTab('');
      setStatus('Nuvio view closed. The shared room source remains Nuvio until the host changes it.');
    } else {
      applySoloSource({ kind:'ready', type:'ready', title:'Ready' });
      setStatus('Nuvio closed · choose Nuvio or Find Media');
    }
  }

  function installBrowserCompatibility() {
    const target = frame(); if (!target) return;
    try {
      const doc = target.contentDocument; if (!doc || !doc.documentElement) return;
      let style = doc.getElementById('__watchfusion_nuvio_compat');
      if (!style) {
        style = doc.createElement('style');
        style.id='__watchfusion_nuvio_compat';
        doc.head.appendChild(style);
      }
      if (style.dataset.watchfusionCompatVersion !== '2') {
        style.dataset.watchfusionCompatVersion='2';
        style.textContent=`
          .detail-trailer-controls-overlay,.detail-trailer-controls-gradient,.detail-trailer-controls-gradient-top,.detail-trailer-controls-gradient-bottom,.detail-trailer-controls-top,.detail-trailer-controls-bottom{display:none!important;visibility:hidden!important;opacity:0!important;pointer-events:none!important;outline:none!important;box-shadow:none!important;border:0!important}
          .series-detail-content{position:relative!important;z-index:10!important;pointer-events:auto!important}.series-detail-actions,.series-primary-btn,.series-circle-btn,.series-season-btn,.series-episode-card,.detail-morelike-card,.series-cast-card,.series-insight-tab,.focusable,button,a,[data-action]{cursor:pointer!important;pointer-events:auto!important}.detail-trailer-layer,.detail-trailer-media,.detail-trailer-youtube,.detail-trailer-frame,.detail-trailer-video{pointer-events:none!important;z-index:0!important}.detail-trailer-active.detail-trailer-manual .detail-trailer-layer,.detail-trailer-active.detail-trailer-manual .detail-trailer-media,.detail-trailer-active.detail-trailer-manual .detail-trailer-frame,.detail-trailer-active.detail-trailer-manual .detail-trailer-video{pointer-events:auto!important;z-index:30!important}.detail-trailer-layer .focused,.detail-trailer-layer :focus,.detail-trailer-layer :focus-visible{outline:none!important;box-shadow:none!important;border-color:transparent!important}.detail-trailer-manual .series-detail-content{pointer-events:none!important}
          .watchfusion-nuvio #playerUiRoot{--watchfusion-player-dialog-bottom:var(--player-action-controls-open-bottom,clamp(238px,31vh,360px));--watchfusion-player-dialog-top-gap:min(4.58vw,88px)}
          .watchfusion-nuvio #playerSubtitleDialog{bottom:var(--watchfusion-player-dialog-bottom)!important;height:min(75vh,calc(100vh - var(--watchfusion-player-dialog-bottom) - var(--watchfusion-player-dialog-top-gap)))!important;max-height:calc(100vh - var(--watchfusion-player-dialog-bottom) - var(--watchfusion-player-dialog-top-gap))!important}
          .watchfusion-nuvio #playerAudioDialog{bottom:var(--watchfusion-player-dialog-bottom)!important;height:min(72vh,calc(100vh - var(--watchfusion-player-dialog-bottom) - var(--watchfusion-player-dialog-top-gap)))!important;max-height:calc(100vh - var(--watchfusion-player-dialog-bottom) - var(--watchfusion-player-dialog-top-gap))!important}
          .watchfusion-nuvio #playerSpeedDialog{bottom:var(--watchfusion-player-dialog-bottom)!important;max-height:calc(100vh - var(--watchfusion-player-dialog-bottom) - var(--watchfusion-player-dialog-top-gap))!important}
          .watchfusion-nuvio #playerSourcesPanel{bottom:var(--watchfusion-player-dialog-bottom)!important;height:auto!important;max-height:calc(100vh - var(--watchfusion-player-dialog-bottom))!important}
          .watchfusion-nuvio #playerModalBackdrop{bottom:var(--watchfusion-player-dialog-bottom)!important}
          .watchfusion-nuvio #playerControlsOverlay.modal-blocked{pointer-events:auto!important}`;
      }
      doc.documentElement.classList.add('watchfusion-nuvio');
      doc.querySelectorAll('.detail-trailer-controls-overlay,.detail-trailer-controls-gradient,.detail-trailer-controls-top,.detail-trailer-controls-bottom').forEach(el=>{el.style.setProperty('display','none','important');el.style.setProperty('pointer-events','none','important');el.setAttribute('tabindex','-1');});
    } catch {}
  }

  function installExternalMouseBridge(){
    const target=frame(); if(!target)return false;
    try {
      const doc=target.contentDocument;
      const win=target.contentWindow;
      if(!doc || !doc.documentElement || !win)return false;
      if(win.watchFusionExternalNuvioMouse?.version===6){
        target.dataset.watchFusionMouseBridge='ready';
        return true;
      }
      const src=new URL('/client/nuvio-external-mouse-bridge.js',location.origin).href;
      const selector=`script[data-watchfusion-external-mouse="${src}"]`;
      const existing=doc.querySelector(selector);
      if(existing?.dataset.watchfusionState==='loading')return false;
      existing?.remove();
      const script=doc.createElement('script');
      script.src=src;
      script.async=false;
      script.dataset.watchfusionExternalMouse=src;
      script.dataset.watchfusionState='loading';
      script.onload=()=>{
        const ready=win.watchFusionExternalNuvioMouse?.version===6;
        script.dataset.watchfusionState=ready?'ready':'failed';
        target.dataset.watchFusionMouseBridge=ready?'ready':'failed';
        if(!ready)script.remove();
      };
      script.onerror=()=>{
        target.dataset.watchFusionMouseBridge='failed';
        script.remove();
      };
      (doc.head||doc.documentElement).appendChild(script);
      return false;
    } catch {
      target.dataset.watchFusionMouseBridge='failed';
      return false;
    }
  }

  function installBrowserClickBridge(){
    const target=frame(); if(!target)return;
    try { const doc=target.contentDocument; if(!doc)return; window.watchFusionNuvioNativeViewport?.installSidebarClickShield?.(doc); if(doc.__watchFusionClickBridge)return; const focusFrame=()=>{try{target.contentWindow?.focus();}catch{}}; doc.addEventListener('pointerdown',focusFrame,true); doc.addEventListener('mousedown',focusFrame,true); doc.__watchFusionClickBridge=true; } catch {}
  }
  function wireToolbar(){
    document.getElementById('nuvioBackBtn')?.addEventListener('click',triggerAppBack);
    document.getElementById('nuvioHomeBtn')?.addEventListener('click',triggerAppHome);
    document.getElementById('nuvioReloadBtn')?.addEventListener('click',()=>{const target=frame();if(!target)return;try{target.contentWindow?.location.reload();}catch{target.src=target.src;}});
    document.getElementById('nuvioFullBtn')?.addEventListener('click',()=>frame()?.requestFullscreen?.());
    document.getElementById('nuvioCloseBtn')?.addEventListener('click',closeNuvioView);
  }
  let compatibilityTimer=null;
  function loadFrame(source){
    const host=document.getElementById('playerHost'); if(!host)return; let target=frame();
    if(!target){target=document.createElement('iframe');target.id='nuvioFrame';target.className='nuvio-frame';target.title='Nuvio';target.allow='autoplay; encrypted-media; fullscreen; picture-in-picture; web-share';target.allowFullscreen=true;host.appendChild(target);}

    const entryPath=source.entryUrl||'/nuvio/dist/index.html';
    const absoluteEntry=new URL(entryPath,location.origin).href;
    const alreadyLoaded=target.dataset.watchFusionNuvioReady==='1' && target.src===absoluteEntry;

    try {
      if (typeof ytPlayer !== 'undefined' && ytPlayer) {
        ytPlayer.pauseVideo?.();
        const ytf = document.getElementById('player');
        if (ytf) { ytf.hidden = true; ytf.style.display = 'none'; }
      }
    } catch {}

    const voxelVisionFrame=document.getElementById('voxelVisionFrame');
    const voxelVisionToolbar=document.getElementById('voxelVisionToolbar');
    if(voxelVisionFrame){voxelVisionFrame.hidden=true;voxelVisionFrame.style.display='none';}
    if(voxelVisionToolbar)voxelVisionToolbar.hidden=true;
    host.classList.remove('voxelvision-active');

    if (!alreadyLoaded) window.mediaPlayback?.clear?.();
    target.removeAttribute('hidden');target.style.display='block';setPlayerNuvioClass(true);setToolbarVisible(true);setActiveSourceTab('nuvio');
    if (document.getElementById('findMediaPanel')) document.getElementById('findMediaPanel').hidden = true;
    window.watchFusionNuvioViewport?.attach?.(target);

    if (!alreadyLoaded) {
      target.dataset.watchFusionNuvioReady='0';
      target.onload=()=>{
        target.dataset.watchFusionNuvioReady='1';
        installBrowserCompatibility();
        installExternalMouseBridge();
        installBrowserClickBridge();
        window.watchFusionNuvioViewport?.attach?.(target);
        if(compatibilityTimer)clearInterval(compatibilityTimer);
        let count=0;
        compatibilityTimer=setInterval(()=>{installBrowserCompatibility();installExternalMouseBridge();window.watchFusionNuvioViewport?.attach?.(target);if(++count>40){clearInterval(compatibilityTimer);compatibilityTimer=null;}},250);
      };
      target.src=entryPath;
    } else {
      installBrowserCompatibility();
      installExternalMouseBridge();
      installBrowserClickBridge();
    }
  }
  registerProvider(); wireToolbar();
  function registerProvider(){window.watchPartyProviders.register({id:'nuvio',supports:source=>source&&(source.kind==='nuvio'||source.type==='nuvio'),load:async source=>{loadFrame(source);}});}
}
function openNuvioBrowserMode(){
  const source={kind:'nuvio',type:'nuvio',url:'nuvio://home',entryUrl:'/nuvio/dist/index.html',title:'Nuvio',originalUrl:'nuvio://home'};
  if(typeof roomId!=='undefined'&&roomId){if(typeof isHost==='function'&&!isHost())return alert('Only the host can switch the room to Nuvio.');fetch(apiUrl(`/api/rooms/${roomId}/media-source`),{method:'POST',headers:{'Content-Type':'application/json','x-member-id':session.memberId},body:JSON.stringify({media:source,originalUrl:source.originalUrl})}).then(async response=>{const data=await response.json().catch(()=>({}));if(!response.ok)throw new Error(data.error||'Could not open Nuvio.');state=data.state;sourceInputDirty=false;render();setStatus('Nuvio ready');}).catch(error=>setStatus(error.message||'Could not open Nuvio.'));return;}
  applySoloSource(source);setStatus('Nuvio ready · solo mode');
}
initNuvioProvider();
