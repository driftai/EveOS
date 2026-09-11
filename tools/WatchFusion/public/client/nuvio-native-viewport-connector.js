const NUVIO_NATIVE_WIDTH = 1920, NUVIO_NATIVE_HEIGHT = 1080;

function getScaleForFrame(frame) {
  const w = frame?.parentElement?.clientWidth || frame?.clientWidth || 0;
  const h = frame?.parentElement?.clientHeight || frame?.clientHeight || 0;
  return (!w || !h) ? 1 : Math.min(w / NUVIO_NATIVE_WIDTH, h / NUVIO_NATIVE_HEIGHT);
}

function installQrBridge(doc) {
  if (!doc || doc.__watchfusionQrBridgeInstalled) return;
  doc.__watchfusionQrBridgeInstalled = true;
  const win = doc.defaultView || window;

  function refreshQrRender() {
    const qrContainer = doc.getElementById('qr-container');
    const codeText = doc.getElementById('qr-code-text');
    if (!qrContainer || !codeText) return;

    const match = String(codeText.innerText || '').trim().match(/([a-f0-9]{16,64})/i);
    if (!match) return;
    const loginUrl = `https://nuvio.tv/tv-login?code=${match[1]}`;

    qrContainer.style.cursor = 'pointer';
    codeText.style.cursor = 'pointer';

    if (!qrContainer.__watchFusionClickBound) {
      qrContainer.__watchFusionClickBound = true;
      const openTab = e => { e.stopPropagation(); win.open(loginUrl, '_blank'); };
      qrContainer.addEventListener('click', openTab);
      codeText.addEventListener('click', openTab);
    }

    const img = qrContainer.querySelector('img');
    if (img && typeof win.qrcode === 'function') {
      const isExt = img.src && (img.src.includes('api.qrserver.com') || img.src.includes('qrserver.com'));
      if (isExt || !img.src || img.naturalWidth === 0) {
        try {
          const qr = win.qrcode(0, 'M');
          qr.addData(loginUrl);
          qr.make();
          const dataUrl = qr.createDataURL(8, 4);
          if (dataUrl && img.src !== dataUrl) img.src = dataUrl;
        } catch (_) {}
      }
    }

    const actions = doc.querySelector('.qr-actions');
    if (actions && !doc.getElementById('qr-browser-open-btn')) {
      const openBtn = doc.createElement('button');
      openBtn.type = 'button';
      openBtn.id = 'qr-browser-open-btn';
      openBtn.className = 'qr-action-btn qr-action-btn-secondary focusable watchfusion-open-browser-btn';
      openBtn.textContent = 'Open in Browser';
      openBtn.style.cursor = 'pointer';
      openBtn.onclick = e => { e.preventDefault(); e.stopPropagation(); win.open(loginUrl, '_blank'); };
      actions.insertBefore(openBtn, actions.firstChild);
    }
  }

  const observer = new MutationObserver(() => refreshQrRender());
  observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true });
  setInterval(refreshQrRender, 500);
}

