(function () {
  'use strict';

  const API = '/api/world-portal';
  const CONTROL_BASES = [
    'http://127.0.0.1:9082',
    'http://127.0.0.1:8765',
    'http://127.0.0.1:3000'
  ];
  const view = document.getElementById('world-portal-view');
  const frame = document.getElementById('world-portal-frame');
  const status = document.getElementById('world-portal-status');
  const serverButton = document.getElementById('world-portal-server-btn');
  let snapshot = null;
  let timer = 0;
  let recoveryPromise = null;

  function navigateFrame(source) {
    if (!frame || frame.getAttribute('src') === source) return;
    frame.setAttribute('src', source);
  }

  function embeddedPortalUrl(source) {
    if (!source || source === 'about:blank') return source;
    try {
      const target = new URL(source);
      target.searchParams.set('embedded', 'world-book');
      return target.toString();
    } catch (_) {
      const separator = source.includes('?') ? '&' : '?';
      return `${source}${separator}embedded=world-book`;
    }
  }

  async function readJson(response) {
    return response.json().catch(() => ({}));
  }

  async function controllerRequest(baseUrl, path, method = 'GET', timeoutMs = 2600) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        cache: 'no-store',
        signal: controller.signal
      });
      const payload = await readJson(response);
      if (!response.ok) throw new Error(payload.message || `Controller request failed (${response.status})`);
      return payload;
    } finally {
      clearTimeout(timeout);
    }
  }

  async function findWorldBookController() {
    for (const baseUrl of CONTROL_BASES) {
      try {
        const payload = await controllerRequest(baseUrl, '/api/world-book/status');
        if (payload?.controllerAvailable !== false) return { baseUrl, payload };
      } catch (_) {
        // Try the next known local EveOS control endpoint.
      }
    }
    return null;
  }

  async function portalRouteReady(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(`${API}/status`, { cache: 'no-store' });
        const payload = await readJson(response);
        if (response.ok && payload?.service === 'world-portal-controller') return payload;
      } catch (_) {
        // World Book is expected to disappear briefly while it restarts.
      }
      await new Promise(resolve => setTimeout(resolve, 180));
    }
    return null;
  }

  async function recoverStaleWorldBook() {
    if (recoveryPromise) return recoveryPromise;
    recoveryPromise = (async () => {
      const managed = await findWorldBookController();
      if (!managed) return false;

      if (status) status.textContent = 'Refreshing World Book to load World Portal support...';
      if (serverButton) serverButton.disabled = true;

      try {
        if (managed.payload?.running === true) {
          await controllerRequest(managed.baseUrl, '/api/world-book/stop', 'POST', 5000);
        }
        await controllerRequest(managed.baseUrl, '/api/world-book/start', 'POST', 7000);
        const ready = await portalRouteReady();
        if (!ready) return false;
        if (status) status.textContent = 'World Portal bridge refreshed.';
        return true;
      } catch (_) {
        return false;
      } finally {
        if (serverButton) serverButton.disabled = false;
      }
    })();

    try {
      return await recoveryPromise;
    } finally {
      recoveryPromise = null;
    }
  }

  async function request(path, method = 'GET', allowRecovery = true) {
    const response = await fetch(`${API}${path}`, { method, cache: 'no-store' });
    const payload = await readJson(response);
    if (response.ok) return payload;

    if (allowRecovery && response.status === 404) {
      const recovered = await recoverStaleWorldBook();
      if (recovered) return request(path, method, false);
      throw new Error('World Portal bridge is out of date. Restart World Book from Eve OS, then refresh.');
    }

    throw new Error(payload.message || `World Portal request failed (${response.status})`);
  }

  function selectedContext() {
    const value = id => document.getElementById(id)?.value?.trim() || '';
    return {
      source: 'world-book',
      title: value('entry-name') || document.getElementById('breadcrumb')?.textContent?.trim() || 'World Book selection',
      path: value('entry-path') || document.getElementById('breadcrumb')?.textContent?.trim() || '',
      kind: value('entry-kind'),
      status: value('entry-status'),
      notes: value('entry-notes'),
      sentAt: new Date().toISOString()
    };
  }

  function sendContext() {
    frame?.contentWindow?.postMessage({ type: 'world-book:context', context: selectedContext() }, '*');
    if (status) status.textContent = 'Selected World Book context sent to Portal.';
  }

  function render(next) {
    snapshot = next;
    const running = next?.running === true;
    view?.classList.toggle('is-online', running);
    if (status) status.textContent = next?.message || (running ? 'World Portal is online.' : 'World Portal is resting.');
    if (serverButton) serverButton.textContent = running ? 'Stop Portal' : 'Start Portal';
    navigateFrame(running ? embeddedPortalUrl(next.url) : 'about:blank');
  }

  async function refresh() {
    try { render(await request('/status')); }
    catch (error) { render({ running: false, message: error.message }); }
  }

  async function toggle() {
    serverButton.disabled = true;
    try { render(await request(snapshot?.running ? '/stop' : '/start', 'POST')); }
    catch (error) { render({ running: false, message: error.message }); }
    finally { serverButton.disabled = false; }
  }

  function renderDetachedMessage(target, message) {
    if (!target || target.closed) return;
    target.document.body.innerHTML = '';
    target.document.body.style.cssText = 'margin:0;min-height:100vh;display:grid;place-items:center;background:#061014;color:#d9fbff;font:16px sans-serif';
    const text = target.document.createElement('p');
    text.textContent = message;
    target.document.body.appendChild(text);
  }

  async function detach() {
    const target = window.open('about:blank', 'worldPortalWindow', 'popup=yes,width=1280,height=860,resizable=yes,scrollbars=yes');
    if (!target) {
      if (status) status.textContent = 'Window blocked. Allow pop-ups to detach World Portal.';
      return;
    }
    renderDetachedMessage(target, 'Starting World Portal...');
    try {
      let next = snapshot?.running ? snapshot : await request('/start', 'POST');
      render(next);
      if (!next.running) throw new Error(next.message || 'World Portal did not become ready.');
      target.location.replace(next.url);
      target.focus();
    } catch (error) {
      renderDetachedMessage(target, error.message || 'World Portal could not be opened.');
    }
  }

  function open() {
    view.hidden = false;
    document.body.classList.add('world-portal-active');
    window.clearInterval(timer);
    timer = window.setInterval(refresh, 5000);
    void refresh();
  }

  function close() {
    document.body.classList.remove('world-portal-active');
    view.hidden = true;
    window.clearInterval(timer);
    timer = 0;
  }

  document.getElementById('world-portal-btn')?.addEventListener('click', open);
  document.getElementById('world-portal-back-btn')?.addEventListener('click', close);
  document.getElementById('world-portal-refresh-btn')?.addEventListener('click', refresh);
  document.getElementById('world-portal-context-btn')?.addEventListener('click', sendContext);
  document.getElementById('world-portal-detach-btn')?.addEventListener('click', detach);
  serverButton?.addEventListener('click', toggle);
  document.getElementById('world-portal-offline-start-btn')?.addEventListener('click', toggle);
  frame?.addEventListener('load', sendContext);
  window.addEventListener('message', event => {
    if (event.data?.type === 'world-portal:ready') sendContext();
  });

  const params = new URLSearchParams(location.search);
  if (params.get('view') === 'world-portal') open();
})();