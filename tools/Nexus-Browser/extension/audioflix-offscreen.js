(() => {
  'use strict';

  const TYPES = Object.freeze({
    start: 'eve.audioflix.tabAudio.offscreen.start',
    stop: 'eve.audioflix.tabAudio.offscreen.stop',
    setVolume: 'eve.audioflix.tabAudio.offscreen.setVolume',
    ended: 'eve.audioflix.tabAudio.offscreen.ended'
  });

  let stream = null;
  let audioContext = null;
  let sourceNode = null;
  let gainNode = null;
  let activeTabId = null;
  let generation = 0;

  const clampVolume = (value, fallback = 1) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(1, parsed));
  };

  async function teardown() {
    generation += 1;
    const oldStream = stream;
    const oldSource = sourceNode;
    const oldGain = gainNode;
    const oldContext = audioContext;

    stream = null;
    sourceNode = null;
    gainNode = null;
    audioContext = null;
    activeTabId = null;

    try { oldSource?.disconnect(); } catch {}
    try { oldGain?.disconnect(); } catch {}
    for (const track of oldStream?.getTracks?.() || []) {
      try { track.stop(); } catch {}
    }
    if (oldContext && oldContext.state !== 'closed') {
      try { await oldContext.close(); } catch {}
    }
  }

  async function start(message) {
    await teardown();

    const tabId = Number(message.tabId);
    if (!Number.isInteger(tabId) || !message.streamId) {
      throw new Error('Missing captured tab stream identity.');
    }

    const localGeneration = generation + 1;
    generation = localGeneration;
    const captured = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: String(message.streamId)
        }
      },
      video: false
    });

    const context = new AudioContext();
    const source = context.createMediaStreamSource(captured);
    const gain = context.createGain();
    gain.gain.value = clampVolume(message.volume);

    source.connect(gain);
    gain.connect(context.destination);

    stream = captured;
    audioContext = context;
    sourceNode = source;
    gainNode = gain;
    activeTabId = tabId;

    if (context.state === 'suspended') await context.resume();

    const audioTrack = captured.getAudioTracks()[0];
    audioTrack?.addEventListener('ended', () => {
      if (generation !== localGeneration) return;
      const endedTabId = activeTabId;
      void teardown().then(() => chrome.runtime.sendMessage({
        type: TYPES.ended,
        tabId: endedTabId,
        reason: 'Captured tab audio ended.'
      }).catch(() => {}));
    }, { once: true });

    return { ok: true, tabId, volume: gain.gain.value };
  }

  function setVolume(value) {
    if (!gainNode || !audioContext) {
      return { ok: false, error: 'AudioFlix tab audio is not active.' };
    }
    const volume = clampVolume(value, gainNode.gain.value);
    gainNode.gain.cancelScheduledValues(audioContext.currentTime);
    gainNode.gain.setTargetAtTime(volume, audioContext.currentTime, 0.015);
    return { ok: true, tabId: activeTabId, volume };
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.target !== 'audioflix-offscreen') return undefined;
    const type = String(message?.type || '');
    if (![TYPES.start, TYPES.stop, TYPES.setVolume].includes(type)) return undefined;

    (async () => {
      if (type === TYPES.start) return start(message);
      if (type === TYPES.setVolume) return setVolume(message.volume);
      await teardown();
      return { ok: true };
    })().then(sendResponse, (error) => {
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
  });
})();
