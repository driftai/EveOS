import { renderQueuePreview } from './piano_queue_preview.js';

const STYLE_ID = 'pianoUnifiedWorkspaceStyles';
const LEGACY_QUEUE = '.sheet-workspace-queue';
const LEGACY_LIBRARY = '.library-panel';
const DISCLOSURE_KEY = 'piano_ui_disclosure_v1';

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

function waitForQueueApi(timeout = 4000) {
  const started = Date.now();
  return new Promise(resolve => {
    const tick = () => {
      const queue = window.PianoPlayerQueue;
      if (queue?.getState || Date.now() - started >= timeout) return resolve(queue?.getState ? queue : null);
      setTimeout(tick, 50);
    };
    tick();
  });
}

function setStatus(message, state = 'idle') {
  const text = document.getElementById('statusText');
  const chip = document.getElementById('statusChip');
  if (text) text.textContent = message;
  if (chip) chip.dataset.state = state;
}

function disclosureState() {
  try { return JSON.parse(localStorage.getItem(DISCLOSURE_KEY) || '{}') || {}; }
  catch (_) { return {}; }
}

function savedCollapsed(key, fallback) {
  const state = disclosureState();
  return Object.prototype.hasOwnProperty.call(state, key) ? !!state[key] : !!fallback;
}

function saveCollapsed(key, collapsed) {
  try {
    const state = disclosureState();
    state[key] = !!collapsed;
    localStorage.setItem(DISCLOSURE_KEY, JSON.stringify(state));
  } catch (_) {}
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
  if (!target) return false;
  target.click();
  return true;
}

function setPanelCollapsed(panel, key, collapsed, button) {
  panel.dataset.uCollapsed = collapsed ? '1' : '0';
  button.textContent = collapsed ? 'Expand' : 'Collapse';
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  saveCollapsed(key, collapsed);
}

function enhancePanelDisclosure(selector, key, defaultCollapsed) {
  const panel = document.querySelector(selector);
  const head = panel?.querySelector(':scope > .panel-head');
  if (!panel || !head || head.querySelector('[data-u-panel-toggle]')) return;
  panel.classList.add('piano-collapsible-panel');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost small piano-panel-toggle';
  button.dataset.uPanelToggle = key;
  button.setAttribute('aria-label', `Toggle ${key.replaceAll('-', ' ')}`);
  head.append(button);
  setPanelCollapsed(panel, key, savedCollapsed(key, defaultCollapsed), button);
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    setPanelCollapsed(panel, key, panel.dataset.uCollapsed !== '1', button);
  });
}

function enhanceTopLevelDisclosures() {
  enhancePanelDisclosure('.controls-panel', 'playback-controls', false);
  enhancePanelDisclosure('.recorder-panel', 'custom-performance', true);
  enhancePanelDisclosure('.search-panel', 'sheet-finder', false);
  enhancePanelDisclosure('.notation-panel', 'compatibility', true);
}

function setWorkspaceCollapsed(planner, collapsed, button) {
  planner.dataset.uCollapsed = collapsed ? '1' : '0';
  button.textContent = collapsed ? 'Expand' : 'Collapse';
  button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
  saveCollapsed('my-songs', collapsed);
}

function enhanceEditorDisclosure(planner) {
  const editor = planner.querySelector('.planner-editor');
  const head = editor?.querySelector('.planner-editor-head');
  if (!editor || !head || head.querySelector('[data-u-editor-toggle]')) return;
  const grid = editor.closest('.planner-grid');
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'ghost small piano-editor-toggle';
  button.dataset.uEditorToggle = 'true';
  button.setAttribute('aria-label', 'Toggle song or recording details');
  head.append(button);

  const apply = collapsed => {
    editor.dataset.uCollapsed = collapsed ? '1' : '0';
    grid?.classList.toggle('editor-collapsed', collapsed);
    button.textContent = collapsed ? 'Expand' : 'Collapse';
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    saveCollapsed('song-details', collapsed);
  };

  apply(savedCollapsed('song-details', true));
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    apply(editor.dataset.uCollapsed !== '1');
  });
}

