// Piano v9C.1: non-modal, compact internal Queue View. The Piano Backend owns playback.
(function (ns, front, ports) {
  'use strict';
  if (ns.ready || !front?.ready || !ports?.ready) return;
  let host = null, snapshot = ports.snapshot?.() || {}, dragged = '', detached = null;
  let viewState = 'compact', returnFocus = null, listSignature = '';
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const queue = () => snapshot.queue || {};
  const view = () => canvas()?.querySelector('.piano-pfiv-overlay');
  const button = (label, action, fields = {}) => {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.dataset.pfivAction = action;
    for (const [key, value] of Object.entries(fields)) node.dataset[key] = String(value);
    return node;
  };
  function ensure() {
    const c = canvas();
    if (!c || view()) return;
    const overlay = document.createElement('div');
    overlay.className = 'piano-pfiv-overlay'; overlay.hidden = true;
    overlay.dataset.viewState = viewState;
    overlay.innerHTML = `<section class="piano-pfiv-dialog" role="dialog" aria-modal="false" aria-label="Piano queue view">
      <header class="piano-pfiv-header"><div class="piano-pfiv-heading"><span>PIANO INTERNAL VIEWER</span><h3>Shared Player Queue</h3></div>
      <div class="piano-pfiv-window-actions"><button type="button" data-pfiv-action="minimize" aria-label="Minimize queue view" title="Minimize">−</button><button type="button" data-pfiv-action="expand" aria-label="Expand queue view" title="Expand">⛶</button><button type="button" data-pfiv-action="detach" title="Open read-only detached view">Detach</button><button type="button" data-pfiv-action="close" aria-label="Close queue view" title="Close">×</button></div></header>
      <div class="piano-pfiv-body"><div class="piano-pfiv-summary"><div><small>NOW</small><strong data-pfiv-now>Nothing playing</strong></div><div><small>NEXT</small><strong data-pfiv-next>Nothing queued next</strong></div></div>
      <p class="piano-pfiv-status" data-pfiv-status role="status">Ready</p>
      <div class="piano-pfiv-tools" role="toolbar" aria-label="Shared Piano queue controls"><button type="button" data-pfiv-action="play">Play queue</button><button type="button" data-pfiv-action="stop">Stop</button><button type="button" data-pfiv-action="previous">Previous</button><button type="button" data-pfiv-action="next">Next</button><button type="button" data-pfiv-action="shuffle">Shuffle</button><button type="button" data-pfiv-action="clear">Clear queue</button></div>
      <div class="piano-pfiv-list" data-pfiv-list role="list" aria-label="Queued Piano songs"></div>
      <p class="piano-pfiv-note" data-pfiv-note>Queue and playback remain owned by the Piano Backend.</p></div></section>`;
    c.append(overlay);
    overlay.addEventListener('click', event => {
      const target = event.target.closest?.('[data-pfiv-action]');
      if (target && overlay.contains(target)) handle(target);
    });
  }
  function statusFor(item, index, state, currentIndex) {
    if (item.queueId === state.currentId) return 'current';
    if (index < Math.max(0, Number(state.cursor) || 0)) return 'played';
    if (index === currentIndex + 1 || (currentIndex < 0 && index === 0)) return 'next';
    return state.mode === 'shuffle' ? 'candidate' : 'queued';
  }
  function renderList(target, interactive = true) {
    if (!target) return;
    const state = queue(), items = Array.isArray(state.items) ? state.items : [];
    const currentIndex = items.findIndex(item => item.queueId === state.currentId);
    const manual = state.mode === 'manual';
    target.replaceChildren();
    for (const [index, item] of items.slice(0, 500).entries()) {
      const row = document.createElement('div');
      row.className = 'piano-pfiv-row piano-pxp-queue-row';
      row.setAttribute('role', 'listitem'); row.dataset.queueId = item.queueId;
      row.dataset.queueStatus = statusFor(item, index, state, currentIndex);
      row.draggable = interactive && manual;
      if (interactive && manual) {
        row.addEventListener('dragstart', event => { dragged = item.queueId; event.dataTransfer?.setData('text/plain', dragged); });
        row.addEventListener('dragover', event => { if (dragged && dragged !== item.queueId) event.preventDefault(); });
        row.addEventListener('drop', event => {
          if (!dragged || dragged === item.queueId) return;
          event.preventDefault();
          ports.command?.('queue:reorder', { queueId: dragged, targetQueueId: item.queueId,
            after: event.clientY > row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 });
          dragged = '';
        });
        row.addEventListener('dragend', () => { dragged = ''; });
      }
      const title = document.createElement('span');
      title.className = 'piano-pxp-queue-title';
      title.textContent = `${index + 1}. ${item.label || 'Untitled'}`;
      title.title = item.label || 'Untitled';
      row.append(title);
      if (interactive) {
        row.append(button('Play', 'item', { queueId: item.queueId }));
        if (manual) row.append(button('+', 'duplicate', { queueId: item.queueId }));
        row.append(button('−', 'remove', { queueId: item.queueId }));
      }
      target.append(row);
    }
    if (!items.length) {
      const empty = document.createElement('p');
      empty.className = 'piano-pfiv-empty'; empty.textContent = 'The shared Player Queue is empty.';
      target.append(empty);
    }
  }
  function applyViewState() {
    const overlay = view(); if (!overlay) return;
    overlay.dataset.viewState = viewState;
    const minimize = overlay.querySelector('[data-pfiv-action="minimize"]');
    const expand = overlay.querySelector('[data-pfiv-action="expand"]');
    if (minimize) { minimize.textContent = viewState === 'minimized' ? '▴' : '−';
      minimize.setAttribute('aria-label', viewState === 'minimized' ? 'Restore queue view' : 'Minimize queue view'); }
    if (expand) { expand.textContent = viewState === 'expanded' ? '▣' : '⛶';
      expand.setAttribute('aria-label', viewState === 'expanded' ? 'Compact queue view' : 'Expand queue view'); }
  }
  function render() {
    const overlay = view();
    if (overlay && !overlay.hidden) {
      const state = queue(), items = Array.isArray(state.items) ? state.items : [];
      const currentIndex = items.findIndex(item => item.queueId === state.currentId);
      const current = items[currentIndex], next = items[currentIndex < 0 ? 0 : currentIndex + 1];
      const now = overlay.querySelector('[data-pfiv-now]');
      const upNext = overlay.querySelector('[data-pfiv-next]');
      const status = overlay.querySelector('[data-pfiv-status]');
      if (now) now.textContent = current?.label || 'Nothing playing';
      if (upNext) upNext.textContent = next?.label || 'Nothing queued next';
      if (status) status.textContent = `${items.length} queued · ${state.mode || 'manual'} mode${state.loop ? ' · loop on' : ''}`;
      if (viewState !== 'minimized') {
        const signature = JSON.stringify([state.mode, state.cursor, state.currentId,
          items.map(item => [item.queueId, item.songId, item.label])]);
        if (signature !== listSignature) {
          renderList(overlay.querySelector('[data-pfiv-list]'));
          listSignature = signature;
        }
      }
    }
    renderDetached();
  }
  function open() {
    ensure(); const overlay = view(); if (!overlay) return false;
    returnFocus = document.activeElement;
    overlay.hidden = false;
    if (viewState === 'minimized') { viewState = 'compact'; listSignature = ''; }
    applyViewState(); render();
    overlay.querySelector('[data-pfiv-action="close"]')?.focus();
    ports.command?.('queue:get'); return true;
  }
  function close() {
    const overlay = view(); if (overlay) overlay.hidden = true;
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    returnFocus = null;
  }
  function renderDetached() {
    if (!detached || detached.closed) return;
    const state = queue(), items = Array.isArray(state.items) ? state.items : [];
    const current = items.find(item => item.queueId === state.currentId);
    const now = detached.document.querySelector('[data-now]');
    const list = detached.document.querySelector('[data-list]');
    if (now) now.textContent = current?.label || 'Nothing playing';
    renderList(list, false);
  }
  function detach() {
    detached = window.open('', 'eveos-piano-internal-viewer', 'popup,width=680,height=680');
    const note = view()?.querySelector('[data-pfiv-note]');
    if (!detached) { if (note) note.textContent = 'Pop-up blocked. Allow pop-ups to detach.'; return; }
    detached.document.open();
    detached.document.write('<!doctype html><meta charset="utf-8"><title>EveOS Piano queue</title><style>body{font:14px system-ui;background:#09191e;color:#ddf3f5;padding:20px}div[data-list]>div{display:flex;gap:8px;padding:9px;border-bottom:1px solid #31555b}div[data-list] span{flex:1}[data-queue-status=current]{background:#15414a}</style><h1>Shared Player Queue</h1><strong data-now></strong><div data-list></div><p>Read-only view. Playback remains in EveOS.</p>');
    detached.document.close(); renderDetached();
  }
  function handle(target) {
    const action = target.dataset.pfivAction;
    if (action === 'close') return close();
    if (action === 'detach') return detach();
    if (action === 'minimize') { viewState = viewState === 'minimized' ? 'compact' : 'minimized'; listSignature = ''; applyViewState(); return render(); }
    if (action === 'expand') { viewState = viewState === 'expanded' ? 'compact' : 'expanded'; listSignature = ''; applyViewState(); return render(); }
    const command = { play: 'queue:play', stop: 'queue:stop', previous: 'queue:previous', next: 'queue:next',
      shuffle: 'queue:shuffle', clear: 'queue:clear', item: 'queue:play-item', duplicate: 'queue:duplicate', remove: 'queue:remove' }[action];
    if (command) ports.command?.(command, { queueId: target.dataset.queueId });
  }
  function mount(nextHost) {
    if (nextHost && host !== nextHost) listSignature = '';
    host = nextHost || host; ensure();
    // The v9B Queue View button is the sole in-library entry point.
    canvas()?.querySelector('[data-pfiv-open]')?.remove();
  }
  const oldMount = front.mount, oldHandle = front.handleAction;
  front.mount = nextHost => { oldMount(nextHost); mount(nextHost); };
  front.handleAction = target => {
    if (target?.dataset?.afAction === 'piano-frontend-internal-open') return window.EveAudioflixPianoFrontendSettings?.open?.(target.dataset.songId, 'internal') === true;
    return oldHandle(target);
  };
  ports.subscribe?.(next => { snapshot = next || snapshot; render(); });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && view() && !view().hidden) close();
  });
  Object.assign(ns, { ready: true, open, close, expand: () => { viewState = 'expanded'; applyViewState(); render(); } });
})(window.EveAudioflixPianoFrontendInternal = window.EveAudioflixPianoFrontendInternal || {},
   window.EveAudioflixPianoFrontend, window.EveAudioflixPianoFrontendPorts);
