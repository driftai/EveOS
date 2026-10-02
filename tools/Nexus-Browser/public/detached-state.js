(() => {
  if (new URLSearchParams(location.search).get('eveosDetached') !== '1') return;

  const MESSAGE_TYPE = 'eveos:nexus-detached-state';
  const handoff = globalThis.BrowserAiBridgeWorkspaceHandoff;
  document.documentElement.dataset.eveosDetached = 'true';
  if (!/Detached/i.test(document.title)) document.title = `${document.title} · Detached`;

  let reattaching = false;
  function publish(state = 'open', extra = {}) {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({
          type: MESSAGE_TYPE,
          state,
          href: location.href,
          at: Date.now(),
          ...extra
        }, '*');
      }
    } catch {}
  }

  const reattach = document.createElement('button');
  reattach.type = 'button';
  reattach.textContent = 'Reattach to EveOS';
  reattach.setAttribute('aria-label', 'Reattach Nexus Browser to EveOS');
  Object.assign(reattach.style, {
    position: 'fixed', top: '12px', right: '12px', zIndex: '2147483647',
    padding: '8px 12px', borderRadius: '9px', border: '1px solid #52647f',
    background: '#182235', color: '#f5f8ff', font: '600 13px system-ui',
    cursor: 'pointer', boxShadow: '0 6px 22px rgba(0,0,0,.28)'
  });
  reattach.addEventListener('click', () => {
    if (reattaching) return;
    reattaching = true;
    const snapshot = handoff?.snapshotNow?.('reattach') || handoff?.snapshot?.() || null;
    publish('reattach', { snapshot });
    handoff?.relinquish?.('reattach', { snapshot: false, disable: true });
    setTimeout(() => { try { window.close(); } catch {} }, 80);
  });
  document.body?.append(reattach);

  publish('open');
  const heartbeat = setInterval(() => publish('open'), 1200);
  addEventListener('pageshow', () => publish('open'));
  addEventListener('visibilitychange', () => publish('open'));
  addEventListener('beforeunload', () => {
    clearInterval(heartbeat);
    if (reattaching) return;
    handoff?.relinquish?.('detached-close');
    publish('closed');
  });
})();
