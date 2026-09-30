/* Runs in every accessible frame of the explicitly selected tab. State/control only: never restyle the source page. */
(() => {
  if (window.__watchFusionMediaProbe) return;
  window.__watchFusionMediaProbe = true;
  let enabled = true, pageMedia = null, sampleTimer = null;
  const frameToken = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`, children = new Map();
  const PAGE_CHANNEL = 'eveos.watchfusion.page-media.v1';

  function onWindowMessage(event) {
    if (event.source === window && event.data?.channel === PAGE_CHANNEL && event.data.type === 'state') {
      pageMedia = { ...event.data, at:Date.now() };
      return;
    }
    if (event.data?.type !== 'watchfusion:media-frame' || typeof event.data.token !== 'string') return;
    const frame = [...document.querySelectorAll('iframe')].find(value => value.contentWindow === event.source);
    if (frame) children.set(frame, { ...event.data, at:Date.now() });
  }
  function onDocumentLoad(event) {
    if (enabled && event.target?.tagName === 'IFRAME') chrome.runtime.sendMessage({ to:'worker', type:'refresh-probes' }).catch(() => {});
  }
  function visible(element) {
    const rect = element?.getBoundingClientRect?.(), style = element ? getComputedStyle(element) : null;
    return rect && rect.width > 24 && rect.height > 24 && style?.visibility !== 'hidden'
      && style?.display !== 'none' && Number(style?.opacity || 1) > 0;
  }
  function media() {
    return [...document.querySelectorAll('video,audio')]
      .filter(element => element.readyState > 0)
      .sort((a,b) => Number(a.paused) - Number(b.paused)
        || (b.clientWidth*b.clientHeight) - (a.clientWidth*a.clientHeight))[0] || null;
  }
  function pagePlayer() {
    if (!pageMedia?.hasMedia || Date.now() - pageMedia.at > 1800) return null;
    return [...document.querySelectorAll('strmcx-embed')].find(visible) || null;
  }
  function frameFallback() {
    return [...children].filter(([frame,sample]) => frame.isConnected && visible(frame)
      && sample.hasMedia && Date.now() - sample.at < 1800)
      .sort((a,b) => b[1].score - a[1].score)[0]?.[0] || null;
  }
  function normalizedRect(element) {
    if (!visible(element)) return null;
    const rect = element.getBoundingClientRect();
    const x=Math.max(0,rect.left), y=Math.max(0,rect.top);
    const right=Math.min(innerWidth,rect.right), bottom=Math.min(innerHeight,rect.bottom);
    if (right<=x || bottom<=y) return null;
    return { x:x/innerWidth, y:y/innerHeight, width:(right-x)/innerWidth, height:(bottom-y)/innerHeight };
  }
  function cleanup() {
    if (!window.__watchFusionMediaProbe) return;
    enabled=false; children.clear(); pageMedia=null; clearInterval(sampleTimer); sampleTimer=null;
    window.removeEventListener('message',onWindowMessage);
    document.removeEventListener('load',onDocumentLoad,true);
    chrome.runtime.onMessage.removeListener(onRuntimeMessage);
    window.postMessage({ channel:PAGE_CHANNEL, type:'dispose' }, '*');
    try { delete window.__watchFusionMediaProbeCleanup; } catch { window.__watchFusionMediaProbeCleanup=null; }
    try { delete window.__watchFusionMediaProbe; } catch { window.__watchFusionMediaProbe=false; }
  }
  window.__watchFusionMediaProbeCleanup=cleanup;

  function clickTransport(action) {
    const selectors=action==='next'
      ? ['.ytp-next-button','[aria-label*="Next" i]','[title*="Next" i]','[data-testid*="next" i]','[data-action*="next" i]']
      : ['.ytp-prev-button','[aria-label*="Previous" i]','[aria-label*="Back" i]','[title*="Previous" i]','[data-testid*="prev" i]','[data-action*="prev" i]'];
    const button=selectors.flatMap(selector=>[...document.querySelectorAll(selector)]).find(visible);
    if(!button)return false; button.click(); return true;
  }

  function snapshot() {
    if(!enabled)return;
    const element=media(), controller=element?null:pagePlayer(), fallback=element||controller?null:frameFallback();
    const visual=element?.tagName==='VIDEO'?element:controller||fallback;
    const rect=normalizedRect(visual), area=rect?rect.width*rect.height:0;
    const score=(element&&!element.paused?2:0)+area;
    if(window!==top)parent.postMessage({type:'watchfusion:media-frame',token:frameToken,
      hasMedia:Boolean(element||fallback),score:fallback?children.get(fallback).score:score},'*');
    chrome.runtime.sendMessage({
      to:'worker',type:'sample',rect,token:frameToken,topFrame:window===top,
      children:[...children].filter(([frame,child])=>frame.isConnected&&child.hasMedia&&Date.now()-child.at<1800)
        .map(([frame,child])=>({token:child.token,rect:normalizedRect(frame)})),
      hasMedia:Boolean(element||controller),score:controller?score+1:score,
      metadata:{
        pageUrl:location.href,
        title:pageMedia?.title||navigator.mediaSession?.metadata?.title||document.title,
        paused:element?element.paused:pageMedia?.paused!==false,
        currentTime:element?.currentTime||pageMedia?.currentTime||0,
        duration:Number.isFinite(element?.duration)?element.duration:pageMedia?.duration||0,
        rate:element?.playbackRate||pageMedia?.rate||1,
        volume:element?(element.muted?0:element.volume??1):pageMedia?.volume??1,
        status:element||controller?'':'Waiting for a playable video · enable Setup & embedded players access for embedded video.'
      }
    }).catch(()=>{});
  }

  function onRuntimeMessage(message) {
    if(message.type==='probe-stop'){cleanup();return;}
    if(message.type==='probe-start'){enabled=true;snapshot();return;}
    if(message.type!=='source-control'||!enabled)return;
    const element=media(),controller=element?null:pagePlayer(),value=Number(message.value)||0;
    if(controller){window.postMessage({channel:PAGE_CHANNEL,type:'control',action:message.action,value},'*');snapshot();return;}
    if(message.action==='next'||message.action==='prev'){clickTransport(message.action);snapshot();return;}
    if(!element)return;
    if(message.action==='toggle'){if(element.paused)element.play().catch(()=>{});else element.pause();}
    if(message.action==='play')element.play().catch(()=>{});
    if(message.action==='pause')element.pause();
    if(message.action==='seek')element.currentTime=Math.max(0,Math.min(value,Number.isFinite(element.duration)?element.duration:value));
    if(message.action==='rate')element.playbackRate=Math.max(.25,Math.min(4,value));
    if(message.action==='volume'){element.volume=Math.max(0,Math.min(1,value));element.muted=value===0;}
    snapshot();
  }

  window.addEventListener('message',onWindowMessage);
  document.addEventListener('load',onDocumentLoad,true);
  chrome.runtime.onMessage.addListener(onRuntimeMessage);
  sampleTimer=setInterval(snapshot,250);
  snapshot();
})();
