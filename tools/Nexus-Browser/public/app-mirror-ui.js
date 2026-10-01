(() => {
  function create({
    state,
    send,
    requestId,
    addMessage,
    log
  } = {}) {
    const el = {
      controls: document.querySelector('#appMirrorControls'),
      url: document.querySelector('#appMirrorUrl'),
      attach: document.querySelector('#attachAppMirror'),
      sync: document.querySelector('#syncAppMirror'),
      status: document.querySelector('#appMirrorStatus')
    };
    let mirrorStatus = null;

    function mirrorTarget() {
      return (state.tabs || []).find((tab) =>
        tab.providerId === 'chatgpt' && tab.appMirror === true) || null;
    }

    function effectiveUrl() {
      const target = mirrorTarget();
      return String(mirrorStatus?.url || target?.mirrorUrl || target?.url || '');
    }

    function render() {
      if (!el.controls) return;
      const visible = state.selectedTargetClassId === 'online-origin'
        && state.selectedProviderId === 'chatgpt';
      el.controls.hidden = !visible;
      if (!visible) return;

      const target = mirrorTarget();
      const url = effectiveUrl();
      if (url && document.activeElement !== el.url) el.url.value = url;
      const ready = state.uiConnectionPhase === 'connected' && state.extensionConnected;
      el.attach.disabled = !ready;
      el.sync.disabled = !ready || !(mirrorStatus?.configured || target);

      if (mirrorStatus?.busy) {
        el.status.textContent = 'Mirror connected · Nexus turn in flight · hard sync waits for the turn to finish.';
      } else if (mirrorStatus?.configured || target) {
        const hardSync = mirrorStatus?.lastHardSyncAt
          ? ' · last hard sync ' + new Date(mirrorStatus.lastHardSyncAt).toLocaleTimeString()
          : '';
        el.status.textContent = `Mirror connected to ${url || 'this ChatGPT conversation'}${hardSync}.`;
      } else {
        el.status.textContent = 'Paste the exact ChatGPT conversation URL from the desktop app, then attach it.';
      }
    }

    function observeTabs(tabs = []) {
      const target = tabs.find((tab) => tab.providerId === 'chatgpt' && tab.appMirror === true);
      if (target) {
        mirrorStatus = {
          ...(mirrorStatus || {}),
          configured: true,
          url: target.mirrorUrl || target.url || '',
          tabId: target.id
        };
      }
      render();
    }

    function handleMessage(msg = {}) {
      if (msg.type === 'app_mirror_ready') {
        mirrorStatus = {
          ...(msg.status || {}),
          configured: true,
          url: msg.status?.url || msg.target?.mirrorUrl || msg.target?.url || '',
          tabId: msg.status?.tabId ?? msg.target?.id ?? null
        };
        render();
        addMessage('system', `ChatGPT App Mirror attached to ${mirrorStatus.url || 'the selected conversation'}.`);
        log('ChatGPT App Mirror ready', JSON.stringify(mirrorStatus));
        return true;
      }
      if (msg.type === 'app_mirror_synced') {
        mirrorStatus = {
          ...(mirrorStatus || {}),
          configured: true,
          url: msg.url || mirrorStatus?.url || '',
          tabId: msg.tabId ?? mirrorStatus?.tabId ?? null,
          busy: !!msg.busy,
          lastHardSyncAt: msg.hard ? (msg.syncedAt || Date.now()) : (mirrorStatus?.lastHardSyncAt || 0)
        };
        render();
        addMessage('system', `ChatGPT App Mirror ${msg.hard ? 'hard-' : ''}synced.`);
        log('ChatGPT App Mirror synced', JSON.stringify(msg));
        return true;
      }
      if (msg.type === 'app_mirror_status') {
        mirrorStatus = msg.status || null;
        render();
        return true;
      }
      return false;
    }

    function requestStatus() {
      return send({ type: 'request_app_mirror_status', requestId: requestId() });
    }

    el.attach?.addEventListener('click', () => {
      const url = String(el.url?.value || '').trim();
      if (!url) {
        addMessage('system', 'Paste the exact ChatGPT conversation URL first.');
        return;
      }
      send({ type: 'ensure_app_mirror', requestId: requestId(), url });
    });
    el.sync?.addEventListener('click', () => {
      send({ type: 'sync_app_mirror', requestId: requestId(), hard: true });
    });

    return {
      render,
      observeTabs,
      handleMessage,
      requestStatus,
      status: () => mirrorStatus
    };
  }

  const api = { create };
  globalThis.BrowserAiBridgeAppMirrorUi = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
