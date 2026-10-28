import { setupPianoFrontendPort } from './piano_frontend_port.js';

const INTERNAL_PLAY_KEY = 'eveos:piano:internal-play:v1';

export function setupPianoFrontendAppBridge(options) {
  const { els, internalMode, current, activeSongId, status, progress, speed, setSpeed } = options;
  try {
    const saved = localStorage.getItem(INTERNAL_PLAY_KEY);
    if (saved === 'true' || saved === 'false') els.internalPlay.checked = saved === 'true';
  } catch (_) {}

  const persistInternalMode = () => {
    try { localStorage.setItem(INTERNAL_PLAY_KEY, String(internalMode())); } catch (_) {}
  };
  const media = () => {
    const position = progress();
    return { ...current(), activeSongId: activeSongId(), status: status().status, index: position.index, total: position.total, speed: speed() };
  };
  const preset = name => {
    const speeds = { natural: 1, fast: 1.5, slow: 0.65 };
    if (Object.prototype.hasOwnProperty.call(speeds, name)) setSpeed(speeds[name]);
    else if (name !== 'custom') throw new Error('Unknown Piano playback preset.');
    return { name, speed: speed() };
  };
  const playbackOwner = Object.freeze({
    playSong: (song, playbackOptions = {}) => options.play(song, playbackOptions),
    pause: () => options.pause(),
    stop: () => options.stop(),
    status: () => options.status()
  });
  window.PianoPlaybackOwner = playbackOwner;

  setupPianoFrontendPort({ ...options, media, preset });
  return { persistInternalMode, playbackOwner };
}
