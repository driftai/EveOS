import { setupPianoFrontendPort } from './piano_frontend_port.js';

const INTERNAL_PLAY_KEY = 'eveos:piano:internal-play:v1';
const TARGET_WINDOW_KEY = 'eveos:piano:target-window:v1';

export function setupPianoFrontendAppBridge(options) {
  const { els, internalMode, current, activeSongId, status, progress, speed, setSpeed } = options;
  try {
    const saved = localStorage.getItem(INTERNAL_PLAY_KEY);
    if (saved === 'true' || saved === 'false') els.internalPlay.checked = saved === 'true';
  } catch (_) {}

  const persistInternalMode = () => {
    try { localStorage.setItem(INTERNAL_PLAY_KEY, String(internalMode())); } catch (_) {}
  };
  const savedTarget = () => {
    try { const value = JSON.parse(localStorage.getItem(TARGET_WINDOW_KEY) || 'null'); return value && typeof value === 'object' ? value : null; }
    catch (_) { return null; }
  };
  const persistTargetWindow = () => {
    const selected = els.window?.selectedOptions?.[0];
    if (!selected) return;
    try { localStorage.setItem(TARGET_WINDOW_KEY, JSON.stringify({ hwnd: String(selected.value || ''), title: String(selected.dataset.title || selected.textContent || '') })); } catch (_) {}
  };
  const restoreTargetWindow = current => {
    const options = [...(els.window?.options || [])], saved = savedTarget();
    const normalized = value => String(value || '').trim().toLowerCase();
    const match = options.find(option => option.value === String(current || ''))
      || options.find(option => saved?.hwnd && option.value === String(saved.hwnd))
      || options.find(option => saved?.title && normalized(option.dataset.title || option.textContent) === normalized(saved.title));
    if (match) els.window.value = match.value;
    return match || null;
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
  return { persistInternalMode, persistTargetWindow, restoreTargetWindow, playbackOwner };
}
