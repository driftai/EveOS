let mediaVideo = null;
let hlsInstance = null;
let hlsLoadPromise = null;
let mediaEnsurePromise = null;
let mediaEnsureUrl = '';
let mediaPlayerReady = false;
let mediaLoadedUrl = '';
let mediaEventGuard = 0;
let mediaAnchorKey = '';
let mediaAnchorPosition = 0;
let mediaAnchorServerTime = 0, mediaAnchorRate = 0, mediaAnchorScope = "";
let mediaConvergence, mediaSeek, mediaPlay, mediaSyncSeeks = 0, mediaSyncAction = 'idle';
let mediaAttachedGuardUntil = 0;
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
  window.watchFusionYoutubeLayout?.deactivate?.();
  if (typeof ytPlayer !== 'undefined' && ytPlayer) {
    try { ytPlayer.destroy(); } catch {}
    ytPlayer = null;
    ytPlayerReady = false;
  }
  const host = $('playerHost') || $('player')?.parentElement || document.querySelector('.player.panel') || $('player');
  if (!host) return null;
  mediaVideo = document.createElement('video');
  mediaVideo.id = 'mediaVideo';
  mediaVideo.controls = true;
  mediaVideo.playsInline = true;
  mediaVideo.preload = 'metadata';
  host.prepend(mediaVideo);
  if (!mediaVideo) return null;
  mediaVideo.addEventListener('play', onMediaPlay);
  mediaVideo.addEventListener('pause', onMediaPause);
  mediaVideo.addEventListener('seeking', () => {});
  mediaVideo.addEventListener('seeked', onMediaSeeked);
  mediaVideo.addEventListener('ratechange', onMediaRate);
  mediaVideo.addEventListener('volumechange', onMediaVolume);
  mediaVideo.addEventListener('ended', onMediaEnded);
  mediaVideo.addEventListener('error', () => setStatus('Media playback error'));
  return mediaVideo;
}

function clearMediaPlayer() {
  mediaReplayKey = '';
  hlsNetworkRecoveryAttempts = 0;
  hlsMediaRecoveryAttempts = 0;
  mediaAnchorKey = '';
  mediaAnchorServerTime = 0;
  mediaConvergence?.reset();
  mediaSeek = mediaPlay = null;
  if (hlsInstance) { try { hlsInstance.destroy(); } catch {} hlsInstance = null; }
  if (mediaVideo) {
    withMediaGuard(() => { try { mediaVideo.pause(); mediaVideo.removeAttribute('src'); mediaVideo.load(); } catch {} });
    mediaVideo.remove();
    mediaVideo = null;
  }
  mediaPlayerReady = false;
  mediaLoadedUrl = '';
  mediaEnsurePromise = null;
  mediaEnsureUrl = '';
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
  return playback ? [roomId, state?.source?.url, playback.updatedAt, playback.paused, playback.ended, playback.rate].join('|') : '';
}

function refreshMediaAnchor(force = false) {
  if (!state?.playback) return;
  const key = mediaStateKey();
  if (!force && key && key === mediaAnchorKey) return;
  const position = Number(state.playback.position) || 0;
  const at = Number(state.playback.projectedAt) || Number(state.serverTime) || estimatedServerNow();
  const rate = state.playback.paused || state.playback.ended ? 0 : Number(state.playback.rate) || 1;
  const scope = roomId + ':' + state?.source?.url;
  const oldPosition = mediaAnchorPosition + Math.max(0, at - mediaAnchorServerTime) / 1000 * mediaAnchorRate;
  if (scope !== mediaAnchorScope || rate !== mediaAnchorRate || Math.abs(position - oldPosition) > .6) {
    mediaConvergence?.reset();
    mediaSeek = null;
  }
  mediaAnchorScope = scope;
  mediaAnchorRate = rate;
  mediaAnchorKey = key;
  mediaAnchorPosition = position;
  mediaAnchorServerTime = at;
}

