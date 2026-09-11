function initVoxelVisionProvider() {
  if (typeof window === 'undefined' || !window.watchPartyProviders) return;

  const frame = () => document.getElementById('voxelVisionFrame');
  const toolbar = () => document.getElementById('voxelVisionToolbar');
  const playerHost = () => document.getElementById('playerHost');

  function setVisible(visible) {
    const target = frame();
    if (target) {
      target.hidden = !visible;
      target.style.display = visible ? 'block' : 'none';
    }
    if (toolbar()) toolbar().hidden = !visible;
    playerHost()?.classList.toggle('voxelvision-active', visible);
  }

  function hideOtherPlayers() {
    const nuvioFrame = document.getElementById('nuvioFrame');
    const nuvioToolbar = document.getElementById('nuvioToolbar');
    if (nuvioFrame) {
      nuvioFrame.hidden = true;
      nuvioFrame.style.display = 'none';
    }
    if (nuvioToolbar) nuvioToolbar.hidden = true;
    playerHost()?.classList.remove('nuvio-active');
    try {
      if (typeof ytPlayer !== 'undefined' && ytPlayer) ytPlayer.pauseVideo?.();
      const youtubeHost = document.getElementById('player');
      if (youtubeHost) {
        youtubeHost.hidden = true;
        youtubeHost.style.display = 'none';
      }
    } catch {}
  }

  function setActiveSourceTab(kind) {
    const activeId = kind === 'voxelvision' ? 'shortcutVoxelVisionBtn' : 'resolveTabBtn';
    document.querySelectorAll('.source-tab').forEach(tab => tab.classList.toggle('active', tab.id === activeId));
    const label = document.getElementById('sourceModeLabel');
    if (label) label.textContent = kind === 'voxelvision' ? 'VoxelVision' : 'Ready';
  }

  function loadFrame(source) {
    const host = playerHost();
    if (!host) return;
    let target = frame();
    if (!target) {
      target = document.createElement('iframe');
      target.id = 'voxelVisionFrame';
      target.className = 'voxelvision-frame';
      target.title = 'VoxelVision';
      target.allow = 'autoplay; fullscreen; picture-in-picture; webgpu';
      target.allowFullscreen = true;
      host.appendChild(target);
    } else if (!/\bwebgpu\b/i.test(target.getAttribute('allow') || '')) {
      target.setAttribute('allow', `${target.getAttribute('allow') || 'autoplay; fullscreen; picture-in-picture'}; webgpu`);
    }

    const entryPath = source.entryUrl || '/voxelvision/';
    const absoluteEntry = new URL(entryPath, location.origin).href;
    const alreadyLoaded = target.dataset.watchFusionVoxelVisionReady === '1' && target.src === absoluteEntry;
    window.mediaPlayback?.clear?.();
    hideOtherPlayers();
    setVisible(true);
    setActiveSourceTab('voxelvision');
    const findMedia = document.getElementById('findMediaPanel');
    if (findMedia) findMedia.hidden = true;

    if (!alreadyLoaded) {
      target.dataset.watchFusionVoxelVisionReady = '0';
      target.onload = () => {
        target.dataset.watchFusionVoxelVisionReady = '1';
        setStatus?.('VoxelVision ready');
      };
      target.src = entryPath;
    }
  }

  function closeView() {
    const target = frame();
    setVisible(false);
    if (target) {
      try {
        target.src = 'about:blank';
        target.dataset.watchFusionVoxelVisionReady = '0';
      } catch {}
    }
    if (typeof roomId !== 'undefined' && roomId) {
      setActiveSourceTab('');
      setStatus('VoxelVision closed. The shared room source stays selected until the host changes it.');
    } else {
      applySoloSource({ kind: 'ready', type: 'ready', title: 'Ready' });
      setStatus('VoxelVision closed · choose a media source');
    }
  }

  document.getElementById('voxelVisionReloadBtn')?.addEventListener('click', () => {
    const target = frame();
    if (!target) return;
    try { target.contentWindow?.location.reload(); } catch { target.src = target.src; }
  });
  document.getElementById('voxelVisionFullBtn')?.addEventListener('click', () => frame()?.requestFullscreen?.());
  document.getElementById('voxelVisionCloseBtn')?.addEventListener('click', closeView);

  window.watchPartyProviders.register({
    id: 'voxelvision',
    supports: source => source && (source.kind === 'voxelvision' || source.type === 'voxelvision'),
    load: async source => loadFrame(source)
  });
}

function openVoxelVisionMode() {
  const source = {
    kind: 'voxelvision',
    type: 'voxelvision',
    url: 'voxelvision://home',
    entryUrl: '/voxelvision/',
    title: 'VoxelVision',
    originalUrl: 'voxelvision://home'
  };
  if (typeof roomId !== 'undefined' && roomId) {
    if (typeof isHost === 'function' && !isHost()) return alert('Only the host can switch the room to VoxelVision.');
    fetch(apiUrl(`/api/rooms/${roomId}/media-source`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-member-id': session.memberId },
      body: JSON.stringify({ media: source, originalUrl: source.originalUrl })
    }).then(async response => {
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || 'Could not open VoxelVision.');
      state = data.state;
      sourceInputDirty = false;
      render();
      setStatus('VoxelVision ready');
    }).catch(error => setStatus(error.message || 'Could not open VoxelVision.'));
    return;
  }
  applySoloSource(source);
  setStatus('VoxelVision ready · solo mode');
}

initVoxelVisionProvider();
