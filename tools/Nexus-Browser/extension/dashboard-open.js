/* One managed dashboard-open path, shared by standalone Nexus and Bridge tools. */
(function () {
  'use strict';
  function create(config) {
  const name = config.name;
  let opening = null;
  async function status() {
    try {
      const response = await fetch(config.healthUrl, { cache:'no-store', signal:AbortSignal.timeout(1600) });
      const payload = await response.json();
      const branded = payload?.[config.healthKey] === config.healthValue;
      const online = response.ok && payload?.ok === true && branded;
      return { online, conflict:response.ok && !branded };
    } catch (_error) { return { online:false, conflict:false }; }
  }
  async function launch() {
    let current = await status();
    if (current.conflict) throw new Error(`${name} port is occupied by another service. Open EveOS to inspect it.`);
    if (!current.online) {
      let response;
      try {
        response = await fetch(`${config.controlOrigin}${config.startPath}`, {
          method:'POST', headers:{ 'Content-Type':'application/json' }, body:'{}', signal:AbortSignal.timeout(15000)
        });
      } catch (_error) {
        throw new Error('EveOS Local Control is unavailable or Start timed out. Check its status in EveOS before retrying.');
      }
      const payload = await response.json();
      if (!response.ok || payload.ok !== true) throw new Error(`${payload.message || `Could not start ${name}.`} Start it from EveOS Local Control.`);
      for (let attempt = 0; attempt < 6; attempt++) {
        current = await status();
        if (current.online || current.conflict) break;
        await new Promise(resolve => setTimeout(resolve, 400));
      }
      if (!current.online) throw new Error(`${name} is not ready yet. Check its console in EveOS before trying again.`);
    }
    const url = `${config.httpOrigin}/`;
    const tabs = await chrome.tabs.query({ url:config.tabPattern });
    const existing = tabs.find(tab => {
      const candidate = new URL(tab.url || tab.pendingUrl);
      return candidate.pathname === '/' && !candidate.searchParams.get('mode');
    });
    const tab = existing ? await chrome.tabs.update(existing.id, { active:true }) : await chrome.tabs.create({ url });
    if (existing) await chrome.windows.update(existing.windowId, { focused:true });
    return { opened:true, tabId:tab.id, message:`${name} is ready.` };
  }
  function open() {
    if (!opening) opening = launch().finally(() => { opening = null; });
    return opening;
  }
  return Object.freeze({ status, open });
  }
  globalThis.EveOSManagedDashboard = Object.freeze({ create });
  globalThis.NexusBrowserDashboard = create({ ...globalThis.NexusBrowserRuntimeConfig,
    name:'Nexus Browser', startPath:'/api/nexus-browser/start', healthKey:'service', healthValue:'eveos-nexus-browser' });
})();
