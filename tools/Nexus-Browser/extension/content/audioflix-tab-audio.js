(() => {
  'use strict';

  if (globalThis.__eveAudioflixTabAudioContent) return;
  globalThis.__eveAudioflixTabAudioContent = true;

  const TYPES = Object.freeze({
    setVolume: 'eve.audioflix.tabAudio.setVolume',
    readVolume: 'eve.audioflix.tabAudio.readPageVolume'
  });
  // The page (audioflix.tab-gain-owner.js) publishes which item may drive the captured-tab gain.
  // Only the official Spotify embed has no volume API of its own; every other AudioFlix transport
  // already applies its slider, so the tab gain must stay at unity for them to avoid attenuating
  // twice. An older EveOS page without the owner contract keeps the gain at unity too.
  const OWNER_ATTR = 'data-af-tab-gain-owner';
  const VOLUME_ATTR = 'data-af-tab-gain-volume';
  const ITEM_SLIDER = '.audioflix-volume-slider';
  const PROVIDER_SLIDER = '.audioflix-provider-volume';
  let lastSent = null;

  const clamp = (value, fallback = 1) => {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback;
  };

  const owner = () => document.documentElement?.getAttribute(OWNER_ATTR) || '';

  function targetVolume() {
    if (!owner()) return 1;
    return clamp(document.documentElement.getAttribute(VOLUME_ATTR), 1);
  }

  function sliderVolume(input) {
    const value = Number(input.value);
    if (!Number.isFinite(value)) return null;
    const maxAttr = input.getAttribute?.('max');
    const max = maxAttr == null || maxAttr === '' ? null : Number(maxAttr);
    return clamp(Number.isFinite(max) && max > 1 ? value / max : value);
  }

  function send(volume) {
    const level = clamp(volume);
    if (lastSent === level) return;
    lastSent = level;
    chrome.runtime.sendMessage({
      type: TYPES.setVolume,
      source: 'audioflix-page',
      volume: level
    }).catch(() => {
      // Capture is optional; the ordinary AudioFlix slider must continue working without it.
      lastSent = null;
    });
  }

  function onSlider(event) {
    const input = event.target;
    const current = owner();
    if (!current || !input?.matches) return;
    // Only the playing Spotify item's own slider (or the provider stage slider while Spotify owns
    // the gain) may move the tab gain. Sliders on queued/idle cards never touch it.
    if (input.matches(ITEM_SLIDER) && String(input.dataset.afId ?? '') !== current) return;
    if (!input.matches(ITEM_SLIDER) && !input.matches(PROVIDER_SLIDER)) return;
    const volume = sliderVolume(input);
    if (volume !== null) send(volume);
  }

  document.addEventListener('input', onSlider, true);
  document.addEventListener('change', onSlider, true);

  // Track ownership changes: a non-Spotify track (or end of playback) returns the gain to unity,
  // and the next Spotify track re-applies its own saved volume.
  const root = document.documentElement;
  if (root && typeof MutationObserver === 'function') {
    new MutationObserver(() => send(targetVolume()))
      .observe(root, { attributes: true, attributeFilter: [OWNER_ATTR, VOLUME_ATTR] });
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== TYPES.readVolume) return undefined;
    const volume = targetVolume();
    lastSent = volume;
    sendResponse({ ok: true, volume });
    return false;
  });
})();
