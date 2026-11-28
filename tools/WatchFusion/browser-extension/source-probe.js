/* Runs in every accessible frame of the explicitly selected tab.
   Passive by default. Writes require an explicit WatchFusion control. */
(() => {
  if (window.__watchFusionMediaProbe) return;
  window.__watchFusionMediaProbe = true;
  let enabled = true, pageMedia = null, sampleTimer = null, runtimeListenerAttached = false, navigationAttempt=0, generation=null;
  const frameToken = crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`;
  const PAGE_CHANNEL = 'eveos.watchfusion.page-media.v1';
  const mediaEvents=['play','pause','playing','seeking','seeked','ratechange','volumechange','waiting','ended'];
  let observedElement=null, eventTimer=null;
  let silenceSourcePlayer = false;
  const priorMute = new Map();
  function silenceElement(element) {
    if (!priorMute.has(element) || !element.muted) priorMute.set(element, element.muted);
    if (!element.muted) element.muted = true;
  }
  function updatePlayerSilence() {
    if (!silenceSourcePlayer) return;
    for (const [element, muted] of priorMute) {
      if (element.isConnected === false) {
        element.muted = muted;
        priorMute.delete(element);
      }
    }
    for (const element of document.querySelectorAll('video,audio')) silenceElement(element);
  }
  function setPlayerSilence(enabled) {
    silenceSourcePlayer = enabled;
    if (enabled) {
      updatePlayerSilence();
      return;
    }
    for (const [element, muted] of priorMute) element.muted = muted;
    priorMute.clear();
  }
  function onSourceAudioChange(event) {
    if (silenceSourcePlayer && /^(AUDIO|VIDEO)$/.test(event.target?.tagName)) silenceElement(event.target);
  }
  function scheduleSnapshot(){
    if(!enabled)return;
    clearTimeout(eventTimer);eventTimer=setTimeout(()=>{eventTimer=null;snapshot();},25);
  }
  function onMediaEvent(event) {
    if (!enabled || event.target !== observedElement) return;
    scheduleSnapshot();
  }
  function observeMedia(element) {
    if (element===observedElement) return;
    if (observedElement) for (const type of mediaEvents) observedElement.removeEventListener(type,onMediaEvent);
    observedElement=element;
    if (element) for (const type of mediaEvents) element.addEventListener(type,onMediaEvent,{passive:true});
  }

  function isRuntimeInvalidated(error) {
    return /Extension context invalidated/i.test(String(error?.message || error || ''));
  }

  // A reloaded extension leaves this isolated world behind with a dead runtime.
  // Every runtime touch goes through here so a stale probe never throws.
  function runtimeApi() {
    try {
      const runtime = globalThis.chrome?.runtime;
      return runtime?.id ? runtime : null;
    } catch { return null; }
  }

  function sendRuntimeMessage(message) {
    if (!enabled) return;
    const runtime = runtimeApi();
    if (!runtime) { cleanup(); return; }
    try {
      const pending = runtime.sendMessage(message);
      if (pending && typeof pending.catch === 'function') {
        pending.catch(error => {
          if (isRuntimeInvalidated(error)) cleanup();
        });
      }
    } catch (error) {
      if (isRuntimeInvalidated(error)) { cleanup(); return; }
      throw error;
    }
  }

  function onWindowMessage(event) {
    if (event.source === window && event.data?.channel === PAGE_CHANNEL && event.data.type === 'state') {
      pageMedia = { ...event.data, at:Date.now() };
    }
  }

  let lastRefreshSnapshotAt=0;
  function onDocumentLoad(event) {
    if (enabled && event.target?.tagName === 'IFRAME') {
      // Re-witness a live top-level YouTube player before the worker decides whether reinjection is needed.
      if(window===top&&/^(?:(?:www|m)\.)?youtube\.com$/i.test(location.hostname)&&location.pathname==='/watch'&&Date.now()-lastRefreshSnapshotAt>=250&&media()?.readyState>=2){lastRefreshSnapshotAt=Date.now();snapshot();}
      sendRuntimeMessage({ to:'worker', type:'refresh-probes' });
    }
  }

  function media() {
    return [...document.querySelectorAll('video,audio')]
      .filter(element => element.readyState > 0)
      .sort((a,b) => Number(a.paused) - Number(b.paused)
        || Number(b.readyState) - Number(a.readyState)
        || (Number(b.videoWidth || 0) * Number(b.videoHeight || 0)) - (Number(a.videoWidth || 0) * Number(a.videoHeight || 0)))[0] || null;
  }

  function pagePlayer() {
    if (!pageMedia?.hasMedia || Date.now() - pageMedia.at > 2200) return null;
    // Custom-element prototype methods live in the page's main world and are not
    // reliably visible from this isolated extension world. The main-world adapter
    // already validates the transport API before publishing hasMedia.
    return document.querySelector('strmcx-embed');
  }

  function cleanup() {
    if (!window.__watchFusionMediaProbe) return;
    enabled = false; pageMedia = null;
    setPlayerSilence(false);
    clearInterval(sampleTimer); sampleTimer = null;
    if (eventTimer !== null) clearTimeout(eventTimer);
    eventTimer = null; observeMedia(null);
    window.removeEventListener('message', onWindowMessage);
    document.removeEventListener('load', onDocumentLoad, true);
    document.removeEventListener('play', onSourceAudioChange, true);
    document.removeEventListener('volumechange', onSourceAudioChange, true);
    document.removeEventListener('visibilitychange',scheduleSnapshot);
    window.removeEventListener('pageshow',scheduleSnapshot);
    const runtime = runtimeListenerAttached ? runtimeApi() : null;
    runtimeListenerAttached = false;
    if (runtime) {
      try { runtime.onMessage.removeListener(onRuntimeMessage); }
      catch (error) { if (!isRuntimeInvalidated(error)) throw error; }
    }
    window.postMessage({ channel:PAGE_CHANNEL, type:'dispose' }, '*');
    try { delete window.__watchFusionMediaProbeCleanup; } catch { window.__watchFusionMediaProbeCleanup = null; }
    try { delete window.__watchFusionMediaProbe; } catch { window.__watchFusionMediaProbe = false; }
  }
  window.__watchFusionMediaProbeCleanup = cleanup;

  function youtubeTransport(action) {
    const evidence=arguments[1]||{};
    let current; try { current = new URL(location.href); } catch { return null; }
    if (!/^(?:(?:www|m)\.)?youtube\.com$/i.test(current.hostname)) return null;
    let list = current.searchParams.get('list'); const video = current.searchParams.get('v');
    const usable = el => !!el && !el.disabled && !el.hidden && el.getAttribute?.('aria-disabled') !== 'true' && el.getClientRects?.().length > 0;
    const panels = [...document.querySelectorAll('ytd-playlist-panel-renderer')].filter(usable);
    if(!list&&video&&!panels.length&&document.querySelectorAll('ytd-playlist-panel-renderer, ytm-playlist-panel-renderer').length)return false;
    if (!list && video && panels.length) { const selected = panels.flatMap(p=>[...p.querySelectorAll('ytd-playlist-panel-video-renderer[selected]')]); const known = selected.map(row=>{try {const u=new URL(row.querySelector('a#wc-endpoint[href], a[href*="watch?"]')?.href,current.href);return u.searchParams.get('v')===video?u.searchParams.get('list'):null;}catch{return null;}}).filter(Boolean); if(known.length!==1)return false;list=known[0]; }
    if (list && video) {
      const matches = [];
      for (const panel of panels) {
        const rows = [...panel.querySelectorAll('ytd-playlist-panel-video-renderer')];
        const entries = rows.map(row => { const anchor = row.querySelector('a#wc-endpoint[href], a[href*="watch?"]'); try { const url = new URL(anchor?.href, current.href); return {row,anchor,url}; } catch { return {row}; } });
        const selected = entries.filter(e => e.row.hasAttribute('selected') && e.url?.searchParams.get('v') === video && e.url.searchParams.get('list') === list);
        if (selected.length !== 1) continue;
        const here = selected[0], next = entries[entries.indexOf(here) + (action === 'next' ? 1 : -1)];
        if (!next?.url || next.url.origin !== current.origin || next.url.pathname !== '/watch' || next.url.searchParams.get('list') !== list || !/^[A-Za-z0-9_-]{11}$/.test(next.url.searchParams.get('v') || '') || !usable(next.anchor)) continue;
        const index = Number(here.url.searchParams.get('index')), other = Number(next.url.searchParams.get('index'));
        if (index > 0 && other > 0 && other !== index + (action === 'next' ? 1 : -1)) continue;
        matches.push(next.anchor);
      }
      if (matches.length === 1) { evidence.reason="playlist-row"; const destination=new URL(matches[0].href,current.href);evidence.target=destination.searchParams.get("v");evidence.index=Number(destination.searchParams.get("index"))||0;evidence.destination=destination.href; matches[0].click(); return true; }
      if (matches.length > 1) return false;
      const button = media()?.closest?.('.html5-video-player')?.querySelector(action === 'next' ? '.ytp-next-button' : '.ytp-prev-button');
      try { const u=new URL(button?.href,current.href), index=Number(current.searchParams.get('index')); if(usable(button)&&index>0&&u.origin===current.origin&&u.pathname==='/watch'&&u.searchParams.get('list')===list&&Number(u.searchParams.get('index'))===index+(action==='next'?1:-1)&&/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v')||'')){evidence.reason="native-index";evidence.target=u.searchParams.get("v");evidence.index=Number(u.searchParams.get("index"))||0;evidence.destination=u.href;button.click();return true;} } catch {}
      return false;
    }
    const active = media()?.closest?.('.html5-video-player');
    const button = active?.querySelector(action === 'next' ? '.ytp-next-button' : '.ytp-prev-button');
    if (!usable(button)) return false;
    evidence.reason="native-player"; try { evidence.target=new URL(button.href,current.href).searchParams.get("v"); } catch {} button.click(); return true;
  }
  // Only navigate a known adjacent watch URL; a collapsed panel's DOM links
  // remain evidence even when the anchors cannot receive a visible click.
  function verifiedPlaylistDestination(action) {
    let current; try { current=new URL(location.href); } catch { return {reason:'invalid-page'}; }
    const video=current.searchParams.get('v'), list=current.searchParams.get('list'), index=Number(current.searchParams.get('index')), delta=action==='next'?1:-1;
    if(!video || !/^[A-Za-z0-9_-]{11}$/.test(video) || current.pathname!=='/watch')return {reason:'invalid-page'};
    const candidates=[];let matched=0,selectionMismatch=false;
    for(const panel of document.querySelectorAll('ytd-playlist-panel-renderer, ytm-playlist-panel-renderer')){
      const rows=[...panel.querySelectorAll('ytd-playlist-panel-video-renderer, ytm-playlist-panel-video-renderer')].map(row=>{
        const anchor=row.querySelector('a#wc-endpoint[href], a[href*="watch?"]');let url;try{if(anchor?.href)url=new URL(anchor.href,current.href);}catch{}
        return {selected:row.hasAttribute('selected')||row.getAttribute?.('aria-current')==='true',url};
      });
      const valid=u=>u&&u.origin===current.origin&&u.pathname==='/watch'&&/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v')||'')&&!!u.searchParams.get('list');
      const selected=rows.filter(x=>x.selected), here=rows.filter(x=>valid(x.url)&&x.url.searchParams.get('v')===video&&(!list||x.url.searchParams.get('list')===list)&&(!index||!Number(x.url.searchParams.get('index'))||Number(x.url.searchParams.get('index'))===index));
      // If a selection marker exists, it must agree with the current page.
      if(here.length!==1||selected.length>1||(selected.length===1&&selected[0]!==here[0])||(!list&&!selected.length)){if(here.length===1&&(selected.length>1||selected.length===1&&selected[0]!==here[0]))selectionMismatch=true;continue;}
      matched++;const from=here[0].url, next=rows[rows.indexOf(here[0])+delta]?.url;
      if(!valid(next)||next.searchParams.get('list')!==from.searchParams.get('list'))continue;
      const fromIndex=Number(from.searchParams.get('index'))||index,toIndex=Number(next.searchParams.get('index'));
      if(fromIndex>0&&toIndex>0&&toIndex!==fromIndex+delta)continue;
      // Do not accept a second copy of the same video without index evidence.
      if(next.searchParams.get('v')===video&&!(fromIndex>0&&toIndex===fromIndex+delta))continue;
      candidates.push(next);
    }
    if(matched>1||candidates.length>1)return {reason:'playlist-ambiguous'};
    if(selectionMismatch)return {reason:'playlist-selection-mismatch'};
    if(candidates.length===1)return {url:candidates[0],reason:'verified-playlist-link'};
    return {reason:matched?'playlist-adjacent-unavailable':list?'playlist-unverified':'native-unavailable'};
  }
  // Newer layouts may expose indexed links outside the legacy panel rows.
  // Only a same-origin /watch URL with the exact playlist and adjacent index is actionable.
  function indexedPlaylistDestination(action) {
    let current;try{current=new URL(location.href);}catch{return {reason:'invalid-page'};}
    const list=current.searchParams.get('list'),video=current.searchParams.get('v'),delta=action==='next'?1:-1;
    if(!list||!video||current.pathname!=='/watch')return {reason:'playlist-unverified'};
    const idx=u=>{const n=Number(u?.searchParams.get('index'));return Number.isSafeInteger(n)&&n>0&&n<=999999?n:0;};
    const valid=href=>{try{const u=new URL(href,current.href);return u.origin===current.origin&&u.pathname==='/watch'&&u.searchParams.get('list')===list&&/^[A-Za-z0-9_-]{11}$/.test(u.searchParams.get('v')||'')&&idx(u)?u:null;}catch{return null;}};
    const panels=[...document.querySelectorAll('ytd-playlist-panel-renderer, ytm-playlist-panel-renderer, ytd-playlist-panel-video-list-renderer, ytm-playlist-panel-video-list-renderer, ytd-playlist-video-list-renderer')];
    const urls=[];
    for(const panel of panels)for(const a of panel.querySelectorAll('a[href*="watch?"]')){const u=valid(a.href);if(u)urls.push(u);}
    const indices=new Set(urls.filter(u=>u.searchParams.get('v')===video).map(idx));
    const here=idx(current)|| (indices.size===1?[...indices][0]:0);
    if(!here)return {reason:indices.size>1?'playlist-current-ambiguous':'playlist-index-missing'};
    if(here+delta<1)return {reason:'playlist-boundary'};
    // If a current-index link exists, it must describe the current video; do not guess from stale panels.
    if(urls.some(u=>idx(u)===here&&u.searchParams.get('v')!==video))return {reason:'playlist-selection-mismatch'};
    const candidates=urls.filter(u=>idx(u)===here+delta);
    const button=media()?.closest?.('.html5-video-player')?.querySelector(action==='next'?'.ytp-next-button':'.ytp-prev-button');
    const native=valid(button?.href);if(native&&idx(native)===here+delta)candidates.push(native);
    const distinct=new Map(candidates.map(u=>[u.searchParams.get('v'),u]));
    if(distinct.size>1)return {reason:'playlist-index-conflict'};
    if(distinct.size===1)return {url:[...distinct.values()][0],reason:'verified-indexed-link'};
    return {reason:panels.length?'playlist-index-target-missing':'playlist-panel-missing'};
  }
  function clickTransport(action) {
    const evidence=arguments[1]||{},attempt=++navigationAttempt,origin=location.href;
    const youtube = youtubeTransport(action,evidence);
    if(youtube===true){
      // If a valid playlist click is swallowed, navigate to the SAME known
      // destination once; never repeat a relative Next/Previous command.
      if(evidence.destination)setTimeout(()=>{if(enabled&&attempt===navigationAttempt&&location.href===origin)location.assign(evidence.destination);},850);
      return true;
    }
    if(youtube===false){let found=verifiedPlaylistDestination(action);if(!found.url&&['playlist-unverified','playlist-adjacent-unavailable'].includes(found.reason))found=indexedPlaylistDestination(action);evidence.reason=found.reason;if(!found.url)return false;
      evidence.target=found.url.searchParams.get('v');evidence.index=Number(found.url.searchParams.get('index'))||0;
      // Reply before navigating away from this probe, and never navigate an old document.
      setTimeout(()=>{if(enabled&&attempt===navigationAttempt&&location.href===origin)location.assign(found.url.href);},40);return true;}

    const selectors = action === 'next'
      ? ['.ytp-next-button','[aria-label*="Next" i]','[title*="Next" i]','[data-testid*="next" i]','[data-action*="next" i]']
      : ['.ytp-prev-button','[aria-label*="Previous" i]','[aria-label*="Back" i]','[title*="Previous" i]','[data-testid*="prev" i]','[data-action*="prev" i]'];
    const button = selectors.flatMap(selector => [...document.querySelectorAll(selector)])
      .find(element => element && !element.disabled && !element.hidden);
    if (!button) {evidence.reason="native-unavailable";return false;}
    evidence.reason="native-player";button.click();
    return true;
  }

  function snapshot() {
    if (!enabled) return;
    updatePlayerSilence();
    const element = media();
    observeMedia(element);
    const controller = element ? null : pagePlayer();
    const hasMedia = Boolean(element || controller);
    const score = (element && !element.paused ? 4 : 0) + (element?.tagName === 'VIDEO' ? 2 : 0) + (controller ? 3 : 0);
    if (window !== top) parent.postMessage({ type:'watchfusion:media-frame', token:frameToken, hasMedia, score }, '*');
    sendRuntimeMessage({
      to:'worker', type:'sample', token:frameToken, generation, topFrame:window === top, hasMedia, score,
      metadata: {
        pageUrl:location.href,
        sampledAt:Date.now(),
        title:(controller ? pageMedia?.title : null) || navigator.mediaSession?.metadata?.title || document.title,
        paused:element ? element.paused : pageMedia?.paused !== false,
        ended:element ? !!element.ended : !!pageMedia?.ended,
        buffering:element ? element.seeking || element.readyState < 3 : undefined,
        currentTime:element ? (Number.isFinite(element.currentTime)?element.currentTime:0) : controller ? (Number(pageMedia?.currentTime)||0) : 0,
        duration:element ? (Number.isFinite(element.duration)?element.duration:0) : controller ? (Number(pageMedia?.duration)||0) : 0,
        rate:element?.playbackRate || pageMedia?.rate || 1,
        // The local output override must not mute WatchFusion's resolved player.
        volume:element ? ((priorMute.get(element) ?? element.muted) ? 0 : element.volume ?? 1) : pageMedia?.volume ?? 1,
        status:hasMedia ? '' : 'Waiting for playable media state.'
      }
    });
  }

  function onRuntimeMessage(message, _sender, reply) {
    if (message.type === 'probe-stop') { cleanup(); return; }
    if (message.type === 'probe-health') { if(enabled&&generation&&message.generation===generation){snapshot();reply?.({ok:true});} return; }
    if (message.type === 'probe-start') {
      enabled = true;
      generation=typeof message.generation==='string'?message.generation:null;
      setPlayerSilence(message.sourcePlayerSilenced === true);
      snapshot();
      return;
    }
    if(message.generation!==undefined&&message.generation!==generation)return;
    if (message.type === 'source-player-silence' && enabled) {
      setPlayerSilence(message.enabled === true);
      snapshot();
      reply?.({ silencedMedia:priorMute.size });
      return;
    }
    if (message.type !== 'source-control') return;
    if (message.action === 'next' || message.action === 'prev') {
      if(!enabled){reply?.({outcome:'rejected',reason:'probe-disabled'});return;}
      const element=media(),controller=element?null:pagePlayer();
      if(controller&&!/^(?:(?:www|m)\.)?youtube\.com$/i.test(location.hostname)){window.postMessage({channel:PAGE_CHANNEL,type:'control',action:message.action,value:0},'*');reply?.({outcome:'unknown',reason:'no-execution-ack'});snapshot();return;}
      const evidence={};try{const ok=clickTransport(message.action,evidence);reply?.({outcome:ok?'accepted':'rejected',reason:evidence.reason||'playlist-unverified',target:evidence.target||'',index:evidence.index||0});}catch{reply?.({outcome:'unknown',reason:'probe-execution-error'});}snapshot();return;
    }
    if(!enabled)return;
    const element = media(), controller = element ? null : pagePlayer(), value = Number(message.value) || 0;
    if (controller) {
      window.postMessage({ channel:PAGE_CHANNEL, type:'control', action:message.action, value }, '*');
      snapshot();
      return;
    }
    if (!element) return;
    if (message.action === 'toggle') { if (element.paused) element.play().catch(() => {}); else element.pause(); }
    if (message.action === 'play') element.play().catch(() => {});
    if (message.action === 'pause') element.pause();
    if (message.action === 'seek') element.currentTime = Math.max(0, Math.min(value, Number.isFinite(element.duration) ? element.duration : value));
    if (message.action === 'rate') element.playbackRate = Math.max(.25, Math.min(4, value));
    if (message.action === 'volume') {
      element.volume = Math.max(0, Math.min(1, value));
      if (priorMute.has(element)) priorMute.set(element, value === 0);
      else element.muted = value === 0;
    }
    snapshot();
  }

  window.addEventListener('message', onWindowMessage);
  document.addEventListener('load', onDocumentLoad, true);
  document.addEventListener('play', onSourceAudioChange, true);
  document.addEventListener('volumechange', onSourceAudioChange, true);
  document.addEventListener('visibilitychange',scheduleSnapshot);
  window.addEventListener('pageshow',scheduleSnapshot);
  const runtime = runtimeApi();
  if (!runtime) { cleanup(); return; }
  try {
    runtime.onMessage.addListener(onRuntimeMessage);
    runtimeListenerAttached = true;
  } catch (error) {
    cleanup();
    if (isRuntimeInvalidated(error)) return;
    throw error;
  }
  sampleTimer = setInterval(snapshot, 350);
  snapshot();
})();
