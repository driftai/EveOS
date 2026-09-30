/* A live source owns its timeline. Never feed it through file/YouTube drift correction. */
(() => {
  let receiver = null, currentId = '', currentMember = '', busy = false, lastMetadata = {};
  let activeLiveStream = null, listenEnabled = false;
  let delayContext = null, delaySource = null, delayNode = null, delayStream = null;
  let audioSyncTimer = null, autoSyncDelayMs = 0, autoSyncReady = false, autoSyncPeers = 0;
  const AUDIO_SYNC_KEY = 'watchfusion.audioSyncDelayMs';
  const AUDIO_SYNC_AUTO_KEY = 'watchfusion.audioSyncAuto';
  const owners = new Map();
  const listenPreferences = new Map();
  const ownerKey = id => `watchfusion.live.${id}`;
  function owner(id) {
    if (owners.has(id)) return owners.get(id);
    try { const value = JSON.parse(localStorage.getItem(ownerKey(id))); if (value) owners.set(id, value); return value; } catch { return null; }
  }
  function status(message) { $('liveStatus').textContent = message; }
  async function post(path, body) {
    const response = await fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json', ...(session?.memberId ? { 'x-member-id': session.memberId } : {}) }, body: JSON.stringify(body) });
    const result = await response.json(); if (!response.ok) throw new Error(result.error || 'Live media request failed'); return result;
  }
  function canControl() { if(window.watchFusionLinkedTab?.active?.())return roomId?isHost():true; return roomId ? isHost() : !!owner(currentId); }
  function connectionActions(source = state?.source) {
    const linked=source?.kind==='live'&&source.mode==='audioflix';
    $('linkAudioflixBtn').textContent=linked?'Disconnect Audioflix':'Connect Audioflix';
    $('linkAudioflixBtn').setAttribute('aria-pressed',String(linked));
    $('linkAudioflixBtn').disabled=busy||!!(roomId&&!isHost());
    if(!window.watchFusionLinkedTab?.active?.()){
      $('linkTabBtn').textContent='Link a playing tab';$('linkTabBtn').setAttribute('aria-pressed','false');
      $('linkTabBtn').disabled=busy||!!(roomId&&!isHost());
    }
  }
  function manualAudioSyncDelayMs() {
    const value = Number(storage.get(AUDIO_SYNC_KEY, '0'));
    return Number.isFinite(value) ? Math.max(0, Math.min(1000, value)) : 0;
  }
  function audioSyncAutoEnabled() {
    const value = String(storage.get(AUDIO_SYNC_AUTO_KEY, '1')).toLowerCase();
    return value !== '0' && value !== 'false';
  }
  function deviceProfileAudioDelayMs() {
    const calibrated=manualAudioSyncDelayMs();
    if(calibrated>0)return calibrated;
    let mobile=false;
    try{mobile=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||((navigator.maxTouchPoints||0)>0&&matchMedia('(pointer: coarse)').matches);}catch{}
    return mobile?355:0;
  }
  function effectiveAudioSyncDelayMs() {
    if(!audioSyncAutoEnabled())return manualAudioSyncDelayMs();
    return autoSyncReady?autoSyncDelayMs:deviceProfileAudioDelayMs();
  }
  function stopDelayGraph(closeContext = false) {
    try { delaySource?.disconnect(); } catch {}
    try { delayNode?.disconnect(); } catch {}
    delaySource = null; delayNode = null; delayStream = null;
    if (closeContext && delayContext) { delayContext.close?.().catch?.(() => {}); delayContext = null; }
  }
  function audioOutputLatencyMs() {
    if (!delayContext) return 0;
    const base = Number(delayContext.baseLatency) || 0;
    const output = Number(delayContext.outputLatency) || 0;
    return Math.max(0, Math.min(1000, (base + output) * 1000));
  }
  async function refreshAudioOutput() {
    const video = $('liveVideo');
    if (!video) return;
    if (!listenEnabled) { video.muted = true; stopDelayGraph(false); return; }
    const audioflix = state?.source?.mode === 'audioflix';
    if (!activeLiveStream) { video.muted = !listenEnabled; return; }
    if (!audioflix) { stopDelayGraph(false); video.muted = false; return; }
    const Context = window.AudioContext || window.webkitAudioContext;
    if (!Context) { video.muted = false; return; }
    video.muted = true;
    if (!delayContext) delayContext = new Context({ latencyHint: 'interactive' });
    if (delayStream !== activeLiveStream || !delaySource || !delayNode) {
      stopDelayGraph(false);
      delaySource = delayContext.createMediaStreamSource(activeLiveStream);
      delayNode = delayContext.createDelay(2);
      delaySource.connect(delayNode).connect(delayContext.destination);
      delayStream = activeLiveStream;
    }
    delayNode.delayTime.setTargetAtTime(effectiveAudioSyncDelayMs() / 1000, delayContext.currentTime, 0.008);
    try { await delayContext.resume(); } catch {}
  }
  function updateAudioSyncUi(source = state?.source) {
    const wrap = $('liveAudioSyncWrap'), input = $('liveAudioSync'), output = $('liveAudioSyncValue');
    const auto = $('liveAudioSyncAuto'), hint = $('liveAudioSyncHint');
    if (!wrap || !input || !output || !auto || !hint) return;
    const active = source?.kind === 'live' && source.mode === 'audioflix';
    wrap.hidden = !active;
    const autoEnabled = audioSyncAutoEnabled();
    auto.checked = autoEnabled;
    input.disabled = autoEnabled;
    const fallback=deviceProfileAudioDelayMs();
    const value=autoEnabled?(autoSyncReady?autoSyncDelayMs:fallback):manualAudioSyncDelayMs();
    if(document.activeElement!==input)input.value=String(value);
    output.textContent=autoEnabled?`Auto +${value} ms`:`+${value} ms`;
    hint.textContent=autoEnabled
      ? (autoSyncReady?`Measured alignment against ${autoSyncPeers} room receivers.`
        :(fallback>0?'Using this device’s remembered/mobile calibration because precise WebRTC playout timestamps are unavailable.':'Precise playout timing is unavailable here; this device stays at +0 ms.'))
      :'Manual per-device fine-tuning · this value becomes the Auto fallback on this device.';
  }
  function playoutDelayMs(source) {
    if (source?.mode === 'audioflix') return 60;
    return isTryCloudflare ? 60 : 10;
  }
  function stopAudioSyncSampling() {
    clearInterval(audioSyncTimer); audioSyncTimer = null;
    autoSyncReady = false; autoSyncDelayMs = 0; autoSyncPeers = 0;
  }
  async function sendAudioSyncSample() {
    if (!receiver || !roomId || state?.source?.mode !== 'audioflix') return;
    const sample = await receiver.audioSyncSample?.();
    if (!sample?.estimatedPlayoutTimestamp) return;
    receiver.syncAudio?.({
      ...sample,
      nativeOutputLatencyMs: audioOutputLatencyMs(),
      appliedDelayMs: effectiveAudioSyncDelayMs(),
      auto: audioSyncAutoEnabled()
    });
  }
  function startAudioSyncSampling(source = state?.source) {
    clearInterval(audioSyncTimer); audioSyncTimer = null;
    if (!roomId || source?.mode !== 'audioflix') return;
    setTimeout(() => void sendAudioSyncSample(), 350);
    audioSyncTimer = setInterval(() => void sendAudioSyncSample(), 1000);
  }
  function applyAutoSync(message = {}) {
    if (!audioSyncAutoEnabled()) return;
    autoSyncPeers = Math.max(0, Number(message.peers) || 0);
    if (!message.available || autoSyncPeers < 2) {
      autoSyncReady = false; autoSyncDelayMs = 0;
    } else {
      const target = Math.max(0, Math.min(1000, Number(message.delayMs) || 0));
      autoSyncDelayMs = autoSyncReady ? Math.round((autoSyncDelayMs * 0.6 + target * 0.4) / 5) * 5 : Math.round(target / 5) * 5;
      autoSyncReady = true;
    }
    updateAudioSyncUi();
    void refreshAudioOutput();
  }
  function controls(metadata = {}) {
    connectionActions();
    updateAudioSyncUi();
    lastMetadata = metadata;
    $('liveTitle').textContent = metadata.title || state?.source?.title || 'Live media';
    $('liveGroup').textContent = metadata.group || '';
    $('liveToggle').textContent = metadata.paused ? 'Play' : 'Pause';
    const time = value => { const n = Math.max(0, Math.floor(Number(value) || 0)); return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`; };
    $('liveTime').textContent = `${time(metadata.currentTime)} / ${time(metadata.duration)}`;
    if (document.activeElement !== $('liveSeek')) { $('liveSeek').max = metadata.duration || 0; $('liveSeek').value = metadata.currentTime || 0; }
    if (document.activeElement !== $('liveRate')) $('liveRate').value = String(metadata.rate || 1);
    if (document.activeElement !== $('liveVolume')) $('liveVolume').value = metadata.volume ?? 1;
    $('liveShuffle').setAttribute('aria-pressed', String(!!metadata.shuffle));
    $('liveLoop').setAttribute('aria-pressed', String(!!metadata.loop));
    const queue = metadata.queue || [];
    const signature = JSON.stringify([queue, metadata.index]);
    if ($('liveQueue').dataset.signature !== signature) {
      $('liveQueue').replaceChildren(...queue.map((item, index) => {
        const li = document.createElement('li'), button = document.createElement('button');
        button.type = 'button'; button.textContent = `${index === metadata.index ? '▶ ' : ''}${item.title || 'Untitled'}`;
        button.dataset.liveAction = 'jump'; button.dataset.value = index; li.append(button); return li;
      }));
      $('liveQueue').dataset.signature = signature;
    }
    $('liveQueueWrap').hidden = !queue.length;
    $('liveQueueTools').hidden = state?.source?.mode !== 'audioflix';
    for (const button of $('liveControls').querySelectorAll('[data-live-action]')) button.disabled = !canControl();
    for (const id of ['liveSeek', 'liveRate', 'liveVolume']) $(id).disabled = !canControl();
    $('liveStop').hidden = !owner(currentId);
    if (metadata.status) status(metadata.status);
  }
  function hideOtherPlayers() {
    window.mediaPlayback?.clear?.();
    try { ytPlayer?.pauseVideo?.(); } catch {}
    for (const id of ['player', 'nuvioFrame', 'voxelVisionFrame']) { const el = $(id); if (el) { el.hidden = true; el.style.display = 'none'; } }
  }
  function setListen(video, enabled) {
    listenEnabled = !!enabled;
    void refreshAudioOutput();
    $('liveListen').textContent = enabled ? 'Mute here' : 'Listen here';
    $('liveListen').setAttribute('aria-pressed', String(enabled));
  }
  function disconnect() {
    stopAudioSyncSampling();
    receiver?.stop(); receiver = null; currentId = ''; currentMember = '';
    activeLiveStream = null; listenEnabled = false; stopDelayGraph(true);
    const video = $('liveVideo'); video.srcObject = null; setListen(video, false);
    video.hidden = true; $('liveControls').hidden = true;
    connectionActions(null);
  }
  function load(source) {
    hideOtherPlayers();
    const liveVideo=$('liveVideo');
    liveVideo.hidden=source?.mode==='audioflix';
    $('liveControls').hidden = false;
    const membership = `${roomId || ''}:${session?.memberId || ''}`;
    if (source.streamId === currentId && membership === currentMember && receiver) { controls(lastMetadata); startAudioSyncSampling(source); return; }
    receiver?.stop(); currentId = source.streamId; currentMember = membership;
    const saved = owner(currentId);
    const video = $('liveVideo');
    setListen(video, listenPreferences.get(currentId) ?? source.mode === 'audioflix');
    controls({}); status('Connecting live media…');
    receiver = new window.WatchFusionLivePeer({ base: location.origin, id: currentId,
      token: saved?.publisherToken || source.viewerToken, roomId, memberId: session?.memberId,
      jitterBufferTargetMs: playoutDelayMs(source),
      onStatus: status, onMetadata: controls, onAudioSync: applyAutoSync,
      onStream: stream => {
        activeLiveStream = stream;
        video.srcObject = stream;
        const hasVideo=stream?.getVideoTracks?.().some(track=>track.readyState!=='ended')===true;
        video.hidden=!hasVideo;
        if($('mediaStage'))$('mediaStage').classList.toggle('media-stage-empty',!hasVideo);
        void refreshAudioOutput();
        video.play().catch(() => {
          setListen(video, false);
          status('Playback is ready · press Listen here once to enable audio.');
        });
      }
    });
    startAudioSyncSampling(source);
  }
  async function share(source) {
    const saved = owner(source.streamId);
    if (!saved) throw new Error('Reconnect the source from this browser before sharing it.');
    const result = await post(`/api/live/${source.streamId}/room`, { ...saved, roomId, title: source.title, mode: source.mode });
    state = result.state; render();
  }
  async function stopOwned(id) {
    const saved = owner(id);
    if (!id || !saved) return;
    await post(`/api/live/${id}/stop`, saved).catch(() => {});
    owners.delete(id);
    try { localStorage.removeItem(ownerKey(id)); } catch {}
  }
  async function unload() {
    const id = currentId || (state?.source?.kind === 'live' ? state.source.streamId : '');
    if (id && owner(id)) await stopOwned(id);
    disconnect();
    $('livePairHelp').hidden = true;
  }
  function askAudioflix(config) {
    return new Promise((resolve, reject) => {
      const target = window.parent !== window ? window.parent : window.opener;
      if (!target) return reject(new Error('Open WatchFusion from EveOS to connect its Music Library.'));
      const requestId = makeClientId();
      const timer = setTimeout(() => { window.removeEventListener('message', onReply); reject(new Error('Audioflix did not answer. Open Music Library in EveOS and retry.')); }, 10000);
      function onReply(event) {
        if (event.source !== target || event.data?.type !== 'watchfusion:audioflix-result' || event.data.requestId !== requestId) return;
        clearTimeout(timer); window.removeEventListener('message', onReply);
        if (event.data.error) reject(new Error(event.data.error)); else resolve();
      }
      window.addEventListener('message', onReply);
      // No credentials sent to an unverified opener: first exchange a challenge.
      const onChallenge = event => {
        if (event.source !== target || event.data?.type !== 'watchfusion:audioflix-ready' || event.data.requestId !== requestId) return;
        window.removeEventListener('message', onChallenge);
        target.postMessage({ type: 'watchfusion:audioflix-start', requestId, config }, event.origin === 'null' ? '*' : event.origin);
      };
      window.addEventListener('message', onChallenge);
      setTimeout(() => window.removeEventListener('message', onChallenge), 10000);
      target.postMessage({ type: 'watchfusion:audioflix-probe', requestId }, '*');
    });
  }
  async function start(mode) {
    if(mode==='tab')return window.watchFusionLinkedTab?.start?.();
    if (busy || (roomId && !isHost())) return setStatus('Only the host can select the room source.');
    if(mode==='audioflix'&&window.watchFusionLinkedTab?.active?.())await window.watchFusionLinkedTab.stop({quiet:true});
    busy = true; connectionActions();
    let created;
    const previousId = state?.source?.kind === 'live' ? state.source.streamId : '';
    try {
      created = await post('/api/live', {}); owners.set(created.id, created);
      try { localStorage.setItem(ownerKey(created.id), JSON.stringify(created)); } catch {}
      const source = { kind: 'live', streamId: created.id, viewerToken: created.viewerToken, title: mode === 'audioflix' ? 'Audioflix · Music Library' : 'Linked tab', mode };
      if (mode === 'audioflix') await askAudioflix({ base: location.origin, id: created.id, token: created.publisherToken });
      if (roomId) await share(source); else applySoloSource(source);
      if (previousId && previousId !== created.id) await stopOwned(previousId);
      if (mode === 'tab') {
        const pairing = new URL(location.origin); pairing.hash = `live=${created.id}.${created.publisherToken}`;
        $('livePairLink').value = pairing.href; $('livePairHelp').hidden = false;
      } else $('livePairHelp').hidden = true;
      $('findMediaPanel').hidden = false;
      setStatus(mode === 'audioflix' ? 'Audioflix connected · its queue controls the room stream' : 'Copy the pairing link, then link your source tab with the companion');
    } catch (error) {
      if (created) { await post(`/api/live/${created.id}/stop`, created).catch(() => {}); owners.delete(created.id); try { localStorage.removeItem(ownerKey(created.id)); } catch {} }
      setStatus(error.message);
    } finally { busy = false; connectionActions(); }
  }
  async function selectMode(mode) {
    if (busy) return;
    if (state?.source?.kind !== 'live' || state.source.mode !== mode) return start(mode);
    busy = true; connectionActions();
    try { await window.unloadWatchFusionMedia(); }
    catch (error) { setStatus(error.message); }
    finally { busy = false; connectionActions(); }
  }
  $('linkAudioflixBtn').onclick = () => selectMode('audioflix');
  $('liveCopyPair').onclick = async event => { const ok = await copyText($('livePairLink').value); setCopyButtonFeedback(event.currentTarget, ok); };
  $('livePairClose').onclick = () => { $('livePairHelp').hidden = true; };
  function askHostFolder(target, packageName) {
    return new Promise((resolve, reject) => {
      const requestId = makeClientId();
      const timer = setTimeout(() => finish(new Error('EveOS did not answer. Reload EveOS and retry.')), 20000);
      function finish(error, result) { clearTimeout(timer); window.removeEventListener('message', reply); error ? reject(error) : resolve(result); }
      function reply(event) {
        if (event.source !== target || event.data?.type !== 'watchfusion:extension-folder-result' || event.data.requestId !== requestId) return;
        finish(event.data.ok ? null : new Error(event.data.message || 'Folder could not be opened.'), event.data);
      }
      window.addEventListener('message', reply);
      target.postMessage({ type: 'watchfusion:extension-folder', requestId, package: packageName }, '*');
    });
  }
  async function openFolder(packageName) {
    const feedback = $('livePairFeedback');
    feedback.textContent = 'Opening folder…';
    try {
      const target = window.parent !== window ? window.parent : window.opener;
      let result;
      if (target) result = await askHostFolder(target, packageName);
      else {
        const response = await fetch(`/api/setup/open-extension-folder?package=${packageName}`, { method: 'POST', cache: 'no-store' });
        result = await response.json();
        if (!response.ok) throw new Error(result.error || 'Open WatchFusion on this PC’s local URL to open folders.');
      }
      feedback.textContent = result.message || 'Extension folder opened.';
    } catch (error) { feedback.textContent = error.message; }
  }
  $('livePairFolder').onclick = () => openFolder('watchfusion');
  $('livePairOfficialFolder').onclick = () => openFolder('official');
  $('liveListen').onclick = async () => {
    const video = $('liveVideo'); setListen(video, !listenEnabled);
    listenPreferences.set(currentId, listenEnabled);
    try { await video.play(); } catch { setListen(video, false); status('Browser blocked playback. Try Listen here again.'); }
  };
  $('liveRetry').onclick = () => {
    if(window.watchFusionLinkedTab?.active?.())return window.watchFusionLinkedTab.reconnect();
    const source=state?.source;if(source?.kind==='live'){receiver?.stop();receiver=null;load(source);}
  };
  $('liveStats').onclick = async () => {
    const payload = {
      sourceMode: state?.source?.mode || null,
      audioSync: {
        auto: audioSyncAutoEnabled(),
        appliedDelayMs: effectiveAudioSyncDelayMs(),
        autoReady: autoSyncReady,
        peers: autoSyncPeers,
        nativeOutputLatencyMs: audioOutputLatencyMs()
      },
      receiver: await receiver?.diagnostics?.() || []
    };
    const copied = await copyText(JSON.stringify(payload, null, 2));
    status(copied ? 'Live receiver diagnostics copied.' : `Live diagnostics: ${JSON.stringify(payload)}`);
  };
  $('liveAudioSyncAuto').onchange = event => {
    const enabled = !!event.currentTarget.checked;
    if (!enabled && autoSyncReady) storage.set(AUDIO_SYNC_KEY, String(autoSyncDelayMs));
    storage.set(AUDIO_SYNC_AUTO_KEY, enabled ? '1' : '0');
    if (!enabled) { autoSyncReady = false; autoSyncPeers = 0; }
    updateAudioSyncUi();
    void refreshAudioOutput();
    void sendAudioSyncSample();
  };
  $('liveAudioSync').oninput = event => {
    const value = Math.max(0, Math.min(1000, Number(event.currentTarget.value) || 0));
    storage.set(AUDIO_SYNC_KEY, String(value));
    $('liveAudioSyncValue').textContent = `+${value} ms`;
    void refreshAudioOutput();
    void sendAudioSyncSample();
  };
  $('liveStop').onclick = async () => {
    if(window.watchFusionLinkedTab?.active?.())return void window.watchFusionLinkedTab.stop();
    try {
      if (window.unloadWatchFusionMedia) await window.unloadWatchFusionMedia();
      else { await unload(); setStatus('Live source stopped'); }
    } catch (error) { status(error.message); }
  };
  $('liveControls').addEventListener('click',event=>{
    const button=event.target.closest('[data-live-action]');if(!button||!canControl())return;
    if(window.watchFusionLinkedTab?.active?.())window.watchFusionLinkedTab.control(button.dataset.liveAction,Number(button.dataset.value));
    else receiver?.control(button.dataset.liveAction,Number(button.dataset.value));
  });
  for(const [id,action] of [['liveSeek','seek'],['liveRate','rate'],['liveVolume','volume']])$(id).onchange=()=>{
    if(!canControl())return;const value=Number($(id).value);
    if(window.watchFusionLinkedTab?.active?.())window.watchFusionLinkedTab.control(action,value);else receiver?.control(action,value);
  };
  window.watchFusionLive = { load, disconnect, share, unload, diagnostics: () => receiver?.diagnostics?.() || Promise.resolve([]) };
  connectionActions();
  window.watchPartyProviders.register({ id: 'live', supports: source => source?.kind === 'live', load: async source => load(source), unload });
  window.addEventListener('beforeunload', () => { stopAudioSyncSampling(); receiver?.stop(); });
})();
