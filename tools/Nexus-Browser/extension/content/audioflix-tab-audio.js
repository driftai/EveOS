(() => {
  'use strict';

  if (globalThis.__eveAudioflixTabAudioContent) return;
  globalThis.__eveAudioflixTabAudioContent = true;

  const TYPES = Object.freeze({
    setVolume: 'eve.audioflix.tabAudio.setVolume',
    readVolume: 'eve.audioflix.tabAudio.readPageVolume'
  });
  const SLIDER_SELECTOR = '.audioflix-volume-slider, .audioflix-provider-volume';
  let lastVolume = null;

  const normalizeSliderVolume = (input) => {
    if (!input || !input.matches?.(SLIDER_SELECTOR)) return null;
    const value = Number(input.value);
    if (!Number.isFinite(value)) return null;
    const maxAttr = input.getAttribute?.('max');
    const max = maxAttr == null || maxAttr === '' ? null : Number(maxAttr);
    const normalized = Number.isFinite(max) && max > 1 ? value / max : value;
    return Math.max(0, Math.min(1, normalized));
  };

  function publishVolume(input) {
    const volume = normalizeSliderVolume(input);
    if (volume === null) return;
    lastVolume = volume;
    chrome.runtime.sendMessage({
      type: TYPES.setVolume,
      source: 'audioflix-page',
      volume
    }).catch(() => {
      // Capture is optional; the ordinary AudioFlix slider must continue working without it.
    });
  }

  document.addEventListener('input', (event) => {
    if (event.target?.matches?.(SLIDER_SELECTOR)) publishVolume(event.target);
  }, true);

  document.addEventListener('change', (event) => {
    if (event.target?.matches?.(SLIDER_SELECTOR)) publishVolume(event.target);
  }, true);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== TYPES.readVolume) return undefined;
    if (lastVolume === null) {
      for (const slider of document.querySelectorAll(SLIDER_SELECTOR)) {
        const volume = normalizeSliderVolume(slider);
        if (volume !== null) {
          lastVolume = volume;
          break;
        }
      }
    }
    sendResponse({
      ok: lastVolume !== null,
      volume: lastVolume
    });
    return false;
  });
})();
