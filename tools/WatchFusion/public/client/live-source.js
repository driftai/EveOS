/* A live source owns its timeline. Never feed it through file/YouTube drift correction. */
(() => {
  let receiver = null, currentId = '', currentMember = '', busy = false, lastMetadata = {};
  const owners = new Map();
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
  function disconnect() {
    receiver?.stop(); receiver = null; currentId = ''; currentMember = '';
    $('liveVideo').srcObject = null; $('liveVideo').hidden = true; $('liveControls').hidden = true;
  }
  function load(source) {
    hideOtherPlayers(); $('liveVideo').hidden = false; $('liveControls').hidden = false;
    const membership = `${roomId || ''}:${session?.memberId || ''}`;
    if (source.streamId === currentId && membership === currentMember && receiver) { controls(lastMetadata); return; }
    receiver?.stop(); currentId = source.streamId; currentMember = membership;
    const saved = owner(currentId); $('liveVideo').muted = true; $('liveListen').textContent = 'Listen here';
    controls({}); status('Connecting live media…');
    receiver = new window.WatchFusionLivePeer({ base: location.origin, id: currentId,
      token: saved?.publisherToken || source.viewerToken, roomId, memberId: session?.memberId,
      onStatus: status, onMetadata: controls,
      onStream: stream => { $('liveVideo').srcObject = stream; $('liveVideo').play().catch(() => status('Press Listen here to start playback.')); }
    });
  }
  async function share(source) {
    const saved = owner(source.streamId);
    if (!saved) throw new Error('Reconnect the source from this browser before sharing it.');
    const result = await post(`/api/live/${source.streamId}/room`, { ...saved, roomId, title: source.title, mode: source.mode });
    state = result.state; render();
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
    try {
      created = await post('/api/live', {}); owners.set(created.id, created);
      try { localStorage.setItem(ownerKey(created.id), JSON.stringify(created)); } catch {}
      const source = { kind: 'live', streamId: created.id, viewerToken: created.viewerToken, title: mode === 'audioflix' ? 'Audioflix · Music Library' : 'Linked tab', mode };
      if (mode === 'audioflix') await askAudioflix({ base: location.origin, id: created.id, token: created.publisherToken });
      if (roomId) await share(source); else applySoloSource(source);
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
  $('liveListen').onclick = async () => { const video = $('liveVideo'); video.muted = !video.muted; try { await video.play(); $('liveListen').textContent = video.muted ? 'Listen here' : 'Mute here'; } catch { status('Browser blocked playback. Try Listen here again.'); } };
  $('liveRetry').onclick = () => { const source = state?.source; if (source?.kind === 'live') { receiver?.stop(); receiver = null; load(source); } };
  $('liveStop').onclick = async () => {
    try { await post(`/api/live/${currentId}/stop`, owner(currentId)); owners.delete(currentId); localStorage.removeItem(ownerKey(currentId)); disconnect(); $('livePairHelp').hidden = true; setStatus('Live source stopped'); }
    catch (error) { status(error.message); }
  };
  $('liveControls').addEventListener('click', event => { const button = event.target.closest('[data-live-action]'); if (button && canControl()) receiver?.control(button.dataset.liveAction, Number(button.dataset.value)); });
  for (const [id, action] of [['liveSeek', 'seek'], ['liveRate', 'rate'], ['liveVolume', 'volume']]) $(id).onchange = () => { if (canControl()) receiver?.control(action, Number($(id).value)); };
  window.watchFusionLive = { load, disconnect, share };
  window.watchPartyProviders.register({ id: 'live', supports: source => source?.kind === 'live', load: async source => load(source) });
  window.addEventListener('beforeunload', () => receiver?.stop());
})();
