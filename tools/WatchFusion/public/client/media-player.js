let mediaVideo = null;
let hlsInstance = null;
let hlsLoadPromise = null;
let mediaPlayerReady = false;
let mediaLoadedUrl = '';
let mediaEventGuard = 0;
let mediaAnchorKey = '';
let mediaAnchorPosition = 0;
let mediaAnchorLocalTime = 0;
let mediaReplayKey = '';
let hlsNetworkRecoveryAttempts = 0;
let hlsMediaRecoveryAttempts = 0;
const HLS_MAX_RECOVERY_ATTEMPTS = 2;

const HLS_CDN = '/vendor/hls.js';

function isMediaSource(source = state?.source) {
  return source?.kind === 'media' && !!source.url;
}

function ensureMediaElement() {
  if (mediaVideo && document.contains(mediaVideo)) return mediaVideo;
  if (typeof ytPlayer !== 'undefined' && ytPlayer) {
    try { ytPlayer.destroy(); } catch {}
    ytPlayer = null;
    ytPlayerReady = false;
  }
  const host = $('playerHost') || $('player')?.parentElement || document.querySelector('.player.panel') || $('player');
  if (!host) return null;
  host.innerHTML = '<video id="mediaVideo" controls playsinline preload="metadata"></video>';
  mediaVideo = $('mediaVideo');
  if (!mediaVideo) return null;
  mediaVideo.addEventListener('play', onMediaPlay);
  mediaVideo.addEventListener('pause', onMediaPause);
  mediaVideo.addEventListener('seeking', () => {});
  mediaVideo.addEventListener('seeked', onMediaSeeked);
  mediaVideo.addEventListener('ratechange', onMediaRate);
  mediaVideo.addEventListener('ended', onMediaEnded);
  mediaVideo.addEventListener('error', () => setStatus('Media playback error'));
  return mediaVideo;
}

function clearMediaPlayer() {
  mediaReplayKey = '';
  hlsNetworkRecoveryAttempts = 0;
  hlsMediaRecoveryAttempts = 0;
  mediaAnchorKey = '';
  mediaAnchorLocalTime = 0;
  if (hlsInstance) { try { hlsInstance.destroy(); } catch {} hlsInstance = null; }
  if (mediaVideo) {
    withMediaGuard(() => { try { mediaVideo.pause(); mediaVideo.removeAttribute('src'); mediaVideo.load(); } catch {} });
    mediaVideo.remove();
    mediaVideo = null;
  }
  mediaPlayerReady = false;
  mediaLoadedUrl = '';
}

function loadHlsScript() {
  if (window.Hls) return Promise.resolve(window.Hls);
  if (hlsLoadPromise) return hlsLoadPromise;
  hlsLoadPromise = new Promise((resolve, reject) => {
    const existing = document.querySelector(`script[src="${HLS_CDN}"]`);
    if (existing) {
      existing.addEventListener('load', () => resolve(window.Hls), { once: true });
      existing.addEventListener('error', () => reject(new Error('HLS.js failed to load.')), { once: true });
      return;
    }
    const script = document.createElement('script');
    script.src = HLS_CDN;
    script.async = true;
    script.onload = () => resolve(window.Hls);
    script.onerror = () => reject(new Error('HLS.js could not be loaded. Run npm ci and retry.'));
    document.head.appendChild(script);
  });
  return hlsLoadPromise;
}

