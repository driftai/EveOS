(() => {
  if (new URLSearchParams(location.search).get('eveosDetached') !== '1') return;

  const MESSAGE_TYPE = 'eveos:nexus-detached-state';
  document.documentElement.dataset.eveosDetached = 'true';
  if (!/Detached/i.test(document.title)) document.title = `${document.title} · Detached`;

  function publish(state = 'open') {
    try {
      if (window.opener && !window.opener.closed) {
        window.opener.postMessage({
          type: MESSAGE_TYPE,
          state,
          href: location.href,
          at: Date.now()
        }, '*');
      }
    } catch {}
  }

  publish('open');
  const heartbeat = setInterval(() => publish('open'), 1200);
  addEventListener('pageshow', () => publish('open'));
  addEventListener('visibilitychange', () => publish('open'));
  addEventListener('beforeunload', () => {
    clearInterval(heartbeat);
    publish('closed');
  });
})();
