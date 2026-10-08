(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const fields = ['providers','agents','rooms','clients','extension','dex','recovery','pending','session','saved'];
  const AUDIO = Object.freeze({
    status: 'eve.audioflix.tabAudio.status',
    start: 'eve.audioflix.tabAudio.start',
    stop: 'eve.audioflix.tabAudio.stop',
    setVolume: 'eve.audioflix.tabAudio.setVolume',
    state: 'eve.audioflix.tabAudio.state'
  });
  let timer = 0;
  let audioTimer = 0;
  let gainTimer = 0;
  let audioStatus = { active: false, tabId: null, volume: 1, lastError: '' };

  function showOffline(message) {
    byId('state').className = 'state offline'; byId('state').textContent = 'OFFLINE';
    byId('summary').textContent = message || 'Nexus Browser is stopped. Start it from Tools → Local services.';
    for (const id of fields) byId(id).textContent = '—';
  }

  function render(data) {
    byId('state').className = 'state online'; byId('state').textContent = 'ONLINE';
    byId('summary').textContent = data.extensionConnected
      ? 'Nexus is routing browser providers and local agents.'
      : 'The Nexus server is ready; its provider extension is not connected.';
    byId('providers').textContent = data.onlineTargets ?? 0;
    byId('agents').textContent = data.localTargets ?? 0;
    byId('rooms').textContent = data.dexRooms ?? 0;
    byId('clients').textContent = data.uiClients ?? 0;
    byId('extension').textContent = data.extensionConnected ? 'Connected' : 'Disconnected';
    byId('dex').textContent = data.dexUiConnected ? 'Connected' : 'Standby';
    byId('recovery').textContent = data.recoveryRooms ?? 0;
    const control = data.controlPlane || {};
    byId('pending').textContent = (control.providerControlPending || 0) + (control.controlReceiptsPending || 0)
      + (control.targetOperationsPending || 0);
    byId('session').textContent = String(data.serverSessionId || 'unknown').slice(0, 12);
    byId('saved').textContent = data.savedAt ? new Date(data.savedAt).toLocaleTimeString() : 'No saved state';
    byId('updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
  }

  async function refresh() {
    try {
      const response = await fetch(`${globalThis.NexusBrowserRuntimeConfig.httpOrigin}/diagnostics`, {
        cache:'no-store', signal:AbortSignal.timeout(2500)
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      if (data?.ok !== true) throw new Error('Invalid diagnostics response');
      render(data);
    } catch (error) { showOffline(error?.name === 'TimeoutError' ? 'Nexus Browser did not respond in time.' : undefined); }
  }

  async function activeTab() {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    return tab || null;
  }

  const percent = value => `${Math.round(Math.max(0, Math.min(1, Number(value) || 0)) * 100)}%`;

  async function renderAudio(state = audioStatus) {
    audioStatus = {
      active: state?.active === true,
      tabId: Number.isInteger(state?.tabId) ? state.tabId : null,
      volume: Math.max(0, Math.min(1, Number(state?.volume) || 0)),
      lastError: String(state?.lastError || '')
    };

    const tab = await activeTab().catch(() => null);
    const sameTab = audioStatus.active && tab?.id === audioStatus.tabId;
    const audioState = byId('audioState');
    audioState.className = `audio-state${audioStatus.active ? ' active' : (audioStatus.lastError ? ' error' : '')}`;
    audioState.textContent = audioStatus.active ? 'ACTIVE' : (audioStatus.lastError ? 'ERROR' : 'OFF');

    byId('audioGain').value = String(audioStatus.volume);
    byId('audioGainLabel').textContent = percent(audioStatus.volume);
    byId('audioTab').textContent = audioStatus.active
      ? (sameTab ? (tab?.title || `Tab ${audioStatus.tabId}`) : `Tab ${audioStatus.tabId}`)
      : '—';
    byId('audioTab').title = byId('audioTab').textContent;

    const toggle = byId('audioToggle');
    toggle.classList.toggle('stop', sameTab);
    toggle.textContent = sameTab ? 'Stop audio control' : (audioStatus.active ? 'Move audio control to this tab' : 'Enable audio control');
    toggle.disabled = !tab?.id;

    byId('audioSummary').textContent = audioStatus.lastError
      ? audioStatus.lastError
      : (audioStatus.active
          ? 'Captured tab audio is passing through AudioFlix gain and back to your speakers.'
          : 'Enable this on the EveOS tab to give AudioFlix real captured-tab volume control.');

    try {
      const allowed = await chrome.extension.isAllowedFileSchemeAccess();
      byId('fileAccess').textContent = allowed ? 'Allowed' : 'Enable in extension details';
      byId('fileAccess').title = allowed
        ? 'AudioFlix volume sliders can sync to captured-tab gain in file:// EveOS.'
        : 'Chrome requires “Allow access to file URLs” for automatic AudioFlix slider sync.';
    } catch {
      byId('fileAccess').textContent = 'Unknown';
    }
  }

  async function refreshAudio() {
    try {
      const response = await chrome.runtime.sendMessage({ type: AUDIO.status });
      if (!response?.ok) throw new Error(response?.error || 'Audio bridge status unavailable.');
      await renderAudio(response.state);
    } catch (error) {
      await renderAudio({ ...audioStatus, active: false, lastError: String(error?.message || error) });
    }
  }

  async function toggleAudio() {
    const tab = await activeTab();
    if (!tab?.id) return;
    const stopping = audioStatus.active && audioStatus.tabId === tab.id;
    byId('audioToggle').disabled = true;
    try {
      const response = await chrome.runtime.sendMessage(stopping
        ? { type: AUDIO.stop }
        : { type: AUDIO.start, tabId: tab.id, volume: Number(byId('audioGain').value) });
      if (!response?.ok) throw new Error(response?.error || 'AudioFlix tab audio could not change state.');
      await renderAudio(response.state);
    } catch (error) {
      await renderAudio({ ...audioStatus, active: false, lastError: String(error?.message || error) });
    } finally {
      byId('audioToggle').disabled = false;
    }
  }

  function queueGain(value) {
    const volume = Math.max(0, Math.min(1, Number(value) || 0));
    byId('audioGainLabel').textContent = percent(volume);
    clearTimeout(gainTimer);
    gainTimer = setTimeout(async () => {
      try {
        const response = await chrome.runtime.sendMessage({
          type: AUDIO.setVolume,
          source: 'extension-popup',
          tabId: audioStatus.tabId,
          volume
        });
        if (response?.state) await renderAudio(response.state);
      } catch {
        // The next status refresh will surface a stopped/failed route.
      }
    }, 35);
  }

  byId('refresh').addEventListener('click', () => { void refresh(); void refreshAudio(); });
  byId('audioToggle').addEventListener('click', () => void toggleAudio());
  byId('audioGain').addEventListener('input', event => queueGain(event.target.value));
  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === AUDIO.state && message.state) void renderAudio(message.state);
  });
  window.addEventListener('pagehide', () => {
    clearInterval(timer);
    clearInterval(audioTimer);
    clearTimeout(gainTimer);
  }, { once:true });

  void refresh();
  void refreshAudio();
  timer = setInterval(refresh, 4000);
  audioTimer = setInterval(refreshAudio, 2000);
})();
