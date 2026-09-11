const STYLE_ID = 'pianoUnifiedWorkspaceStyles';
const LEGACY_QUEUE = '.sheet-workspace-queue';
const LEGACY_LIBRARY = '.library-panel';

function loadStyles() {
  if (document.getElementById(STYLE_ID)) return;
  const link = document.createElement('link');
  link.id = STYLE_ID;
  link.rel = 'stylesheet';
  link.href = '/assets/piano_unified_workspace.css';
  document.head.append(link);
}

function waitFor(selector, timeout = 7000) {
  const started = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      const node = document.querySelector(selector);
      if (node || Date.now() - started >= timeout) return resolve(node || null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

function queuePosition(state) {
  if (!state?.currentId || !Array.isArray(state.items)) return -1;
  return state.items.findIndex(item => String(item.queueId) === String(state.currentId));
}

function labelForQueueItem(item) {
  return String(item?.title || item?.name || item?.label || item?.song?.title || item?.songId || 'Untitled');
}

function hideLegacyPanels() {
  const queuePanel = document.querySelector(LEGACY_QUEUE);
  const libraryPanel = document.querySelector(LEGACY_LIBRARY);
  if (queuePanel) {
    queuePanel.hidden = true;
    queuePanel.setAttribute('aria-hidden', 'true');
    queuePanel.dataset.compatibilityBridge = 'player-queue';
  }
  if (libraryPanel) {
    libraryPanel.hidden = true;
    libraryPanel.setAttribute('aria-hidden', 'true');
    libraryPanel.dataset.compatibilityBridge = 'local-library';
  }
}

function proxyButton(id) {
  const target = document.getElementById(id);
  if (target) target.click();
}

function buildHeader(planner) {
  const body = planner.querySelector('.planner-body');
  if (!body || body.querySelector('.piano-unified-head')) return;
  const oldSummary = planner.querySelector(':scope > summary');
  if (oldSummary) oldSummary.hidden = true;
  planner.open = true;
  planner.classList.add('piano-unified-workspace');
  planner.addEventListener('toggle', () => { if (!planner.open) planner.open = true; });

  const head = document.createElement('header');
  head.className = 'piano-unified-head';
  head.innerHTML = `
    <div class="piano-unified-title">
      <p class="eyebrow">PIANO LIBRARY / WORKSPACE</p>
      <h2>My Songs</h2>
      <p>Saved sheets and recordings, favorites, queue order, metadata, and song-level playback settings live here.</p>
    </div>
    <div class="piano-unified-tools">
      <button type="button" data-u-import>Import</button>
      <button type="button" data-u-export>Export all</button>
      <button type="button" data-u-refresh>Refresh</button>
    </div>`;

  const now = document.createElement('section');
  now.className = 'piano-now-playing';
  now.innerHTML = `
    <div class="piano-now-copy">
      <span>NOW PLAYING</span>
      <strong data-u-current>Nothing playing</strong>
      <small data-u-next>Queue is empty</small>
    </div>
    <div class="piano-now-controls">
      <label>Queue mode
        <select data-u-mode>
          <option value="manual">Manual</option>
          <option value="ordered">Ordered</option>
          <option value="shuffle">Shuffle</option>
        </select>
      </label>
      <span data-u-position>0 / 0</span>
      <button type="button" data-u-play>Play queue</button>
      <button type="button" data-u-shuffle>Shuffle</button>
      <button type="button" data-u-stop>Stop</button>
    </div>`;

  body.prepend(now);
  body.prepend(head);

  head.querySelector('[data-u-import]')?.addEventListener('click', () => proxyButton('importLibraryBtn'));
  head.querySelector('[data-u-export]')?.addEventListener('click', () => proxyButton('exportLibraryBtn'));
  head.querySelector('[data-u-refresh]')?.addEventListener('click', () => {
    proxyButton('refreshLibraryBtn');
    window.dispatchEvent(new CustomEvent('piano:unified-refresh-requested'));
  });

  const editorHead = planner.querySelector('.planner-editor-head > span');
  if (editorHead) editorHead.textContent = 'SONG / RECORDING DETAILS';
  const overrides = planner.querySelector('.planner-overrides > span');
  if (overrides) overrides.textContent = 'THIS SONG OVERRIDE · blank = global default';
  const queueHeading = planner.querySelector('.planner-queue-section > span');
  if (queueHeading) queueHeading.textContent = 'QUEUE / ORDER';
}

function bindQueueStrip(planner) {
  const current = planner.querySelector('[data-u-current]');
  const next = planner.querySelector('[data-u-next]');
  const position = planner.querySelector('[data-u-position]');
  const mode = planner.querySelector('[data-u-mode]');
  const play = planner.querySelector('[data-u-play]');
  const shuffle = planner.querySelector('[data-u-shuffle]');
  const stop = planner.querySelector('[data-u-stop]');
  if (!current || !next || !position || !mode || mode.dataset.bound === '1') return;
  mode.dataset.bound = '1';

  const render = () => {
    const queue = window.PianoPlayerQueue;
    const state = queue?.getState?.() || { items: [], currentId: null, active: false, mode: 'manual' };
    const index = queuePosition(state);
    const activeItem = index >= 0 ? state.items[index] : null;
    const nextItem = index >= 0 ? state.items[index + 1] : state.items[0];
    current.textContent = activeItem ? labelForQueueItem(activeItem) : (state.items.length ? 'Ready to play' : 'Nothing playing');
    next.textContent = nextItem && nextItem !== activeItem ? `Next: ${labelForQueueItem(nextItem)}` : (state.items.length ? 'End of queue' : 'Queue is empty');
    position.textContent = state.items.length ? `${index >= 0 ? index + 1 : 0} / ${state.items.length}` : '0 / 0';
    mode.value = ['manual', 'ordered', 'shuffle'].includes(state.mode) ? state.mode : 'manual';
    planner.dataset.queueActive = state.active ? '1' : '0';
  };

  mode.addEventListener('change', () => window.PianoPlayerQueue?.setMode?.(mode.value));
  play?.addEventListener('click', () => void window.PianoPlayerQueue?.playQueue?.());
  shuffle?.addEventListener('click', () => window.PianoPlayerQueue?.shuffleRemaining?.());
  stop?.addEventListener('click', () => window.PianoPlayerQueue?.cancel?.('Player Queue stopped.'));
  window.addEventListener('piano:queue-updated', render);
  window.addEventListener('piano:player-queue-ready', render);
  render();
}

function markVisibleContract(planner) {
  planner.dataset.unifiedWorkspace = 'true';
  const filterbar = planner.querySelector('.planner-filterbar');
  if (filterbar) filterbar.setAttribute('aria-label', 'Search, filter, and sort My Songs');
  const list = planner.querySelector('[data-p-list]');
  if (list) list.setAttribute('aria-label', 'My Songs library and queue');
  const editor = planner.querySelector('.planner-editor');
  if (editor) editor.setAttribute('aria-label', 'Selected song or recording inspector');
}

async function installUnifiedWorkspace() {
  loadStyles();
  const planner = await waitFor('.sheet-workspace-planner');
  if (!planner) return null;
  hideLegacyPanels();
  buildHeader(planner);
  markVisibleContract(planner);
  bindQueueStrip(planner);

  // Old library/queue DOM remains only as a compatibility bridge for proven controllers and
  // persistence. Mutation can recreate those panels, so keep them non-user-facing without creating
  // a second store or transport.
  const observer = new MutationObserver(() => hideLegacyPanels());
  observer.observe(document.body, { childList: true, subtree: true });
  return planner;
}

if (document.readyState === 'loading') {
  window.addEventListener('DOMContentLoaded', () => { void installUnifiedWorkspace(); }, { once: true });
} else {
  void installUnifiedWorkspace();
}

export { installUnifiedWorkspace };
