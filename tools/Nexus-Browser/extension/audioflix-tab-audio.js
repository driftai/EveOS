(() => {
  'use strict';

  if (globalThis.__eveAudioflixTabAudioBridge) return;

  const TYPES = Object.freeze({
    status: 'eve.audioflix.tabAudio.status',
    start: 'eve.audioflix.tabAudio.start',
    stop: 'eve.audioflix.tabAudio.stop',
    setVolume: 'eve.audioflix.tabAudio.setVolume',
    state: 'eve.audioflix.tabAudio.state',
    readPageVolume: 'eve.audioflix.tabAudio.readPageVolume',
    offscreenStart: 'eve.audioflix.tabAudio.offscreen.start',
    offscreenStop: 'eve.audioflix.tabAudio.offscreen.stop',
    offscreenSetVolume: 'eve.audioflix.tabAudio.offscreen.setVolume',
    offscreenEnded: 'eve.audioflix.tabAudio.offscreen.ended'
  });

  const STORAGE_KEY = 'eveAudioflixTabAudioState';
  const OFFSCREEN_URL = 'audioflix-offscreen.html';
  const DEFAULT_STATE = Object.freeze({
    active: false,
    tabId: null,
    volume: 1,
    startedAt: '',
    lastError: ''
  });

  let cachedState = null;
  let offscreenCreatePromise = null;

  const clampVolume = (value, fallback = 1) => {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(0, Math.min(1, parsed));
  };

  const publicState = (value) => ({
    active: value?.active === true,
    tabId: Number.isInteger(value?.tabId) ? value.tabId : null,
    volume: clampVolume(value?.volume, 1),
    startedAt: String(value?.startedAt || ''),
    lastError: String(value?.lastError || '')
  });

  async function loadState() {
    if (cachedState) return cachedState;
    try {
      const stored = await chrome.storage.session.get(STORAGE_KEY);
      cachedState = publicState({ ...DEFAULT_STATE, ...(stored?.[STORAGE_KEY] || {}) });
    } catch {
      cachedState = publicState(DEFAULT_STATE);
    }
    return cachedState;
  }

  async function saveState(patch) {
    const current = await loadState();
    cachedState = publicState({ ...current, ...patch });
    try {
      await chrome.storage.session.set({ [STORAGE_KEY]: cachedState });
    } catch {
      // The live bridge still works if session persistence is temporarily unavailable.
    }
    try {
      await chrome.runtime.sendMessage({ type: TYPES.state, state: cachedState });
    } catch {
      // The popup is usually closed; state broadcasts are best-effort.
    }
    return cachedState;
  }

  async function hasOffscreenDocument() {
    if (typeof chrome.runtime.getContexts !== 'function') return false;
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
      documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
    });
    return contexts.length > 0;
  }

  async function ensureOffscreenDocument() {
    if (await hasOffscreenDocument()) return;
    if (!offscreenCreatePromise) {
      offscreenCreatePromise = chrome.offscreen.createDocument({
        url: OFFSCREEN_URL,
        reasons: ['USER_MEDIA'],
        justification: 'Route captured EveOS tab audio through the AudioFlix volume gain.'
      }).finally(() => {
        offscreenCreatePromise = null;
      });
    }
    await offscreenCreatePromise;
  }

  async function closeOffscreenDocument() {
    try {
      if (await hasOffscreenDocument()) await chrome.offscreen.closeDocument();
    } catch {
      // Closing is cleanup only; do not turn a successful stop into an error.
    }
  }

  async function readPageVolume(tabId) {
    try {
      const response = await chrome.tabs.sendMessage(tabId, { type: TYPES.readPageVolume });
      if (response?.ok && Number.isFinite(Number(response.volume))) {
        return clampVolume(response.volume);
      }
    } catch {
      // file:// slider sync is optional and can be disabled in extension settings.
    }
    return null;
  }

  async function setVolume(value, { source = 'unknown', tabId = null } = {}) {
    const current = await loadState();
    if (current.active && Number.isInteger(tabId) && tabId !== current.tabId) {
      return { ok: true, ignored: true, source, state: current };
    }
    const volume = clampVolume(value, current.volume);
    if (current.active) {
      try {
        const response = await chrome.runtime.sendMessage({
          type: TYPES.offscreenSetVolume,
          target: 'audioflix-offscreen',
          volume
        });
        if (response?.ok === false) throw new Error(response.error || 'Audio gain update failed.');
      } catch (error) {
        return {
          ok: false,
          error: String(error?.message || error),
          state: await saveState({ lastError: String(error?.message || error) })
        };
      }
    }
    return { ok: true, source, state: await saveState({ volume, lastError: '' }) };
  }

  async function stopCapture(reason = 'user') {
    const current = await loadState();
    try {
      if (await hasOffscreenDocument()) {
        await chrome.runtime.sendMessage({
          type: TYPES.offscreenStop,
          target: 'audioflix-offscreen',
          reason
        });
      }
    } catch {
      // The stream may already be gone. State still needs to become inactive.
    }
    await closeOffscreenDocument();
    return {
      ok: true,
      state: await saveState({
        active: false,
        tabId: null,
        startedAt: '',
        lastError: ''
      })
    };
  }

  async function startCapture(tabId, requestedVolume) {
    if (!Number.isInteger(tabId) || tabId < 0) {
      return { ok: false, error: 'A valid active tab is required.', state: await loadState() };
    }

    const current = await loadState();
    if (current.active && current.tabId === tabId) {
      return setVolume(requestedVolume, { source: 'start-existing', tabId });
    }
    if (current.active && current.tabId !== tabId) {
      await stopCapture('switch-tab');
    }

    let streamId = '';
    try {
      // Keep this as the first substantial operation after the popup request so Chrome can tie
      // tabCapture permission to the user's explicit extension interaction.
      streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
      const pageVolume = await readPageVolume(tabId);
      const volume = pageVolume ?? clampVolume(requestedVolume, current.volume);
      await ensureOffscreenDocument();

      const response = await chrome.runtime.sendMessage({
        type: TYPES.offscreenStart,
        target: 'audioflix-offscreen',
        streamId,
        tabId,
        volume
      });
      if (!response?.ok) throw new Error(response?.error || 'The offscreen audio route did not start.');

      return {
        ok: true,
        state: await saveState({
          active: true,
          tabId,
          volume,
          startedAt: new Date().toISOString(),
          lastError: ''
        })
      };
    } catch (error) {
      await closeOffscreenDocument();
      const message = String(error?.message || error || 'Could not capture this tab.');
      return {
        ok: false,
        error: message,
        state: await saveState({
          active: false,
          tabId: null,
          startedAt: '',
          lastError: message
        })
      };
    }
  }

  async function getStatus() {
    const current = await loadState();
    if (current.active && !(await hasOffscreenDocument())) {
      return saveState({
        active: false,
        tabId: null,
        startedAt: '',
        lastError: 'The AudioFlix tab audio route is no longer running.'
      });
    }
    return current;
  }

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const type = String(message?.type || '');
    if (![TYPES.status, TYPES.start, TYPES.stop, TYPES.setVolume, TYPES.offscreenEnded].includes(type)) {
      return undefined;
    }

    (async () => {
      if (type === TYPES.status) return { ok: true, state: await getStatus() };
      if (type === TYPES.start) return startCapture(Number(message.tabId), message.volume);
      if (type === TYPES.stop) return stopCapture('user');
      if (type === TYPES.setVolume) {
        const source = String(message.source || 'unknown');
        const senderTabId = Number.isInteger(sender?.tab?.id) ? sender.tab.id : null;
        const requestedTabId = Number.isInteger(message.tabId) ? message.tabId : null;
        return setVolume(message.volume, {
          source,
          tabId: source === 'audioflix-page' ? senderTabId : requestedTabId
        });
      }
      if (type === TYPES.offscreenEnded) {
        const current = await loadState();
        if (current.active && Number(message.tabId) === current.tabId) {
          const state = await saveState({
            active: false,
            tabId: null,
            startedAt: '',
            lastError: String(message.reason || '')
          });
          await closeOffscreenDocument();
          return { ok: true, state };
        }
        return { ok: true, state: current };
      }
      return { ok: false, error: 'Unsupported AudioFlix tab-audio request.' };
    })().then(sendResponse, (error) => {
      sendResponse({ ok: false, error: String(error?.message || error) });
    });
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    void loadState().then((current) => {
      if (current.active && current.tabId === tabId) return stopCapture('tab-closed');
      return null;
    });
  });

  globalThis.__eveAudioflixTabAudioBridge = {
    TYPES,
    getStatus,
    startCapture,
    stopCapture,
    setVolume
  };
})();