function projectedMediaTarget() {
  const playback = state?.playback;
  if (!playback) return 0;
  if (playback.paused || playback.ended) return Number(playback.position) || 0;
  if (!mediaAnchorServerTime) refreshMediaAnchor(true);
  const elapsed = Math.max(0, (estimatedServerNow() - mediaAnchorServerTime) / 1000);
  return Math.max(0, mediaAnchorPosition + elapsed * (Number(playback.rate) || 1));
}

function hlsConfigForSource(source) {
  const youtubeDirect = source?.provider === 'youtube-direct' || source?.server === 'youtube-direct';
  return {
    enableWorker: true,
    lowLatencyMode: false,
    backBufferLength: 30,
    maxBufferLength: youtubeDirect ? 60 : 45,
    ...(youtubeDirect ? {
      maxMaxBufferLength: 120,
      startLevel: -1,
      testBandwidth: true,
      capLevelToPlayerSize: true,
      ignoreDevicePixelRatio: true,
      capLevelOnFPSDrop: true,
      abrBandWidthFactor: 0.80,
      abrBandWidthUpFactor: 0.55,
      abrMaxWithRealBitrate: true,
      maxStarvationDelay: 2,
      maxLoadingDelay: 2
    } : {})
  };
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
  if (mediaEnsurePromise && mediaEnsureUrl === url) return mediaEnsurePromise;
  const pending = loadMediaSource(source);
  mediaEnsureUrl = url;
  mediaEnsurePromise = pending;
  try { return await pending; }
  finally {
    if (mediaEnsurePromise === pending) { mediaEnsurePromise = null; mediaEnsureUrl = ''; }
  }
}