function installMediaTracks(source) {
  if (!mediaVideo) return;
  mediaVideo.querySelectorAll('track[data-watchparty]').forEach(track => track.remove());
  for (const subtitle of Array.isArray(source?.subtitles) ? source.subtitles : []) {
    const file = String(subtitle.file || '').trim();
    if (!/^https?:\/\//i.test(file)) continue;
    const track = document.createElement('track');
    track.kind = 'subtitles';
    track.label = String(subtitle.label || 'English').slice(0, 80);
    track.srclang = 'en';
    track.src = file;
    track.dataset.watchparty = '1';
    mediaVideo.appendChild(track);
  }
}

function mediaStateKey() {
  const playback = state?.playback;
  return playback ? [playback.updatedAt, playback.projectedAt, playback.position, playback.paused, playback.ended, playback.rate].join('|') : '';
}

function refreshMediaAnchor(force = false) {
  if (!state?.playback) return;
  const key = mediaStateKey();
  if (!force && key && key === mediaAnchorKey) return;
  mediaAnchorKey = key;
  mediaAnchorPosition = Number(state.playback.position) || 0;
  mediaAnchorLocalTime = performance.now();
}

function projectedMediaTarget() {
  const playback = state?.playback;
  if (!playback) return 0;
  if (playback.paused || playback.ended) return Number(playback.position) || 0;
  if (!mediaAnchorLocalTime) refreshMediaAnchor(true);
  const elapsed = Math.max(0, (performance.now() - mediaAnchorLocalTime) / 1000);
  return Math.max(0, mediaAnchorPosition + elapsed * (Number(playback.rate) || 1));
}

function recoverFatalHlsError(Hls, data) {
  if (!data?.fatal || !hlsInstance) return false;
  const type = String(data.type || '');
  if (type === Hls.ErrorTypes?.NETWORK_ERROR && hlsNetworkRecoveryAttempts < HLS_MAX_RECOVERY_ATTEMPTS) {
    hlsNetworkRecoveryAttempts += 1;
    setStatus(`HLS network recovery ${hlsNetworkRecoveryAttempts}/${HLS_MAX_RECOVERY_ATTEMPTS}…`);
    try { hlsInstance.startLoad(); return true; } catch {}
  }
  if (type === Hls.ErrorTypes?.MEDIA_ERROR && hlsMediaRecoveryAttempts < HLS_MAX_RECOVERY_ATTEMPTS) {
    hlsMediaRecoveryAttempts += 1;
    setStatus(`HLS media recovery ${hlsMediaRecoveryAttempts}/${HLS_MAX_RECOVERY_ATTEMPTS}…`);
    try { hlsInstance.recoverMediaError(); return true; } catch {}
  }
  return false;
}

function waitForMediaReady(video, timeoutMs = 10000) {
  if (video.readyState >= 1) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const started = performance.now();
    let timer = null;
    const done = ok => {
      video.removeEventListener('loadedmetadata', onReady);
      video.removeEventListener('canplay', onReady);
      if (timer) clearInterval(timer);
      ok ? resolve() : reject(new Error('Media source did not become playable in time.'));
    };
    const onReady = () => done(true);
    video.addEventListener('loadedmetadata', onReady, { once: true });
    video.addEventListener('canplay', onReady, { once: true });
    timer = setInterval(() => {
      if (video.readyState >= 1) done(true);
      else if (performance.now() - started >= timeoutMs) done(false);
    }, 100);
  });
}

function resolvePlayableStreamUrl(source) {
  if (!source?.url) return '';
  const url = String(source.url);
  if (url.startsWith('/') || url.includes(window.location.host) || url.includes('test-streams.mux.dev')) return url;
  let referer = String(source.referer || source.originalUrl || '').trim();
  if (!referer || referer.includes('.watami.win') || referer.includes('.piltover.li') || referer.includes('.m3u8')) {
    referer = 'https://www.miruro.ru/';
  }
  return apiUrl(`/api/media/stream?url=${encodeURIComponent(url)}&referer=${encodeURIComponent(referer)}`);
}

async function ensureMediaSource(source) {
  if (!isMediaSource(source)) return false;
  const url = String(source.url);
  if (mediaLoadedUrl === url && mediaPlayerReady) {
    refreshMediaAnchor(false);
    if (roomId && !isHost()) syncMediaPlayer();
    return true;
  }
  clearMediaPlayer();
  const video = ensureMediaElement();
  if (!video) return false;
  mediaLoadedUrl = url;
  mediaPlayerReady = false;
  setStatus('Loading media…');
  installMediaTracks(source);
  try {
    const playUrl = resolvePlayableStreamUrl(source);
    const lower = url.toLowerCase().split('?')[0];
    if (lower.endsWith('.m3u8')) {
      const Hls = await loadHlsScript().catch(() => null);
      if (Hls?.isSupported?.()) {
        hlsInstance = new Hls({ enableWorker: true, lowLatencyMode: false, backBufferLength: 30, maxBufferLength: 45 });
        hlsInstance.on(Hls.Events.ERROR, (_, data) => {
          if (!data?.fatal) return;
          if (recoverFatalHlsError(Hls, data)) return;
          setStatus(`HLS error: ${data.type || 'fatal'}`);
        });
        hlsInstance.on(Hls.Events.MANIFEST_PARSED, () => {
          hlsNetworkRecoveryAttempts = 0;
          hlsMediaRecoveryAttempts = 0;
          mediaPlayerReady = true;
          refreshMediaAnchor(true);
          if (roomId && !isHost()) syncMediaPlayer();
        });
        hlsInstance.loadSource(playUrl);
        hlsInstance.attachMedia(video);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = playUrl;
      } else {
        throw new Error('This browser cannot play HLS.');
      }
    } else {
      video.src = playUrl;
    }
    await waitForMediaReady(video);
    mediaPlayerReady = true;
    refreshMediaAnchor(true);
    restoreMediaAudioPrefs();
    if (roomId && !isHost()) syncMediaPlayer();
    setStatus(source.title ? `Ready · ${source.title}` : 'Media ready');
    return true;
  } catch (error) {
    mediaPlayerReady = false;
    setStatus(error?.message || 'Media player failed to initialize.');
    return false;
  }
}

