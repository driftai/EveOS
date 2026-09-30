(() => {
  const STORAGE_KEY = 'watchfusion.partyPanelHeight';
  const DEFAULT_HEIGHT = 360;
  const MIN_HEIGHT = 150;
  const MAX_HEIGHT = 720;
  const MIN_MEDIA_HEIGHT = 180;
  const grid = document.querySelector('#app .grid');
  const panel = $('partyPanel');
  const splitter = $('roomSplitter');
  if (!grid || !panel || !splitter) return;

  function limits() {
    const available = Math.max(0, grid.getBoundingClientRect().height || innerHeight || 0);
    return {
      min: MIN_HEIGHT,
      max: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, available - MIN_MEDIA_HEIGHT - 8))
    };
  }
  function currentHeight() {
    const stored = Number(storage.get(STORAGE_KEY));
    return Number.isFinite(stored) ? stored : DEFAULT_HEIGHT;
  }
  function apply(height, persist = true) {
    const { min, max } = limits();
    const next = Math.round(Math.max(min, Math.min(max, Number(height) || DEFAULT_HEIGHT)));
    grid.style.setProperty('--watchfusion-party-height', `${next}px`);
    splitter.setAttribute('aria-valuemin', String(min));
    splitter.setAttribute('aria-valuemax', String(max));
    splitter.setAttribute('aria-valuenow', String(next));
    splitter.title = `Drag up/down to resize Watch Party · ${next}px · double-click to reset`;
    if (persist) storage.set(STORAGE_KEY, String(next));
    return next;
  }
  function reset() {
    storage.remove(STORAGE_KEY);
    apply(DEFAULT_HEIGHT, false);
  }

  let pointerId = null, startY = 0, startHeight = DEFAULT_HEIGHT;
  function finish(event) {
    if (pointerId == null || (event?.pointerId != null && event.pointerId !== pointerId)) return;
    try { splitter.releasePointerCapture(pointerId); } catch {}
    pointerId = null;
    document.documentElement.classList.remove('watchfusion-resizing');
  }
  splitter.addEventListener('pointerdown', event => {
    pointerId = event.pointerId;
    startY = event.clientY;
    startHeight = panel.getBoundingClientRect().height || apply(currentHeight(), false);
    splitter.setPointerCapture(pointerId);
    document.documentElement.classList.add('watchfusion-resizing');
    event.preventDefault();
  });
  splitter.addEventListener('pointermove', event => {
    if (pointerId !== event.pointerId) return;
    apply(startHeight + (startY - event.clientY));
  });
  splitter.addEventListener('pointerup', finish);
  splitter.addEventListener('pointercancel', finish);
  splitter.addEventListener('dblclick', reset);
  splitter.addEventListener('keydown', event => {
    if (!['ArrowUp', 'ArrowDown', 'Home'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home') return reset();
    const height = panel.getBoundingClientRect().height || currentHeight();
    apply(height + (event.key === 'ArrowUp' ? 20 : -20));
  });
  window.addEventListener('resize', () => apply(panel.getBoundingClientRect().height || currentHeight(), false));
  apply(currentHeight(), false);
  window.watchFusionRoomResize = { apply, reset };
})();