async function loadMediaSource(source) {
  if (!isMediaSource(source)) return false;
  const url = String(source.url);
  if (mediaLoadedUrl === url && mediaPlayerReady) {
    refreshMediaAnchor(false);
    if (roomId && followsRoomPlayback()) syncMediaPlayer();
    return true;
  }
  clearMediaPlayer();
  const video = ensureMediaElement();
  if (!video) return false;
  mediaLoadedUrl = url;
  mediaPlayerReady = false; mediaSyncSeeks = 0; mediaSyncAction = 'loading';
  setStatus('Loading media…');
  installMediaTracks(source);
  try {
    const playUrl = resolvePlayableStreamUrl(source);
    const lower = url.toLowerCase().split('?')[0];
    if (lower.endsWith('.m3u8')) {
      const Hls = await loadHlsScript().catch(() => null);
      if (Hls?.isSupported?.()) {
        hlsInstance = new Hls(hlsConfigForSource(source));
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
          if (roomId && followsRoomPlayback()) syncMediaPlayer();
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
    if (!applyRoomMediaAudio()) restoreMediaAudioPrefs();
    if (roomId && followsRoomPlayback()) syncMediaPlayer();
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
async function restoreMediaPlayback(options={}) {
  if(!mediaVideo||!mediaPlayerReady)return false;
  const position=Math.max(0,Number(options.position)||0),paused=options.paused===true;
  withMediaGuard(()=>{try{mediaVideo.currentTime=position;}catch{}});
  if(paused)withMediaGuard(()=>mediaVideo.pause());
  else {try{await mediaVideo.play();}catch{setStatus('Cached video is ready · press Play once to continue.');}}
  return true;
}
function restoreMediaAudioPrefs() { if (!mediaVideo) return; mediaVideo.volume = Math.max(0, Math.min(1, Number(playerAudioPrefs?.volume ?? 100) / 100)); mediaVideo.muted = !!playerAudioPrefs?.muted; }
function applyRoomMediaAudio() {
  const audio = authoritativeRoomAudio();
  if (!mediaVideo || !audio) return false;
  roomAudioGuardUntil = performance.now() + 650;
  try {
    const volume = audio.volume / 100;
    if (Math.abs(mediaVideo.volume - volume) > 0.005) mediaVideo.volume = volume;
    if (mediaVideo.muted !== audio.muted) mediaVideo.muted = audio.muted;
  } catch {}
  return true;
}
function onMediaVolume() {
  if (!mediaVideo || performance.now() < roomAudioGuardUntil) return;
  if (window.watchFusionLinkedTab?.active?.() && !window.watchFusionLinkedTab?.applying?.() && performance.now() >= mediaAttachedGuardUntil) {
    window.watchFusionLinkedTab.control('volume', mediaVideo.muted ? 0 : mediaVideo.volume);
    return;
  }
  playerAudioPrefs = { volume: Math.round(mediaVideo.volume * 100), muted: !!mediaVideo.muted };
  storage.set(PLAYER_AUDIO_PREFS_KEY, JSON.stringify(playerAudioPrefs));
  if (roomId && isHost()) publishRoomAudioState(playerAudioPrefs.volume, playerAudioPrefs.muted);
}

function withMediaGuard(fn) {
  mediaEventGuard += 1;
  try { return fn(); } finally { mediaEventGuard = Math.max(0, mediaEventGuard - 1); }
}
function authoritativeRoomPlay(position = 0) { if (followsRoomPlayback()) return; command('play', { position }); }
function authoritativeRoomPause(position = currentMediaPosition(), ended = false) { if (followsRoomPlayback()) return; command('pause', { position, ended }); }
function attachedMediaControl(action, value) {
  if (!window.watchFusionLinkedTab?.active?.() || window.watchFusionLinkedTab?.applying?.() || performance.now() < mediaAttachedGuardUntil) return false;
  window.watchFusionLinkedTab.control(action, value); return true;
}
function onMediaPlay() {
  if (mediaEventGuard || !isHost() || !state) return;
  if (attachedMediaControl('play', currentMediaPosition())) return;
  const replaying = !!state.playback?.ended || !!mediaVideo?.ended;
  if (replaying) {
    withMediaGuard(() => { try { mediaVideo.currentTime = 0; } catch {} });
    refreshMediaAnchor(true);
  }
  authoritativeRoomPlay(replaying ? 0 : currentMediaPosition());
}
function onMediaPause() { if (mediaEventGuard || !isHost() || !state || mediaVideo?.ended) return; if(!attachedMediaControl('pause',currentMediaPosition()))authoritativeRoomPause(currentMediaPosition(), false); }
function onMediaSeeked() { if (mediaEventGuard || !isHost() || !state) return; if(!attachedMediaControl('seek',currentMediaPosition())&&!followsRoomPlayback())command('seek', { position: currentMediaPosition(), paused: mediaVideo?.paused === true }); }
function onMediaRate() { if (mediaEventGuard || !isHost() || !state) return; if(!attachedMediaControl('rate',mediaVideo?.playbackRate||1)&&!followsRoomPlayback())command('rate', { rate: mediaVideo?.playbackRate || 1 }); }
function onMediaEnded() { if (mediaEventGuard || !isHost() || !state) return; authoritativeRoomPause(Math.max(currentMediaPosition(), mediaDuration()), true); }

function replayViewerFromTerminal(target) {
  const key = mediaStateKey();
  if (!key || key === mediaReplayKey || !state?.source?.url) return false;
  mediaReplayKey = key;
  const startSeconds = Math.max(0, Number(target) || 0);
  withMediaGuard(() => {
    try {
      window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
      mediaVideo.currentTime = startSeconds;
      const playPromise = mediaVideo.play();
      playPromise?.catch?.(() => setStatus('Tap the video once to allow playback.'));
    } catch {}
  });
  refreshMediaAnchor(true);
  return true;
}

function syncMediaPlayer(options = {}) {
  if (!roomId || !isMediaSource() || !mediaVideo || !mediaPlayerReady || !followsRoomPlayback()) return;

  refreshMediaAnchor(false);
  const playback = state.playback || {}, video = mediaVideo;
  const speakerTiming = window.watchFusionPresentation?.active?.();
  const delay = playback.paused || playback.ended ? 0 : (speakerTiming?.adjustmentMs || 0) * mediaAnchorRate / 1000;
  const position = projectedMediaTarget();
  const target = Math.max(0, Math.min((window.watchFusionPlayout?.position(position, 'direct') ?? position) - delay, video.duration > 0 ? video.duration : Infinity));
  const drift = target - currentMediaPosition();
  const baseRate = Math.min(2, Math.max(0.25, Number(playback.rate) || 1));
  const now = performance.now(), force = options.force === true;
  const buffering = video.seeking || video.readyState < 3;
  if (mediaSeek && Math.abs(drift) < .25 && !buffering) mediaSeek = null;
  const sourceStalled = window.watchFusionPlayout?.sourceBuffering() === true;
  const canSeek = video.readyState >= 1 && (force || (!sourceStalled && !video.seeking && !mediaSeek));
  mediaSyncAction = buffering ? 'buffering' : 'steady';
  const seek = () => {
    mediaSeek = true; mediaSyncSeeks++; mediaSyncAction = force ? 'manual-sync' : 'seek';
    window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
    video.currentTime = target;
    mediaConvergence.reset();
  };
  if (!mediaConvergence) mediaConvergence = window.WatchFusionLinkedPlaybackSync.createMediaConvergence();

  try {
    withMediaGuard(() => {
      applyRoomMediaAudio();
      let rate = baseRate;
      if (playback.ended || playback.paused) {
        if (!video.paused) { window.watchFusionLinkedTab?.suppressPlaybackEcho?.(); video.pause(); }
        if (canSeek && Math.abs(drift) > .35) seek();
        mediaConvergence.reset();
      } else if (video.ended && !force) {
        if (target < video.duration - .25 && !buffering) replayViewerFromTerminal(target);
      } else {
        if (canSeek && (force || (!buffering && Math.abs(drift) > 1.25))) seek();
        else if (buffering || sourceStalled || video.paused || mediaSeek) mediaConvergence.reset();
        else rate = mediaConvergence.rate(baseRate, drift, now, speakerTiming ? speakerTiming.uncertaintyMs / 1000 : window.watchFusionPlayout?.precision('direct'));
        if (video.paused && now >= (mediaPlay || 0)) {
          mediaPlay = now + 1000;
          window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
          video.play()?.catch?.(() => { if (mediaVideo === video) setStatus('Tap the video once to allow playback.'); });
        }
      }
      if (rate !== baseRate) mediaSyncAction = 'rate-correction';
      if (Math.abs(video.playbackRate - rate) > .002) {
        window.watchFusionLinkedTab?.suppressPlaybackEcho?.();
        video.playbackRate = rate;
      }
    });
  } catch (error) { setStatus(error?.message || 'Media synchronization error.'); }
}

function followAttachedMedia(metadata = {}, options = {}) {
  if (!mediaVideo || !mediaPlayerReady) return false;
  const plan=window.WatchFusionLinkedPlaybackSync?.mediaPlan?.(metadata,currentMediaPosition(),options);
  if(!plan)return false;
  const volume=Number(metadata.volume),targetVolume=Number.isFinite(volume)?Math.max(0,Math.min(1,volume)):null;
  const seek=plan.seek&&mediaVideo.readyState>=1;
  const rateChanged=Math.abs((Number(mediaVideo.playbackRate)||1)-plan.rate)>.01;
  const volumeChanged=targetVolume!==null&&Math.abs(mediaVideo.volume-targetVolume)>.01;
  const pauseChanged=plan.paused?!mediaVideo.paused:mediaVideo.paused;
  if(!seek&&!rateChanged&&!volumeChanged&&!pauseChanged)return true;
  mediaAttachedGuardUntil=performance.now()+450;
  withMediaGuard(()=>{
    if(seek)mediaVideo.currentTime=plan.target;
    if(rateChanged)mediaVideo.playbackRate=plan.rate;
    if(volumeChanged)mediaVideo.volume=targetVolume;
    if(plan.paused){if(!mediaVideo.paused)mediaVideo.pause();}
    else if(mediaVideo.paused)mediaVideo.play()?.catch?.(()=>setStatus('Tap the video once to allow playback.'));
  });
  return true;
}
window.mediaPlayback = { ensureSource: ensureMediaSource, sync: syncMediaPlayer, followAttached: followAttachedMedia, position: currentMediaPosition, state: mediaPlaybackState, restore: restoreMediaPlayback, clear: clearMediaPlayer };
setInterval(() => { try { syncMediaPlayer(); } catch {} }, 250);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && roomId && isMediaSource() && followsRoomPlayback()) { refreshMediaAnchor(true); syncMediaPlayer(); } });
