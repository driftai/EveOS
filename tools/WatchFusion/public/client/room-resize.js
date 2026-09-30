(() => {
  const HEIGHT_KEY = 'watchfusion.partyPanelHeight';
  const WIDTH_KEY = 'watchfusion.partyPanelWidth';
  const SIDE_BREAKPOINT = 980;
  const DEFAULT_HEIGHT = 300;
  const DEFAULT_WIDTH = 320;
  const MIN_HEIGHT = 160;
  const MAX_HEIGHT = 720;
  const MIN_WIDTH = 260;
  const MAX_WIDTH = 480;
  const MIN_MAIN_WIDTH = 620;
  const MIN_MAIN_HEIGHT = 240;
  const COMPACT_MAIN_HEIGHT = 190;
  const SPLITTER_SIZE = 8;
  const grid = document.querySelector('#app .grid');
  const panel = $('partyPanel');
  const splitter = $('roomSplitter');
  if (!grid || !panel || !splitter) return;

  let mode = '';
  let pointerId = null;
  let startX = 0;
  let startY = 0;
  let startSize = 0;

  function desiredMode() {
    return grid.getBoundingClientRect().width >= SIDE_BREAKPOINT ? 'side' : 'bottom';
  }

  function storedSize(nextMode) {
    const key = nextMode === 'side' ? WIDTH_KEY : HEIGHT_KEY;
    const fallback = nextMode === 'side' ? DEFAULT_WIDTH : DEFAULT_HEIGHT;
    const stored = Number(storage.get(key));
    return Number.isFinite(stored) ? stored : fallback;
  }

  function limits(nextMode = mode || desiredMode()) {
    const rect = grid.getBoundingClientRect();
    if (nextMode === 'side') {
      return {
        min: MIN_WIDTH,
        max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, rect.width - MIN_MAIN_WIDTH - SPLITTER_SIZE))
      };
    }
    const minMain = rect.width <= 650 ? COMPACT_MAIN_HEIGHT : MIN_MAIN_HEIGHT;
    return {
      min: MIN_HEIGHT,
      max: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, rect.height - minMain - SPLITTER_SIZE))
    };
  }

  function apply(value = storedSize(mode || desiredMode()), persist = true) {
    const nextMode = mode || desiredMode();
    const { min, max } = limits(nextMode);
    const fallback = nextMode === 'side' ? DEFAULT_WIDTH : DEFAULT_HEIGHT;
    const next = Math.round(Math.max(min, Math.min(max, Number(value) || fallback)));
    const key = nextMode === 'side' ? WIDTH_KEY : HEIGHT_KEY;
    const variable = nextMode === 'side' ? '--watchfusion-party-width' : '--watchfusion-party-height';
    grid.style.setProperty(variable, `${next}px`);
    splitter.setAttribute('aria-valuemin', String(min));
    splitter.setAttribute('aria-valuemax', String(max));
    splitter.setAttribute('aria-valuenow', String(next));
    splitter.title = nextMode === 'side'
      ? `Drag left/right to resize Watch Party · ${next}px · double-click to reset`
      : `Drag up/down to resize Watch Party · ${next}px · double-click to reset`;
    if (persist) storage.set(key, String(next));
    return next;
  }

  function finish(event) {
    if (pointerId == null || (event?.pointerId != null && event.pointerId !== pointerId)) return;
    try { splitter.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    document.documentElement.classList.remove('watchfusion-resizing');
  }

  function syncMode(force = false) {
    const next = desiredMode();
    if (!force && next === mode) {
      apply(panelSize(), false);
      return;
    }
    finish();
    mode = next;
    const root = document.documentElement;
    root.classList.toggle('watchfusion-party-side', mode === 'side');
    root.classList.toggle('watchfusion-party-bottom', mode === 'bottom');
    splitter.setAttribute('aria-orientation', mode === 'side' ? 'vertical' : 'horizontal');
    apply(storedSize(mode), false);
  }

  function panelSize() {
    const rect = panel.getBoundingClientRect();
    return mode === 'side' ? rect.width : rect.height;
  }

  function reset() {
    const key = mode === 'side' ? WIDTH_KEY : HEIGHT_KEY;
    storage.remove(key);
    apply(mode === 'side' ? DEFAULT_WIDTH : DEFAULT_HEIGHT, false);
  }

  splitter.addEventListener('pointerdown', event => {
    pointerId = event.pointerId;
    startX = event.clientX;
    startY = event.clientY;
    startSize = panelSize() || apply(storedSize(mode), false);
    splitter.setPointerCapture(pointerId);
    document.documentElement.classList.add('watchfusion-resizing');
    event.preventDefault();
  });

  splitter.addEventListener('pointermove', event => {
    if (pointerId !== event.pointerId) return;
    const delta = mode === 'side' ? startX - event.clientX : startY - event.clientY;
    apply(startSize + delta);
  });
  splitter.addEventListener('pointerup', finish);
  splitter.addEventListener('pointercancel', finish);
  splitter.addEventListener('dblclick', reset);
  splitter.addEventListener('keydown', event => {
    const sideKeys = ['ArrowLeft', 'ArrowRight', 'Home'];
    const bottomKeys = ['ArrowUp', 'ArrowDown', 'Home'];
    const keys = mode === 'side' ? sideKeys : bottomKeys;
    if (!keys.includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return reset();
    const current = panelSize() || storedSize(mode);
    const delta = mode === 'side'
      ? (event.key === 'ArrowLeft' ? 20 : -20)
      : (event.key === 'ArrowUp' ? 20 : -20);
    apply(current + delta);
  });

  const observer = typeof ResizeObserver === 'function'
    ? new ResizeObserver(() => syncMode())
    : null;
  observer?.observe(grid);
  window.addEventListener('resize', () => syncMode());
  syncMode(true);

  window.watchFusionRoomResize = {
    apply,
    reset,
    mode: () => mode,
    refresh: () => syncMode(true)
  };
})();
