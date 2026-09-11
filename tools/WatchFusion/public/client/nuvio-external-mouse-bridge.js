/* WatchFusion-owned bridge for the same-origin Nuvio iframe.
 *
 * Nuvio keeps Router and PlayerScreen inside its compiled IIFE, so this bridge
 * talks only to the narrow pointer gateway installed by the build patch. It
 * forwards the original trusted browser event and never writes media state,
 * synthesizes a click, or calculates a playback time.
 */
(function installWatchFusionExternalNuvioMouseBridge() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.watchFusionExternalNuvioMouse?.version === 6) return;

  const counters = {
    moves: 0,
    clicks: 0,
    forwardedMoves: 0,
    forwardedClicks: 0,
    retargetedMoves: 0,
    retargetedClicks: 0,
    pauseOverlayClicks: 0
  };
  let lastTarget = '';
  let lastHitTarget = '';

  if (!document.getElementById('__watchfusion_nuvio_mouse_hit_style')) {
    const style = document.createElement('style');
    style.id = '__watchfusion_nuvio_mouse_hit_style';
    style.textContent = `
      #playerUiRoot { pointer-events: auto !important; }
      #playerControlsOverlay:not(.hidden),
      #playerControlsOverlay:not(.hidden) .player-controls-bottom,
      #playerControlsOverlay:not(.hidden) .player-controls-bar,
      #playerControlsOverlay:not(.hidden) .player-controls-row,
      #playerControlsOverlay:not(.hidden) .player-control-buttons,
      #playerControlsOverlay:not(.hidden) .player-progress-shell,
      #playerControlsOverlay:not(.hidden) .player-progress-track,
      #playerControlsOverlay:not(.hidden) .player-control-btn,
      #playerPauseOverlay:not(.hidden) {
        pointer-events: auto !important;
      }
      .player-progress-shell {
        cursor: pointer !important;
        padding: 14px 0 !important;
        box-sizing: border-box !important;
      }
      .player-control-btn,
      #playerPauseOverlay:not(.hidden) { cursor: pointer !important; }
      .player-control-btn > *,
      .player-progress-fill,
      .player-progress-buffered { pointer-events: none !important; }
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  const pointerApi = () => window.__WATCHFUSION_NUVIO_POINTER_API__ || null;
  const describeTarget = target => {
    if (!target) return '';
    const id = target.id ? `#${target.id}` : '';
    const classes = typeof target.className === 'string'
      ? target.className.trim().split(/\s+/).filter(Boolean).slice(0, 3).map(name => `.${name}`).join('')
      : '';
    return `${String(target.tagName || '').toLowerCase()}${id}${classes}`;
  };

  const isUsableTarget = target => {
    if (!target || !document.contains(target)) return false;
    const style = window.getComputedStyle(target);
    const rect = target.getBoundingClientRect?.();
    return Boolean(
      rect && rect.width > 0 && rect.height > 0 &&
      style.display !== 'none' && style.visibility !== 'hidden' &&
      Number(style.opacity || 1) > 0
    );
  };

  const containsPoint = (target, x, y) => {
    const rect = target?.getBoundingClientRect?.();
    return Boolean(
      rect && x >= rect.left && x <= rect.right &&
      y >= rect.top && y <= rect.bottom
    );
  };

  const directFocusable = target => target?.closest?.('.focusable') || null;

  const pauseOverlayTargetAt = event => {
    const overlay = document.getElementById('playerPauseOverlay');
    if (!overlay || overlay.classList.contains('hidden') || !isUsableTarget(overlay)) return null;
    if (event.target === overlay || overlay.contains(event.target)) return overlay;
    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    return containsPoint(overlay, x, y) ? overlay : null;
  };

  // A pointer-events:none ancestor can make Chromium report the video/root as
  // event.target even while the visible progress shell is under the cursor.
  // Resolve the canonical Nuvio control from its real on-screen rectangle.
  const pointerTargetAt = event => {
    const playerRoot = document.getElementById('playerUiRoot');
    if (!playerRoot) return null;
    const direct = directFocusable(event.target);
    if (direct && playerRoot.contains(direct) && isUsableTarget(direct)) return direct;

    const x = Number(event.clientX);
    const y = Number(event.clientY);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    const candidates = Array.from(playerRoot.querySelectorAll('.focusable'))
      .filter(target => isUsableTarget(target) && containsPoint(target, x, y))
      .sort((left, right) => {
        const a = left.getBoundingClientRect();
        const b = right.getBoundingClientRect();
        return (a.width * a.height) - (b.width * b.height);
      });
    return candidates[0] || null;
  };

  const routeEventTo = (event, target) => ({
    target,
    clientX: Number(event.clientX),
    clientY: Number(event.clientY),
    button: event.button,
    buttons: event.buttons,
    pointerId: event.pointerId,
    pointerType: event.pointerType,
    isTrusted: event.isTrusted,
    preventDefault: () => event.preventDefault?.(),
    stopPropagation: () => event.stopPropagation?.(),
    stopImmediatePropagation: () => event.stopImmediatePropagation?.()
  });

  const onPointerMove = event => {
    counters.moves += 1;
    lastTarget = describeTarget(event.target);
    const api = pointerApi();
    if (!api || api.version < 5) return;

    // Mouse movement over a hidden player overlay lands on the video. Wake the
    // controls first; the following move will then hit the real Nuvio control.
    try { api.wake?.(event); } catch (_) {}

    const hitTarget = pointerTargetAt(event);
    const nativeTarget = directFocusable(event.target);
    lastHitTarget = describeTarget(hitTarget);
    if (event.__watchFusionNuvioMoveHandled === true && hitTarget === nativeTarget) return;
    try {
      api.move?.(hitTarget ? routeEventTo(event, hitTarget) : event);
      counters.forwardedMoves += 1;
      if (hitTarget && hitTarget !== nativeTarget) counters.retargetedMoves += 1;
    } catch (_) {}
  };

  const onClick = event => {
    counters.clicks += 1;
    lastTarget = describeTarget(event.target);
    if (event.isTrusted === false) return;
    const api = pointerApi();
    if (!api || api.version < 5) return;

    const pauseOverlay = pauseOverlayTargetAt(event);
    if (pauseOverlay && api.version >= 6 && typeof api.resumePauseOverlay === 'function') {
      try {
        const resumed = api.resumePauseOverlay(routeEventTo(event, pauseOverlay));
        if (resumed) {
          counters.pauseOverlayClicks += 1;
          lastHitTarget = describeTarget(pauseOverlay);
          event.preventDefault?.();
          event.stopPropagation?.();
          event.stopImmediatePropagation?.();
          return;
        }
      } catch (_) {}
    }

    const hitTarget = pointerTargetAt(event);
    const nativeTarget = directFocusable(event.target);
    lastHitTarget = describeTarget(hitTarget);
    if (event.__watchFusionNuvioClickHandled === true && hitTarget === nativeTarget) return;
    try {
      void api.click?.(hitTarget ? routeEventTo(event, hitTarget) : event);
      counters.forwardedClicks += 1;
      if (hitTarget && hitTarget !== nativeTarget) counters.retargetedClicks += 1;
    } catch (_) {}
  };

  const moveEvent = typeof window.PointerEvent === 'function' ? 'pointermove' : 'mousemove';
  // FocusEngine registers on document during app startup. This injected script
  // registers later, so a marked event proves the native listener already ran.
  document.addEventListener(moveEvent, onPointerMove, true);
  document.addEventListener('click', onClick, true);

  const status = () => {
    const api = pointerApi();
    const progressShell = document.getElementById('playerProgressShell') ||
      document.querySelector('.player-progress-shell');
    const playerRoot = document.getElementById('playerUiRoot') ||
      document.getElementById('player');
    const pauseOverlay = document.getElementById('playerPauseOverlay');
    return {
      version: 6,
      gatewayReady: api?.version >= 6,
      pointerEnabled: window.__NUVIO_BROWSER_POINTER__ === true,
      playerMounted: Boolean(playerRoot),
      progressMounted: Boolean(progressShell),
      pauseOverlayMounted: Boolean(pauseOverlay),
      lastTarget,
      lastHitTarget,
      ...counters
    };
  };

  window.watchFusionExternalNuvioMouse = {
    version: 6,
    status
  };

  document.documentElement.dataset.watchFusionNuvioMouse =
    pointerApi()?.version >= 6 ? 'gateway-ready' : 'native-patch-missing';
})();
