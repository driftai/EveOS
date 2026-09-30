(() => {
  'use strict';
  const byId = id => document.getElementById(id);
  const fields = ['providers','agents','rooms','clients','extension','dex','recovery','pending','session','saved'];
  let timer = 0;

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

  byId('refresh').addEventListener('click', refresh);
  window.addEventListener('pagehide', () => clearInterval(timer), { once:true });
  void refresh(); timer = setInterval(refresh, 4000);
})();
