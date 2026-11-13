// Piano v9B controls: existing visible-song projection + one Backend-owned queue.
(function (ns, front, ports, taxonomy) {
  'use strict';
  if (ns.ready || !front?.ready || !ports?.ready) return;
  let host = null, scopeSession = false, inFlight = false, queue = null;
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const $ = selector => canvas()?.querySelector(selector);
  const currentView = () => canvas()?.querySelector('[data-pxp-scope="queued"]')?.classList.contains('active') === true;
  const button = (label, action) => {
    const el = document.createElement('button'); el.type = 'button'; el.textContent = label;
    el.dataset.pv9b = action; return el;
  };
  const ids = songs => [...new Set(songs.map(song => String(song?.id || '')).filter(Boolean))];
  function excludedIds() {
    // Exclusions are independent of current positive scope, search and Smart filters.
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem('evePianoFrontendFocusV1') || 'null'); } catch (_) {}
    const focus = saved?.focus || {};
    const excludes = kind => new Set((Array.isArray(focus[kind]) ? focus[kind] : [])
      .filter(item => Array.isArray(item) && item.length === 2 && item[1] === -1)
      .map(item => String(item[0])));
    const folders = excludes('folder'), groups = excludes('group'), classifiers = excludes('classifier');
    const list = values => Array.isArray(values) ? values.map(String) : String(values || '').split(',').map(x => x.trim()).filter(Boolean);
    const eligible = front.getSongs?.() || [];
    return ids(eligible.filter(song => {
      const f = taxonomy?.folders?.(song) || [], g = taxonomy?.assignedGroups?.(song) || [];
      const groupValues = g.length ? g : list(taxonomy?.tab?.(song));
      const tags = list(song?.identifiers?.tags);
      const labels = [...(taxonomy?.classifiers?.(song) || []), ...tags];
      return !f.some(value => folders.has(value)) && !groupValues.some(value => groups.has(value)) &&
        !labels.some(value => classifiers.has(value));
    }));
  }
  function setLabel() {
    const playing = scopeSession && queue?.active;
    for (const el of canvas()?.querySelectorAll('[data-pv9b="scope"]') || []) {
      el.textContent = playing ? '■ Stop Scope' : '▶ Play Scope';
      el.disabled = inFlight || !front.bridgeReady?.() || (!playing && !currentView() && !(front.getVisibleSongs?.()?.length));
      el.setAttribute('aria-pressed', String(!!playing));
    }
    for (const el of canvas()?.querySelectorAll('[data-pv9b="loop"]') || []) {
      el.textContent = queue?.loop ? '🔁 Loop On' : '🔁 Activate Loop';
      el.setAttribute('aria-pressed', String(!!queue?.loop));
      el.disabled = inFlight || !front.bridgeReady?.();
    }
    const note = $('[data-pv9b-status]');
    if (note && !note.textContent) note.textContent = `${front.getVisibleSongs?.()?.length || 0} visible songs`;
  }
  function install() {
    const c = canvas(), tabs = c?.querySelector('.piano-pfo-library-tabs');
    const scopes = c?.querySelector('.piano-pfo-library-scopes');
    if (!tabs || !scopes) return;
    const smart = tabs.querySelector('.piano-pfv3-smart');
    if (smart && !scopes.querySelector('.piano-pfv3-smart')) {
      const section = document.createElement('div'); section.className = 'piano-pv9b-smart-row';
      section.append(smart); scopes.prepend(section);
    }
    if (c.querySelector('[data-pv9b-controls]')) { setLabel(); return; }
    const controls = document.createElement('div'); controls.className = 'piano-pv9b-controls';
    controls.dataset.pv9bControls = '';
    controls.append(button('▶ Play Scope', 'scope'), button('🔀 Shuffle Order', 'shuffle'),
      button('🔁 Activate Loop', 'loop'), button('🖥 Queue View', 'view'));
    tabs.append(controls);
    const status = document.createElement('span'); status.dataset.pv9bStatus = '';
    status.className = 'piano-pv9b-status'; tabs.after(status);
    const bar = c.querySelector('.piano-pxp-queue-toolbar');
    if (bar && !bar.querySelector('[data-pv9b="scope"]')) {
      const playAll = bar.querySelector('[data-af-action="piano-frontend-port-queue-play-all"]');
      if (playAll) playAll.before(button('▶ Play Scope', 'scope'));
    }
    // The existing queue panel retains its native controls; no shadow queue is created.
    setLabel();
  }
  async function run(action, payload = {}) {
    if (inFlight || !front.bridgeReady?.()) return false;
    inFlight = true; setLabel();
    const note = $('[data-pv9b-status]');
    try {
      const result = await ports.request?.(action, payload);
      if (!result?.ok) throw new Error(result?.error || 'Piano Backend did not confirm the command.');
      if (['queue:scope-play', 'queue:play-eligible'].includes(action)) scopeSession = true;
      if (action === 'queue:stop') scopeSession = false;
      if (note) note.textContent = 'Piano Backend confirmed the queue action.';
      ports.command?.('queue:get'); return true;
    } catch (error) {
      if (note) note.textContent = String(error?.message || error).slice(0, 180);
      return false;
    } finally { inFlight = false; setLabel(); }
  }
  async function act(action) {
    if (action === 'scope') {
      if (scopeSession && queue?.active) return run('queue:stop');
      if (currentView()) return run('queue:scope-play', { queuedView: true });
      const songIds = ids(front.getVisibleSongs?.() || []);
      if (!songIds.length || songIds.length > 500) {
        const note = $('[data-pv9b-status]');
        if (note) note.textContent = songIds.length ? 'Scope exceeds the 500-song queue cap.' : 'No visible Piano songs in this scope.';
        return false;
      }
      return run('queue:scope-play', { songIds });
    }
    if (action === 'shuffle') return run('queue:shuffle');
    if (action === 'loop') return run('queue:loop', { enabled: !queue?.loop });
    if (action === 'view') return window.EveAudioflixPianoFrontendInternal?.open?.() === true;
    if (action === 'play-all') {
      const songIds = excludedIds();
      if (!songIds.length || songIds.length > 500) {
        const note = $('[data-pv9b-status]');
        if (note) note.textContent = songIds.length ? 'Eligible library exceeds the 500-song queue cap.' : 'No eligible songs remain after exclusions.';
        return false;
      }
      return run('queue:play-eligible', { songIds });
    }
    return false;
  }
  // Capture original Play All to make it exclusion-aware before its generic port handler.
  document.addEventListener('click', event => {
    const c = canvas(); if (!c || !c.contains(event.target)) return;
    const btn = event.target.closest?.('[data-pv9b]');
    const legacyAll = event.target.closest?.('[data-af-action="piano-frontend-port-queue-play-all"]');
    if (!btn && !legacyAll) return;
    event.preventDefault(); event.stopImmediatePropagation();
    void act(btn?.dataset.pv9b || 'play-all');
  }, true);
  const oldMount = front.mount;
  front.mount = nextHost => { oldMount(nextHost); host = nextHost || host; install(); };
  ports.subscribe?.(next => {
    queue = next?.queue || null;
    if (!queue?.active) scopeSession = false;
    install(); setLabel();
  });
  Object.assign(ns, { ready: true, mount: install, eligibleSongIds: excludedIds });
})(window.EveAudioflixPianoV9B = window.EveAudioflixPianoV9B || {},
   window.EveAudioflixPianoFrontend, window.EveAudioflixPianoFrontendPorts,
   window.EveAudioflixPianoTaxonomy);
