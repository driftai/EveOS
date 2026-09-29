/* A live source owns its timeline. Never feed it through file/YouTube drift correction. */
(() => {
  let receiver = null, currentId = '', currentMember = '', busy = false, lastMetadata = {};
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
  function canControl() { return roomId ? isHost() : !!owner(currentId); }
  function controls(metadata = {}) {
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
    video.muted = !enabled;
    $('liveListen').textContent = enabled ? 'Mute here' : 'Listen here';
    $('liveListen').setAttribute('aria-pressed', String(enabled));
  }
  function disconnect() {
    receiver?.stop(); receiver = null; currentId = ''; currentMember = '';
    const video = $('liveVideo'); video.srcObject = null; setListen(video, false);
    video.hidden = true; $('liveControls').hidden = true;
  }
  function load(source) {
    hideOtherPlayers(); $('liveVideo').hidden = false; $('liveControls').hidden = false;
    const membership = `${roomId || ''}:${session?.memberId || ''}`;
    if (source.streamId === currentId && membership === currentMember && receiver) { controls(lastMetadata); return; }
    receiver?.stop(); currentId = source.streamId; currentMember = membership;
    const saved = owner(currentId);
    const video = $('liveVideo');
    setListen(video, listenPreferences.get(currentId) ?? source.mode === 'audioflix');
    controls({}); status('Connecting live media…');
    receiver = new window.WatchFusionLivePeer({ base: location.origin, id: currentId,
      token: saved?.publisherToken || source.viewerToken, roomId, memberId: session?.memberId,
      onStatus: status, onMetadata: controls,
      onStream: stream => {
        video.srcObject = stream;
        video.play().catch(() => {
          setListen(video, false);
          status('Playback is ready · press Listen here once to enable audio.');
        });
      }
    });
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
      const requestId = crypto.randomUUID();
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
    if (busy || (roomId && !isHost())) return setStatus('Only the host can select the room source.');
    busy = true;
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
    } finally { busy = false; }
  }
  $('linkTabBtn').onclick = () => start('tab'); $('linkAudioflixBtn').onclick = () => start('audioflix');
  $('liveCopyPair').onclick = async event => { const ok = await copyText($('livePairLink').value); setCopyButtonFeedback(event.currentTarget, ok); };
  $('livePairClose').onclick = () => { $('livePairHelp').hidden = true; };
  $('livePairFolder').onclick = async () => {
    try {
      const response = await fetch(apiUrl('/api/setup/open-extension-folder'), { method: 'POST', cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not open the companion folder.');
      status(result.message || 'Companion folder opened.');
    } catch (error) { status(error.message); }
  };
  $('livePairOfficialFolder').onclick = async () => {
    try {
      const response = await fetch(apiUrl('/api/setup/open-extension-folder?package=official'), { method: 'POST', cache: 'no-store' });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Could not open the EveOS extension folder.');
      status(result.message || 'EveOS extension folder opened.');
    } catch (error) { status(error.message); }
  };
  $('liveListen').onclick = async () => {
    const video = $('liveVideo'); setListen(video, video.muted);
    listenPreferences.set(currentId, !video.muted);
    try { await video.play(); } catch { setListen(video, false); status('Browser blocked playback. Try Listen here again.'); }
  };
  $('liveRetry').onclick = () => { const source = state?.source; if (source?.kind === 'live') { receiver?.stop(); receiver = null; load(source); } };
  $('liveStop').onclick = async () => {
    try {
      if (window.unloadWatchFusionMedia) await window.unloadWatchFusionMedia();
      else { await unload(); setStatus('Live source stopped'); }
    } catch (error) { status(error.message); }
  };
  $('liveControls').addEventListener('click', event => { const button = event.target.closest('[data-live-action]'); if (button && canControl()) receiver?.control(button.dataset.liveAction, Number(button.dataset.value)); });
  for (const [id, action] of [['liveSeek', 'seek'], ['liveRate', 'rate'], ['liveVolume', 'volume']]) $(id).onchange = () => { if (canControl()) receiver?.control(action, Number($(id).value)); };
  window.watchFusionLive = { load, disconnect, share, unload };
  window.watchPartyProviders.register({ id: 'live', supports: source => source?.kind === 'live', load: async source => load(source), unload });
  window.addEventListener('beforeunload', () => receiver?.stop());
})();