function currentMediaPosition() { return Number(mediaVideo?.currentTime) || 0; }
function mediaDuration() { return Number(mediaVideo?.duration) || 0; }
function mediaPlaybackState() { return { position: currentMediaPosition(), rate: Number(mediaVideo?.playbackRate) || 1, paused: !!mediaVideo?.paused, ended: !!mediaVideo?.ended }; }
function restoreMediaAudioPrefs() { if (!mediaVideo) return; mediaVideo.volume = Math.max(0, Math.min(1, Number(playerAudioPrefs?.volume ?? 100) / 100)); mediaVideo.muted = !!playerAudioPrefs?.muted; }

function withMediaGuard(fn) {
  mediaEventGuard += 1;
  try { return fn(); } finally { mediaEventGuard = Math.max(0, mediaEventGuard - 1); }
}
function authoritativeRoomPlay(position = 0) { if (!isHost()) return; command('play', { position }); }
function authoritativeRoomPause(position = currentMediaPosition(), ended = false) { if (!isHost()) return; command('pause', { position, ended }); }
function onMediaPlay() {
  if (mediaEventGuard || !isHost() || !state) return;
  const replaying = !!state.playback?.ended || !!mediaVideo?.ended;
  if (replaying) {
    withMediaGuard(() => { try { mediaVideo.currentTime = 0; } catch {} });
    refreshMediaAnchor(true);
  }
  authoritativeRoomPlay(replaying ? 0 : currentMediaPosition());
}
function onMediaPause() { if (mediaEventGuard || !isHost() || !state || mediaVideo?.ended) return; authoritativeRoomPause(currentMediaPosition(), false); }
function onMediaSeeked() { if (mediaEventGuard || !isHost() || !state) return; command('seek', { position: currentMediaPosition() }); }
function onMediaRate() { if (mediaEventGuard || !isHost() || !state) return; command('rate', { rate: mediaVideo?.playbackRate || 1 }); }
function onMediaEnded() { if (mediaEventGuard || !isHost() || !state) return; authoritativeRoomPause(Math.max(currentMediaPosition(), mediaDuration()), true); }

function replayViewerFromTerminal(target) {
  const key = mediaStateKey();
  if (!key || key === mediaReplayKey || !state?.source?.url) return false;
  mediaReplayKey = key;
  const startSeconds = Math.max(0, Number(target) || 0);
  withMediaGuard(() => {
    try {
      mediaVideo.currentTime = startSeconds;
      const playPromise = mediaVideo.play();
      playPromise?.catch?.(() => setStatus('Tap the video once to allow playback.'));
    } catch {}
  });
  refreshMediaAnchor(true);
  return true;
}

function syncMediaPlayer(options = {}) {
  if (!roomId || !isMediaSource() || !mediaVideo || !mediaPlayerReady || isHost()) return;
  refreshMediaAnchor(false);
  const playback = state.playback || {};
  const target = projectedMediaTarget();
  const current = currentMediaPosition();
  const drift = target - current;
  const baseRate = Math.min(2, Math.max(0.25, Number(playback.rate) || 1));

  try {
    withMediaGuard(() => {
      mediaVideo.playbackRate = baseRate;
      if (playback.ended) {
        const terminal = Number.isFinite(mediaVideo.duration) ? Math.min(target, mediaVideo.duration || target) : target;
        if (Math.abs(current - terminal) > 0.25 && mediaVideo.readyState >= 1) mediaVideo.currentTime = Math.max(0, terminal);
        mediaVideo.pause();
        return;
      }

      if (playback.paused) {
        if (Math.abs(drift) > 0.35 && mediaVideo.readyState >= 1) mediaVideo.currentTime = Math.max(0, target);
        mediaVideo.pause();
        return;
      }

      if (mediaVideo.ended) {
        replayViewerFromTerminal(0);
        return;
      }

      if (Math.abs(drift) > 2.5 || options.force) mediaVideo.currentTime = Math.max(0, target);
      else if (Math.abs(drift) > 0.75) mediaVideo.playbackRate = drift > 0 ? Math.min(2, baseRate + 0.25) : Math.max(0.5, baseRate - 0.25);
      mediaVideo.play()?.catch?.(() => setStatus('Tap the video once to allow playback.'));
    });
  } catch (error) { setStatus(error?.message || 'Media synchronization error.'); }
}

window.mediaPlayback = { ensureSource: ensureMediaSource, sync: syncMediaPlayer, position: currentMediaPosition, state: mediaPlaybackState, clear: clearMediaPlayer };
setInterval(() => { try { if (roomId && isMediaSource() && !isHost() && mediaPlayerReady) syncMediaPlayer(); } catch {} }, 500);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && roomId && isMediaSource() && !isHost()) { refreshMediaAnchor(true); syncMediaPlayer(); } });
