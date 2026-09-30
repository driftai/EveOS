/* One explicit dashboard-open path, shared by standalone Nexus and Bridge. */
(function () {
  'use strict';
  const config = globalThis.NexusBrowserRuntimeConfig;
  let opening = null;
  async function status() {
    try {
      const response = await fetch(config.healthUrl, { cache:'no-store', signal:AbortSignal.timeout(1600) });
      const payload = await response.json();
      const online = response.ok && payload?.ok === true && payload.service === 'eveos-nexus-browser';
      return { online, conflict:response.ok && payload?.service !== 'eveos-nexus-browser' };
    } catch (_error) { return { online:false, conflict:false }; }
  }
  async function launch() {
    let current = await status();
    if (current.conflict) throw new Error('Nexus Browser port is occupied by another service. Open EveOS to inspect it.');
    if (!current.online) {
      let response;
      try {
        response = await fetch(`${config.controlOrigin}/api/nexus-browser/start`, {
          method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}', signal:AbortSignal.timeout(15000)
        });
      } catch (_error) {
        throw new Error('EveOS Local Control is unavailable or Start timed out. Check its status in EveOS before retrying.');
      }
      const payload = await response.json();
      if (!response.ok || payload.ok !== true) throw new Error(`${payload.message || 'Could not start Nexus Browser.'} Start it from EveOS Local Control.`);
      for (let attempt = 0; attempt < 6; attempt++) {
        current = await status();
        if (current.online || current.conflict) break;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      if (!current.online) throw new Error('Nexus Browser is not ready yet. Check its console in EveOS before trying again.');
    }
    const url = `${config.httpOrigin}/`;
    const tabs = await chrome.tabs.query({ url:config.tabPattern });
    const existing = tabs.find(tab => {
      const candidate = new URL(tab.url || tab.pendingUrl);
      return candidate.pathname === '/' && !candidate.searchParams.get('mode');
    });
    const tab = existing ? await chrome.tabs.update(existing.id, { active:true }) : await chrome.tabs.create({ url });
    if (existing) await chrome.windows.update(existing.windowId, { focused:true });
    return { opened:true, tabId:tab.id, message:'Nexus Browser is ready.' };
  }
  function open() {
    if (!opening) opening = launch().finally(() => { opening = null; });
    return opening;
  }
  globalThis.NexusBrowserDashboard = Object.freeze({ status, open });
})();
