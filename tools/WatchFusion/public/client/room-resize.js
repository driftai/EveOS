(() => {
  const STORAGE_KEY = 'watchfusion.partyPanelWidth';
  const DEFAULT_WIDTH = 340;
  const MIN_WIDTH = 230;
  const MAX_WIDTH = 560;
  const MIN_MEDIA_WIDTH = 360;
  const grid = document.querySelector('#app .grid');
  const panel = $('partyPanel');
  const splitter = $('roomSplitter');
  if (!grid || !panel || !splitter) return;

  function limits() {
    const available = Math.max(0, grid.getBoundingClientRect().width || 0);
    return {
      min: MIN_WIDTH,
      max: Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, available - MIN_MEDIA_WIDTH - 8))
    };
  }
  function currentWidth() {
    const stored = Number(storage.get(STORAGE_KEY));
    return Number.isFinite(stored) ? stored : DEFAULT_WIDTH;
  }
  function apply(width, persist = true) {
    const { min, max } = limits();
    const next = Math.round(Math.max(min, Math.min(max, Number(width) || DEFAULT_WIDTH)));
    grid.style.setProperty('--watchfusion-party-width', `${next}px`);
    splitter.setAttribute('aria-valuemin', String(min));
    splitter.setAttribute('aria-valuemax', String(max));
    splitter.setAttribute('aria-valuenow', String(next));
    splitter.title = `Drag to resize Watch Party · ${next}px · double-click to reset`;
    if (persist) storage.set(STORAGE_KEY, String(next));
    return next;
  }
  function reset() {
    storage.remove(STORAGE_KEY);
    apply(DEFAULT_WIDTH, false);
  }

  let pointerId = null, startX = 0, startWidth = DEFAULT_WIDTH;
  function finish(event) {
    if (pointerId == null || (event?.pointerId != null && event.pointerId !== pointerId)) return;
    try { splitter.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    document.documentElement.classList.remove('watchfusion-resizing');
  }
  splitter.addEventListener('pointerdown', event => {
    if (matchMedia('(max-width: 699px)').matches) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    startWidth = panel.getBoundingClientRect().width || apply(currentWidth(), false);
    splitter.setPointerCapture(pointerId);
    document.documentElement.classList.add('watchfusion-resizing');
    event.preventDefault();
  });
  splitter.addEventListener('pointermove', event => {
    if (pointerId !== event.pointerId) return;
    apply(startWidth + (startX - event.clientX));
  });
  splitter.addEventListener('pointerup', finish);
  splitter.addEventListener('pointercancel', finish);
  splitter.addEventListener('dblclick', reset);
  splitter.addEventListener('keydown', event => {
    if (!['ArrowLeft', 'ArrowRight', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return reset();
    const width = panel.getBoundingClientRect().width || currentWidth();
    apply(width + (event.key === 'ArrowLeft' ? 20 : -20));
  });
  window.addEventListener('resize', () => apply(panel.getBoundingClientRect().width || currentWidth(), false));
  apply(currentWidth(), false);
  window.watchFusionRoomResize = { apply, reset };
})();