function installStreamFailoverBridge(doc) {
  if (!doc || doc.__watchfusionStreamFailoverInstalled) return;
  doc.__watchfusionStreamFailoverInstalled = true;
  const win = doc.defaultView || window;
  let lastFailoverTime = 0, failoverAttempts = 0;
  const failoverHistory = [];

  function checkAndAutoAdvanceFailedStream(force = false) {
    const errOverlay = doc.getElementById('playerStartupErrorOverlay');
    if (!errOverlay || errOverlay.classList.contains('hidden') || errOverlay.style.display === 'none') return;

    const now = Date.now();
    if (!force && (now - lastFailoverTime < 350)) return;
    lastFailoverTime = now;

    const player = win.PlayerScreen || win.Router?.routes?.player || win.Router?.getCurrentScreen?.();
    if (!player || !Array.isArray(player.streamCandidates) || player.streamCandidates.length <= 1) return;
    if (failoverAttempts >= Math.min(player.streamCandidates.length, 12)) return;

    const failedUrls = player.failedPlaybackUrls || (player.failedPlaybackUrls = new win.Set());
    const failedIds = player.failedPlaybackStreamIds || (player.failedPlaybackStreamIds = new win.Set());
    if (player.activePlaybackUrl) failedUrls.add(String(player.activePlaybackUrl).trim());
    const currentCandidate = player.getCurrentStreamCandidate?.() || player.streamCandidates[player.currentStreamIndex];
    if (currentCandidate?.id) failedIds.add(String(currentCandidate.id).trim());

    try { player.markPlaybackSourceFailed?.(player.activePlaybackUrl, currentCandidate); } catch (_) {}

    const nextIndex = player.streamCandidates.findIndex((c, idx) => {
      if (idx === player.currentStreamIndex || !c || !c.url) return false;
      const u = String(c.url).trim(), id = String(c.id || '').trim();
      return !failedUrls.has(u) && (!id || !failedIds.has(id));
    });

    if (nextIndex >= 0) {
      failoverAttempts++;
      const nextCand = player.streamCandidates[nextIndex];
      failoverHistory.push({ at: now, fromIndex: player.currentStreamIndex, toIndex: nextIndex, fromUrl: player.activePlaybackUrl, toUrl: nextCand.url, candidateName: nextCand.title || nextCand.name });
      win.__watchFusionFailoverHistory = failoverHistory;
      errOverlay.classList.add('hidden');
      player.clearPlaybackStallGuard?.();
      player.currentStreamIndex = nextIndex;
      try { player.playStreamCandidate(nextCand, { mountToken: player.mountToken ?? null, preservePlaybackState: true }); } catch (_) {}
    }
  }

  const observer = new MutationObserver(() => checkAndAutoAdvanceFailedStream(false));
  observer.observe(doc.body || doc.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
  setInterval(() => checkAndAutoAdvanceFailedStream(false), 350);

  win.watchFusionStreamFailover = {
    checkAndAutoAdvanceFailedStream: (f = true) => checkAndAutoAdvanceFailedStream(f),
    get history() { return failoverHistory; },
    get attempts() { return failoverAttempts; },
    reset() { lastFailoverTime = 0; failoverAttempts = 0; failoverHistory.length = 0; }
  };
}

function installSidebarClickShield(doc) {
  if (!doc) return;
  const win = doc.defaultView || window;
  installQrBridge(doc);
  installStreamFailoverBridge(doc);

  try {
    if (!doc.getElementById('__watchfusion_sidebar_shield_style')) {
      const s = doc.createElement('style');
      s.id = '__watchfusion_sidebar_shield_style';
      s.textContent = `
        .modern-sidebar-shell.expanded, .modern-sidebar-shell.panel-visible, .home-sidebar.content-expanded { z-index: 1000 !important; }
        .modern-sidebar-panel, .home-sidebar, .player-modal, .player-sources-panel { pointer-events: auto !important; }
        .modern-sidebar-shell.expanded .modern-sidebar-panel { pointer-events: auto !important; z-index: 1001 !important; }
        .modern-sidebar-profile, .modern-sidebar-nav-item, .modern-sidebar-pill, .home-nav-item, .home-profile-pill, .root-sidebar-item, .player-startup-error-button { pointer-events: auto !important; cursor: pointer !important; position: relative !important; z-index: 1002 !important; }
        .player-startup-error-overlay { pointer-events: auto !important; z-index: 1005 !important; }
        #player { cursor: default; }
        .player-controls-overlay:not(.hidden) { pointer-events: auto !important; }
        .player-progress-shell { pointer-events: auto !important; cursor: pointer !important; padding: 14px 0 !important; position: relative !important; z-index: 100 !important; }
        .player-progress-track { pointer-events: auto !important; cursor: pointer !important; }
        .player-progress-fill, .player-progress-buffered { pointer-events: none !important; }
        .player-control-btn, .player-control-buttons, [data-subtitle-rail], [data-audio-column], [data-sources-zone] { pointer-events: auto !important; cursor: pointer !important; }
        .player-controls-gradient { pointer-events: none !important; }
      `;
      doc.head?.appendChild(s);
    }
  } catch {}

  if (doc.__watchfusionSidebarShieldInstalled) return;
  doc.__watchfusionSidebarShieldInstalled = true;

  function isSidebarElement(el) {
    return Boolean(el?.closest?.('.modern-sidebar-shell, .modern-sidebar-panel, .modern-sidebar-pill, .home-sidebar'));
  }

  function getSidebarButton(el) {
    return el?.closest?.('.modern-sidebar-nav-item, .modern-sidebar-profile, .modern-sidebar-pill, .home-nav-item, .home-profile-pill, .root-sidebar-item, [data-nav-zone="sidebar"], [data-action^="goto"], [data-action="expandSidebar"]');
  }

  function expandSidebar() {
    const shell = doc.querySelector('.modern-sidebar-shell');
    if (shell) {
      shell.classList.add('panel-visible', 'opening', 'expanded');
      shell.classList.remove('collapsing');
      shell.querySelector('.modern-sidebar-panel')?.setAttribute('aria-hidden', 'false');
      shell.querySelector('.modern-sidebar-pill')?.setAttribute('aria-expanded', 'true');
      const cur = win.Router?.getCurrentScreen?.() || win.NuvioRouter?.getCurrentScreen?.();
      if (cur) cur.sidebarExpanded = true;
    }
    doc.querySelector('.home-sidebar')?.classList.add('content-expanded', 'expanded');
  }

  function collapseSidebar() {
    const cur = win.Router?.getCurrentScreen?.() || win.NuvioRouter?.getCurrentScreen?.();
    if (typeof cur?.closeSidebarToContent === 'function') { try { cur.closeSidebarToContent(); } catch {} }
    else if (typeof cur?.closeSidebarToNav === 'function') { try { cur.closeSidebarToNav(); } catch {} }
    if (cur) { try { cur.sidebarExpanded = false; } catch {} }
    const shell = doc.querySelector('.modern-sidebar-shell');
    if (shell && (shell.classList.contains('expanded') || shell.classList.contains('panel-visible') || shell.classList.contains('opening'))) {
      shell.classList.remove('expanded', 'panel-visible', 'opening');
      shell.classList.add('collapsing');
      shell.querySelector('.modern-sidebar-panel')?.setAttribute('aria-hidden', 'true');
      shell.querySelector('.modern-sidebar-pill')?.setAttribute('aria-expanded', 'false');
      setTimeout(() => shell.classList.remove('collapsing'), 250);
    }
    const legacy = doc.querySelector('.home-sidebar');
    if (legacy && (legacy.classList.contains('expanded') || legacy.classList.contains('content-expanded') || legacy.classList.contains('opening'))) {
      legacy.classList.remove('expanded', 'content-expanded', 'opening');
    }
  }

  let collapseTimer = null;
  function handlePointerCheck(target) {
    const hasExp = Boolean(doc.querySelector('.modern-sidebar-shell.expanded, .modern-sidebar-shell.panel-visible, .home-sidebar.expanded, .home-sidebar.content-expanded'));
    if (!hasExp) { if (collapseTimer) { clearTimeout(collapseTimer); collapseTimer = null; } return; }
    if (!isSidebarElement(target)) {
      if (!collapseTimer) collapseTimer = setTimeout(() => { collapseTimer = null; collapseSidebar(); }, 150);
    } else if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
  }

  const onPointerEvent = event => {
    const btn = getSidebarButton(event.target);
    if (!btn) { handlePointerCheck(event.target); return; }
    event.stopPropagation();
    event.stopImmediatePropagation();
    if (event.type === 'click') event.preventDefault();

    doc.querySelectorAll('.focusable.focused')?.forEach(n => { if (n !== btn) n.classList.remove('focused'); });
    btn.classList.add('focused');

    if (event.type === 'click') {
      const action = String(btn.dataset.action || '');
      if (action === 'expandSidebar') { expandSidebar(); return; }
      if (typeof btn.onclick === 'function') { try { btn.onclick.call(btn, event); } catch (_) {} }
      const router = win.NuvioRouter || win.Router;
      const routeMap = { gotoSettings: 'settings', gotoSearch: 'search', gotoLibrary: 'library', gotoHome: 'home', gotoAccount: 'profileSelection', gotoDiscover: 'discover' };
      if (routeMap[action]) router?.navigate?.(routeMap[action]);
    }
  };

  ['click', 'pointerdown', 'mousedown'].forEach(e => { win.addEventListener(e, onPointerEvent, true); doc.addEventListener(e, onPointerEvent, true); });
  ['pointermove', 'mousemove'].forEach(e => { win.addEventListener(e, ev => handlePointerCheck(ev.target), true); doc.addEventListener(e, ev => handlePointerCheck(ev.target), true); });
}

function createNativeViewportConnector(frame) {
  let resizeObserver = null;

  function apply() {
    if (!frame) return false;
    const scale = Math.max(0.05, Math.min(1, getScaleForFrame(frame))), stage = frame.parentElement;
    if (!stage) return false;
    stage.style.position = 'relative';
    stage.style.overflow = 'hidden';

    Object.assign(frame.style, {
      position: 'absolute', width: `${NUVIO_NATIVE_WIDTH}px`, height: `${NUVIO_NATIVE_HEIGHT}px`,
      minWidth: `${NUVIO_NATIVE_WIDTH}px`, minHeight: `${NUVIO_NATIVE_HEIGHT}px`, maxWidth: 'none', maxHeight: 'none',
      left: '50%', top: '50%', margin: '0', border: '0', transformOrigin: 'center center', transform: `translate(-50%, -50%) scale(${scale})`
    });
    frame.dataset.watchfusionNuvioScale = String(scale);
    frame.dataset.watchfusionNuvioNativeViewport = `${NUVIO_NATIVE_WIDTH}x${NUVIO_NATIVE_HEIGHT}`;
    try { if (frame.contentDocument) installSidebarClickShield(frame.contentDocument); } catch (_) {}
    return true;
  }

  function observe() {
    resizeObserver?.disconnect();
    if (typeof ResizeObserver === 'undefined' || !frame?.parentElement) return;
    resizeObserver = new ResizeObserver(() => apply());
    resizeObserver.observe(frame.parentElement);
  }

  function destroy() {
    resizeObserver?.disconnect();
    resizeObserver = null;
    if (!frame) return;
    ['position','width','height','minWidth','minHeight','maxWidth','maxHeight','left','top','margin','border','transformOrigin','transform'].forEach(p => { frame.style[p] = ''; });
    delete frame.dataset.watchfusionNuvioScale;
    delete frame.dataset.watchfusionNuvioNativeViewport;
  }

  return { apply, observe, destroy, nativeWidth: NUVIO_NATIVE_WIDTH, nativeHeight: NUVIO_NATIVE_HEIGHT, get scale() { return getScaleForFrame(frame); } };
}

(function installWatchFusionNativeNuvioConnector() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  let connector = null;
  const attach = frame => {
    if (!(frame instanceof HTMLIFrameElement) || frame.id !== 'nuvioFrame') return;
    connector?.destroy();
    connector = createNativeViewportConnector(frame);
    connector.apply();
    connector.observe();
    const onFrameReady = () => {
      connector?.apply();
      connector?.observe();
      try { if (frame.contentWindow && !frame.contentWindow.Hls && window.Hls) frame.contentWindow.Hls = window.Hls; } catch (_) {}
      try { if (frame.contentDocument) installSidebarClickShield(frame.contentDocument); } catch (_) {}
    };
    frame.addEventListener('load', onFrameReady);
    try { if (frame.contentDocument && frame.contentDocument.readyState !== 'loading') onFrameReady(); } catch (_) {}
  };
  const scan = root => root?.querySelectorAll?.('#nuvioFrame')?.forEach?.(attach);
  const observer = new MutationObserver(mutations => {
    for (const m of mutations) {
      for (const n of m.addedNodes || []) {
        if (n.nodeType !== Node.ELEMENT_NODE) continue;
        if (n.id === 'nuvioFrame') attach(n);
        scan(n);
      }
    }
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  window.watchFusionNuvioNativeViewport = {
    attach, installSidebarClickShield, installQrBridge,
    nativeWidth: NUVIO_NATIVE_WIDTH, nativeHeight: NUVIO_NATIVE_HEIGHT,
    get scale() { return connector?.scale ?? null; }
  };
  window.watchFusionNuvioViewport = window.watchFusionNuvioNativeViewport;
  scan(document);
})();
