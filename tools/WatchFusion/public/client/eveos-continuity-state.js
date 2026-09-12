(function () {
  'use strict';

  if (window.watchFusionContinuityState) return;

  const STORAGE_LIMIT_BYTES = 2 * 1024 * 1024;
  function isBlob(v) {
    return Boolean(v && (v instanceof Blob || Object.prototype.toString.call(v) === '[object Blob]' || typeof v.arrayBuffer === 'function'));
  }
  function clone(value) {
    if (value == null) return value;
    try { return structuredClone(value); } catch {}
    try { return JSON.parse(JSON.stringify(value)); } catch { return null; }
  }
  function waitFor(test, timeoutMs = 10000, intervalMs = 50) {
    const started = performance.now();
    return new Promise(resolve => {
      const tick = () => {
        let value = null;
        try { value = test(); } catch {}
        if (value) return resolve(value);
        if (performance.now() - started >= timeoutMs) return resolve(null);
        setTimeout(tick, intervalMs);
      };
      tick();
    });
  }

  function holdPlaybackGuards() {
    if (window.__watchFusionContinuityGuardState) return;
    const guard = {};
    try { if (typeof mediaEventGuard === 'number') { mediaEventGuard += 1; guard.media = true; } } catch {}
    try { if (typeof primingPlayer === 'boolean') { guard.priming = primingPlayer; primingPlayer = true; } } catch {}
    try { if (typeof applyingRemote === 'boolean') { guard.applyingRemote = applyingRemote; applyingRemote = true; } } catch {}
    try { if (document.body) { guard.bodyInert = !!document.body.inert; document.body.inert = true; } } catch {}
    window.__watchFusionContinuityGuardState = guard;
  }

  function releasePlaybackGuards() {
    const guard = window.__watchFusionContinuityGuardState;
    if (!guard) return;
    try { if (guard.media && typeof mediaEventGuard === 'number') mediaEventGuard = Math.max(0, mediaEventGuard - 1); } catch {}
    try { if (typeof primingPlayer === 'boolean' && 'priming' in guard) primingPlayer = !!guard.priming; } catch {}
    try { if (typeof applyingRemote === 'boolean' && 'applyingRemote' in guard) applyingRemote = !!guard.applyingRemote; } catch {}
    try { if (document.body && 'bodyInert' in guard) document.body.inert = !!guard.bodyInert; } catch {}
    delete window.__watchFusionContinuityGuardState;
  }
  function readStorage(area) {
    const entries = [];
    let bytes = 0;
    try {
      for (let index = 0; index < area.length && entries.length < 256; index += 1) {
        const key = area.key(index);
        if (key == null) continue;
        const value = area.getItem(key);
        if (value == null) continue;
        const nextBytes = (String(key).length + String(value).length) * 2;
        if (bytes + nextBytes > STORAGE_LIMIT_BYTES) break;
        entries.push([String(key), String(value)]);
        bytes += nextBytes;
      }
    } catch {}
    return entries;
  }
  function writeStorage(area, entries) {
    if (!Array.isArray(entries)) return;
    for (const pair of entries) {
      if (!Array.isArray(pair) || pair.length !== 2) continue;
      try { area.setItem(String(pair[0]), String(pair[1])); } catch {}
    }
  }

  function mediaState(video) {
    if (!video) return null;
    return {
      src: String(video.currentSrc || video.src || ''),
      currentTime: Number(video.currentTime) || 0,
      paused: !!video.paused,
      ended: !!video.ended,
      playbackRate: Number(video.playbackRate) || 1,
      volume: Number.isFinite(Number(video.volume)) ? Number(video.volume) : 1,
      muted: !!video.muted
    };
  }

  async function applyMediaState(video, snapshot, { allowPlay = true } = {}) {
    if (!video || !snapshot) return;
    if (video.readyState < 1 && snapshot.currentTime > 0) {
      await new Promise(resolve => {
        let settled = false;
        const done = () => { if (!settled) { settled = true; resolve(); } };
        video.addEventListener('loadedmetadata', done, { once: true });
        setTimeout(done, 4000);
      });
    }
    try { video.playbackRate = Math.max(0.25, Math.min(4, Number(snapshot.playbackRate) || 1)); } catch {}
    try {
      const volume = Number(snapshot.volume);
      if (Number.isFinite(volume)) video.volume = Math.max(0, Math.min(1, volume));
    } catch {}
    try { video.muted = !!snapshot.muted; } catch {}
    try {
      const time = Math.max(0, Number(snapshot.currentTime) || 0);
      video.currentTime = Number.isFinite(video.duration) && video.duration > 0
        ? Math.min(time, Math.max(0, video.duration - 0.05))
        : time;
    } catch {}
    if (snapshot.paused || snapshot.ended || !allowPlay) {
      try { video.pause(); } catch {}
      return;
    }
    try {
      const result = video.play();
      result?.catch?.(() => setStatus?.('State restored · click the player once if the browser blocks autoplay.'));
    } catch {}
  }

  function preferredNuvioVideo(doc) {
    try {
      const videos = [...(doc?.querySelectorAll?.('video') || [])];
      return videos.find(video => !video.paused && !!(video.currentSrc || video.src))
        || videos.find(video => !!(video.currentSrc || video.src))
        || videos[0]
        || null;
    } catch {
      return null;
    }
  }

  function captureNuvio() {
    const frame = document.getElementById('nuvioFrame');
    if (!frame) return null;
    try {
      return {
        href: String(frame.contentWindow?.location?.href || ''),
        media: mediaState(preferredNuvioVideo(frame.contentDocument))
      };
    } catch {
      return null;
    }
  }

  async function captureVoxel({ includeBlob = true } = {}) {
    const frame = document.getElementById('voxelVisionFrame');
    if (!frame) return null;
    try {
      const win = frame.contentWindow;
      const doc = frame.contentDocument;
      const app = win?.app;
      const video = app?.video || doc?.getElementById?.('videoPlayer') || doc?.querySelector?.('video');
      const snapshot = {
        src: String(video?.currentSrc || video?.src || ''),
        title: String(doc?.getElementById?.('clipTitle')?.textContent || 'VoxelVision'),
        depthMode: String(app?.depthMode || ''),
        mediaInfo: clone(app?.lastSourceMediaInfo),
        playback: mediaState(video),
        settings: {
          grid: Number(app?.currentGridCols) || null,
          brightness: Number(app?.brightness),
          contrast: Number(app?.contrast),
          height: doc?.getElementById?.('heightSlider')?.value ?? null,
          gap: doc?.getElementById?.('gapSlider')?.value ?? null
        }
      };
      if (includeBlob && snapshot.src.startsWith('blob:')) {
        try {
          if (isBlob(app?.sourceBlob)) snapshot.blob = app.sourceBlob;
          else {
            const response = await win.fetch(snapshot.src);
            if (response.ok) snapshot.blob = await response.blob();
          }
        } catch {}
      }
      snapshot.playback = mediaState(video);
      return snapshot;
    } catch {
      return null;
    }
  }

  function captureYoutube() {
    try {
      if (!ytPlayer || !ytPlayerReady) return null;
      const playerState = Number(ytPlayer.getPlayerState?.());
      return {
        videoId: String(ytPlayer.getVideoData?.()?.video_id || pendingVideoId || state?.source?.videoId || ''),
        currentTime: Number(ytPlayer.getCurrentTime?.()) || 0,
        paused: playerState !== window.YT?.PlayerState?.PLAYING,
        ended: playerState === window.YT?.PlayerState?.ENDED,
        playbackRate: Number(ytPlayer.getPlaybackRate?.()) || 1,
        volume: Math.max(0, Math.min(100, Number(ytPlayer.getVolume?.()) || 0)),
        muted: !!ytPlayer.isMuted?.()
      };
    } catch {
      return null;
    }
  }

  function captureRoom() {
    if (typeof roomId === 'undefined' || !roomId) return null;
    return { id: String(roomId), code: roomCode || null, joinCode: joinCode || null,
      name: typeof currentName === 'function' ? currentName() : 'Guest',
      accountId: typeof accountId !== 'undefined' ? accountId : null,
      session: clone(typeof session !== 'undefined' ? session : null) };
  }

  async function captureSnapshot({ includeBlob = true } = {}) {
    return {
      protocol: 1,
      capturedAt: Date.now(),
      source: clone(typeof state !== 'undefined' ? state?.source : null),
      room: captureRoom(),
      roomPlayback: clone(typeof state !== 'undefined' ? state?.playback : null),
      storage: { local: readStorage(window.localStorage), session: readStorage(window.sessionStorage) },
      ui: {
        findMediaOpen: !document.getElementById('findMediaPanel')?.hidden,
        sourceInput: document.getElementById('sourceInput')?.value || '',
        headerExpanded: document.getElementById('headerActions')?.hidden === false
      },
      media: typeof mediaVideo !== 'undefined' ? mediaState(mediaVideo) : null,
      youtube: captureYoutube(),
      nuvio: captureNuvio(),
      voxel: await captureVoxel({ includeBlob })
    };
  }

  function captureEmergencySnapshot() {
    return {
      protocol: 1,
      capturedAt: Date.now(),
      source: clone(typeof state !== 'undefined' ? state?.source : null),
      room: captureRoom(),
      roomPlayback: clone(typeof state !== 'undefined' ? state?.playback : null),
      storage: { local: readStorage(window.localStorage), session: readStorage(window.sessionStorage) },
      ui: { sourceInput: document.getElementById('sourceInput')?.value || '' },
      media: typeof mediaVideo !== 'undefined' ? mediaState(mediaVideo) : null,
      youtube: captureYoutube(),
      nuvio: captureNuvio(),
      voxel: null
    };
  }

  function stopRoomTransport() {
    try { eventSource?.close?.(); eventSource = null; } catch {}
    try { window.watchPartyRealtime?.stop?.(); } catch {}
    try { if (remotePollTimer) clearInterval(remotePollTimer); remotePollTimer = null; } catch {}
    try { if (pingTimer) clearInterval(pingTimer); pingTimer = null; } catch {}
  }

  function parkCurrentOwner() {
    holdPlaybackGuards();
    window.__watchFusionContinuityApplying = true;
    document.documentElement.classList.add('watchfusion-continuity-parked');
    stopRoomTransport();
    try {
      if (typeof mediaVideo !== 'undefined' && mediaVideo) {
        if (typeof withMediaGuard === 'function') withMediaGuard(() => mediaVideo.pause());
        else mediaVideo.pause();
      }
    } catch {}
    try { if (typeof ytPlayer !== 'undefined' && ytPlayer) { applyingRemote = true; ytPlayer.pauseVideo?.(); } } catch {}
    try { preferredNuvioVideo(document.getElementById('nuvioFrame')?.contentDocument)?.pause?.(); } catch {}
    try { document.getElementById('voxelVisionFrame')?.contentWindow?.app?.video?.pause?.(); } catch {}
  }

  function restoreSimpleUi(snapshot) {
    const input = document.getElementById('sourceInput');
    if (input && typeof snapshot?.ui?.sourceInput === 'string') input.value = snapshot.ui.sourceInput;
    try { setHeaderExpanded?.(!!snapshot?.ui?.headerExpanded); } catch {}
    const panel = document.getElementById('findMediaPanel');
    if (panel && snapshot?.ui?.findMediaOpen) panel.hidden = false;
  }

  async function restoreRoomOrSolo(snapshot) {
    writeStorage(window.localStorage, snapshot?.storage?.local);
    writeStorage(window.sessionStorage, snapshot?.storage?.session);
    try { playerAudioPrefs = loadPlayerAudioPrefs(); } catch {}

    if (snapshot?.room?.id && typeof join === 'function') {
      if (snapshot.room.accountId) {
        accountId = String(snapshot.room.accountId);
        storage.set('wp-account-id', accountId);
      }
      if (snapshot.room.session) saveSession(snapshot.room.id, snapshot.room.session);
      await join(snapshot.room.id, snapshot.room.name || 'Guest', snapshot.room.code || null);
      return;
    }

    stopRoomTransport();
    try { roomId = null; roomCode = null; joinCode = null; session = null; } catch {}
    const source = clone(snapshot?.source) || { kind: 'ready', type: 'ready', title: 'Ready' };
    if (typeof applySoloSource === 'function') {
      applySoloSource(source);
    } else {
      state = { source, playback: clone(snapshot?.roomPlayback), members: [], messages: [], revision: 0 };
      render?.();
    }
  }

  async function restoreDirectMedia(snapshot) {
    const source = state?.source || snapshot?.source;
    if (!source || source.kind !== 'media') return;
    await window.mediaPlayback?.ensureSource?.(source);
    const video = await waitFor(() => typeof mediaVideo !== 'undefined' && mediaVideo, 10000);
    if (video) await applyMediaState(video, snapshot.media);
  }

  async function restoreYoutube(snapshot) {
    const source = state?.source || snapshot?.source;
    const videoId = snapshot?.youtube?.videoId || source?.videoId;
    if (!videoId || typeof ensurePlayer !== 'function') return;
    ensurePlayer(videoId);
    const player = await waitFor(() => typeof ytPlayer !== 'undefined' && ytPlayerReady && ytPlayer, 10000);
    if (!player || !snapshot.youtube) return;
    try {
      applyingRemote = true;
      player.setPlaybackRate?.(Number(snapshot.youtube.playbackRate) || 1);
      player.setVolume?.(Math.max(0, Math.min(100, Number(snapshot.youtube.volume) || 0)));
      snapshot.youtube.muted ? player.mute?.() : player.unMute?.();
      player.seekTo?.(Math.max(0, Number(snapshot.youtube.currentTime) || 0), true);
      if (snapshot.youtube.paused || snapshot.youtube.ended) player.pauseVideo?.();
      else player.playVideo?.();
    } catch {}
  }

  async function restoreNuvio(snapshot) {
    if ((state?.source || snapshot?.source)?.kind !== 'nuvio' || !snapshot?.nuvio) return;
    const frame = await waitFor(() => document.getElementById('nuvioFrame'), 8000);
    if (!frame) return;
    const href = String(snapshot.nuvio.href || '');
    if (href) {
      try {
        const parsed = new URL(href);
        const current = new URL(frame.src || '/nuvio/dist/index.html', location.origin);
        const winHref = frame.contentWindow?.location?.href;
        if (parsed.origin === location.origin && parsed.pathname.startsWith('/nuvio/')) {
          if (winHref && winHref !== parsed.href) {
            if (parsed.hash && frame.contentWindow?.location) {
              frame.contentWindow.location.hash = parsed.hash;
            } else {
              frame.src = parsed.href;
            }
          } else if (!winHref && parsed.href !== current.href) {
            frame.src = parsed.href;
          }
        }
      } catch {}
    }
    const video = await waitFor(() => {
      try { return preferredNuvioVideo(frame.contentDocument); } catch { return null; }
    }, 10000);
    if (video) await applyMediaState(video, snapshot.nuvio.media);
  }

  function applyVoxelSettings(app, doc, snapshot) {
    const settings = snapshot?.settings || {};
    try {
      if (snapshot?.title && doc?.getElementById('clipTitle')) doc.getElementById('clipTitle').textContent = snapshot.title;
      if (Number.isFinite(Number(settings.grid))) app.setGridResolution?.(Number(settings.grid));
      if (Number.isFinite(Number(settings.brightness))) {
        app.brightness = Number(settings.brightness);
        const s = doc?.getElementById('brightnessSlider'); if (s) s.value = String(settings.brightness);
      }
      if (Number.isFinite(Number(settings.contrast))) {
        app.contrast = Number(settings.contrast);
        const s = doc?.getElementById('contrastSlider'); if (s) s.value = String(settings.contrast);
      }
      if (settings.height != null) {
        const s = doc?.getElementById('heightSlider'); if (s) s.value = String(settings.height);
        app.updateHeightScale?.();
      }
      if (settings.gap != null) {
        const s = doc?.getElementById('gapSlider'); if (s) s.value = String(settings.gap);
      }
    } catch {}
  }

  async function restoreVoxel(snapshot) {
    if ((state?.source || snapshot?.source)?.kind !== 'voxelvision' || !snapshot?.voxel) return;
    const frame = await waitFor(() => document.getElementById('voxelVisionFrame'), 8000);
    const app = await waitFor(() => frame?.contentWindow?.app, 10000);
    if (!app) return;
    const doc = frame.contentDocument;
    const voxel = snapshot.voxel;

    if (voxel.depthMode === 'live' && voxel.src) {
      const currentSrc = String(app.video?.currentSrc || app.video?.src || '');
      const sameBlobFamily = voxel.src.startsWith('blob:') && currentSrc.startsWith('blob:')
        && String(doc?.getElementById('clipTitle')?.textContent || '') === String(voxel.title || '');
      if (!sameBlobFamily && currentSrc !== voxel.src) {
        try {
          if (isBlob(voxel.blob)) {
            const objectUrl = frame.contentWindow.URL.createObjectURL(voxel.blob);
            await app.loadLiveMedia(objectUrl, voxel.title || 'Transferred VoxelVision media', {
              objectUrl: true,
              sourceBlob: voxel.blob,
              mediaInfo: voxel.mediaInfo || null,
              sourceIdentity: `continuity:${voxel.title || voxel.blob.size}:${voxel.blob.size}`
            });
          } else {
            await app.loadLiveMedia(voxel.src, voxel.title || 'Transferred VoxelVision media', {
              mediaInfo: voxel.mediaInfo || null,
              sourceIdentity: `continuity:${voxel.src}`
            });
          }
        } catch (error) {
          setStatus?.(`VoxelVision state restored, but the loaded video must be reopened: ${error?.message || 'source unavailable'}`);
        }
      }
    }

    applyVoxelSettings(app, doc, voxel);
    await applyMediaState(app.video, voxel.playback);
  }

  async function applySnapshot(snapshot, role = 'embedded') {
    if (!snapshot || snapshot.protocol !== 1) throw new Error('Unsupported WatchFusion continuity snapshot.');
    holdPlaybackGuards();
    window.__watchFusionContinuityApplying = true;
    try {
      await restoreRoomOrSolo(snapshot);
      restoreSimpleUi(snapshot);
      const source = state?.source || snapshot?.source || {};
      if (source.kind === 'media') await restoreDirectMedia(snapshot);
      else if (source.kind === 'youtube' || source.videoId) await restoreYoutube(snapshot);
      else if (source.kind === 'nuvio') await restoreNuvio(snapshot);
      else if (source.kind === 'voxelvision') await restoreVoxel(snapshot);
      document.documentElement.classList.remove('watchfusion-continuity-parked');
      setStatus?.(role === 'detached'
        ? 'Detached from EveOS · state continued here'
        : 'Reattached to EveOS · state continued here');
    } finally {
      setTimeout(() => {
        window.__watchFusionContinuityApplying = false;
        releasePlaybackGuards();
      }, 350);
    }
  }

  window.watchFusionContinuityState = Object.freeze({
    captureSnapshot,
    captureEmergencySnapshot,
    parkCurrentOwner,
    applySnapshot,
    stopRoomTransport
  });
})();