function enhanceLibraryBrowserDisclosure(planner) {
  const body = planner.querySelector('.planner-body');
  if (!body || body.querySelector('.piano-library-browser')) return;
  const nodes = ['.planner-pills', '.planner-filters', '.planner-actions', '.planner-grid']
    .map(selector => planner.querySelector(selector));
  if (nodes.some(node => !node)) return;

  const browser = document.createElement('section');
  browser.className = 'piano-library-browser';
  const head = document.createElement('header');
  head.className = 'piano-library-browser-head';
  head.innerHTML = `
    <div class="piano-library-browser-copy">
      <strong>LIBRARY BROWSER</strong>
      <small>Choose songs, shape the queue, then inspect details when needed.</small>
    </div>
    <button type="button" class="ghost small" data-u-library-toggle aria-label="Toggle library browser">Collapse</button>`;
  const content = document.createElement('div');
  content.className = 'piano-library-browser-body';
  nodes[0].before(browser);
  content.append(...nodes);
  browser.append(head, content);

  const button = head.querySelector('[data-u-library-toggle]');
  const apply = collapsed => {
    browser.dataset.uCollapsed = collapsed ? '1' : '0';
    button.textContent = collapsed ? 'Expand' : 'Collapse';
    button.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    saveCollapsed('library-browser', collapsed);
  };
  apply(savedCollapsed('library-browser', false));
  button.addEventListener('click', event => {
    event.preventDefault();
    event.stopPropagation();
    apply(browser.dataset.uCollapsed !== '1');
  });
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
      <p>Build a queue, follow playback, and manage each saved song from one focused workspace.</p>
    </div>
    <div class="piano-unified-tools">
      <button type="button" data-u-import>Import</button>
      <button type="button" data-u-export>Export all</button>
      <button type="button" data-u-refresh>Refresh</button>
      <button type="button" class="ghost" data-u-workspace-toggle aria-label="Toggle My Songs workspace">Collapse</button>
    </div>`;

  const now = document.createElement('section');
  now.className = 'piano-now-playing';
  now.innerHTML = `
    <div class="piano-now-copy">
      <div class="piano-now-kicker"><span>NOW PLAYING</span><button type="button" class="ghost" data-u-view-player>View player</button></div>
      <strong data-u-current>Nothing playing</strong>
      <div class="piano-next-wrap" tabindex="0" aria-label="Show complete queue timeline">
        <small data-u-next>Queue is empty</small>
        <div class="piano-queue-preview" data-u-queue-preview role="list" aria-label="Complete queue timeline"></div>
      </div>
    </div>
    <div class="piano-now-settings">
      <label>Queue mode
        <select data-u-mode>
          <option value="manual">Manual</option>
          <option value="ordered">Ordered</option>
          <option value="shuffle">Shuffle</option>
        </select>
      </label>
      <label>Transition
        <select data-u-transition>
          <option value="250">0.25 s</option><option value="500">0.50 s</option><option value="750">0.75 s</option>
          <option value="1000">1.00 s</option><option value="1500">1.50 s</option>
        </select>
      </label>
    </div>
    <div class="piano-now-controls">
      <span data-u-position>0 / 0</span>
      <button type="button" class="primary piano-queue-toggle" data-u-play>Play queue</button>
      <div class="piano-transport-group" role="group" aria-label="Queue navigation">
        <button type="button" data-u-previous aria-label="Previous queue song" title="Previous song">◀</button>
        <button type="button" data-u-shuffle title="Shuffle songs after the current song">Shuffle</button>
        <button type="button" data-u-next-button aria-label="Next queue song" title="Next song">▶</button>
      </div>
      <button type="button" class="ghost" data-u-clear>Clear queue</button>
    </div>`;

  body.prepend(now);
  body.prepend(head);

  head.querySelector('[data-u-import]')?.addEventListener('click', () => {
    const input = document.getElementById('importLibraryInput');
    if (input) input.click();
    else proxyButton('importLibraryBtn');
  });
  head.querySelector('[data-u-export]')?.addEventListener('click', () => proxyButton('exportLibraryBtn'));
  head.querySelector('[data-u-refresh]')?.addEventListener('click', () => {
    proxyButton('refreshLibraryBtn');
  });
  now.querySelector('[data-u-view-player]')?.addEventListener('click', () => {
    document.querySelector('.progress-wrap')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  });

  const workspaceToggle = head.querySelector('[data-u-workspace-toggle]');
  if (workspaceToggle) {
    setWorkspaceCollapsed(planner, savedCollapsed('my-songs', false), workspaceToggle);
    workspaceToggle.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      setWorkspaceCollapsed(planner, planner.dataset.uCollapsed !== '1', workspaceToggle);
    });
  }

  const editorHead = planner.querySelector('.planner-editor-head > span');
  if (editorHead) editorHead.textContent = 'SONG / RECORDING DETAILS';
  const overrides = planner.querySelector('.planner-overrides > span');
  if (overrides) overrides.textContent = 'THIS SONG OVERRIDE · blank = global default';
  const queueHeading = planner.querySelector('.planner-queue-section > span');
  if (queueHeading) queueHeading.textContent = 'QUEUE / ORDER';
  enhanceEditorDisclosure(planner);
}

function bindQueueStrip(planner) {
  const current = planner.querySelector('[data-u-current]');
  const next = planner.querySelector('[data-u-next]');
  const position = planner.querySelector('[data-u-position]');
  const mode = planner.querySelector('[data-u-mode]');
  const transition = planner.querySelector('[data-u-transition]');
  const play = planner.querySelector('[data-u-play]');
  const previous = planner.querySelector('[data-u-previous]');
  const shuffle = planner.querySelector('[data-u-shuffle]');
  const nextButton = planner.querySelector('[data-u-next-button]');
  const clear = planner.querySelector('[data-u-clear]');
  const preview = planner.querySelector('[data-u-queue-preview]');
  if (!current || !next || !position || !mode || mode.dataset.bound === '1') return;
  mode.dataset.bound = '1';

  const render = () => {
    const queue = window.PianoPlayerQueue;
    const state = queue?.getState?.() || { items: [], currentId: null, active: false, mode: 'ordered', transitionMs: 750 };
    const currentIndex = state.currentId ? state.items.findIndex(item => String(item.queueId) === String(state.currentId)) : -1;
    const nextIndex = currentIndex >= 0 ? currentIndex + 1 : Math.min(Number(state.cursor) || 0, state.items.length);
    const activeItem = currentIndex >= 0 ? state.items[currentIndex] : null;
    const nextItem = state.items[nextIndex] || null;
    const shuffleMode = state.mode === 'shuffle';
    current.textContent = activeItem ? labelForQueueItem(activeItem) : (state.items.length ? 'Ready to play' : 'Nothing playing');
    next.textContent = shuffleMode && nextItem ? 'Next: Random · hover for possibilities' : nextItem ? `Next: ${labelForQueueItem(nextItem)}` : (state.items.length ? 'End of queue · hover for timeline' : 'Queue is empty');
    position.textContent = state.items.length ? `${currentIndex >= 0 ? currentIndex + 1 : Math.min(Number(state.cursor) || 0, state.items.length)} / ${state.items.length}` : '0 / 0';
    mode.value = ['manual', 'ordered', 'shuffle'].includes(state.mode) ? state.mode : 'ordered';
    if (transition) transition.value = String(state.transitionMs || 750);
    planner.dataset.queueActive = state.active ? '1' : '0';
    play.textContent = state.active ? 'Stop queue' : 'Play queue';
    play.dataset.action = state.active ? 'stop' : 'play';
    if (previous) previous.disabled = (currentIndex >= 0 ? currentIndex : Number(state.cursor) || 0) <= 0;
    if (nextButton) nextButton.disabled = nextIndex >= state.items.length;
    if (preview) renderQueuePreview(preview, {
      state, currentIndex, nextIndex, labelFor: labelForQueueItem,
      onPlay: queueId => void withQueue(live => live.playQueueId?.(queueId)),
      onMove: (queueId, targetId, after) => void withQueue(live => live.reorderQueueId?.(queueId, targetId, after)),
      onDuplicate: queueId => void withQueue(live => live.duplicateQueueIdAfter?.(queueId)),
      onRemove: queueId => void withQueue(live => live.removeQueueId?.(queueId))
    });
  };

  const withQueue = async action => {
    const queue = await waitForQueueApi();
    if (!queue) {
      setStatus('Player Queue controller is unavailable. Reload the Piano workspace and try again.', 'error');
      return null;
    }
    return action(queue);
  };

  mode.addEventListener('change', () => void withQueue(queue => queue.setMode?.(mode.value)));
  transition?.addEventListener('change', () => {
    const legacy = document.querySelector('[data-queue-transition]');
    if (!legacy) return setStatus('Queue transition control is unavailable. Reload the Piano workspace and try again.', 'error');
    legacy.value = transition.value;
    legacy.dispatchEvent(new Event('change', { bubbles: true }));
  });
  play?.addEventListener('click', () => void withQueue(queue => queue.toggleQueue?.()));
  previous?.addEventListener('click', () => void withQueue(queue => queue.previous?.()));
  shuffle?.addEventListener('click', () => void withQueue(queue => queue.shuffleRemaining?.()));
  nextButton?.addEventListener('click', () => void withQueue(queue => queue.next?.()));
  clear?.addEventListener('click', () => void withQueue(queue => queue.clearQueue?.()));
  const revealCurrent = () => {
    const row = preview?.querySelector('.current, .next, .candidate');
    if (row && preview) preview.scrollTop = Math.max(0, row.offsetTop - (preview.clientHeight - row.offsetHeight) / 2);
  };
  planner.querySelector('.piano-next-wrap')?.addEventListener('pointerenter', revealCurrent);
  planner.querySelector('.piano-next-wrap')?.addEventListener('focus', revealCurrent);
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
  enhanceTopLevelDisclosures();
  const planner = await waitFor('.sheet-workspace-planner');
  if (!planner) return null;
  hideLegacyPanels();
  buildHeader(planner);
  enhanceLibraryBrowserDisclosure(planner);
  markVisibleContract(planner);
  bindQueueStrip(planner);

  const queue = await waitForQueueApi();
  queue?.render?.();

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
