// Saved-library Fast Track. Reuses the Frontend library/filter and the sole Piano playback owner.
(function (ns, front, ports, taxonomy) {
  'use strict';
  if (ns.ready || !front?.ready || !ports?.ready) return;
  const LIMIT = 40;
  let host = null, pane = null, opener = null, search = null, nexusSearch = null, backdrop = null, unsubscribe = null, matchingIds = new Set();
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const panel = () => host?.querySelector('[data-audioflix-piano]');
  const query = selector => canvas()?.querySelector(selector);
  const readable = value => String(value || '').trim();
  const queueItems = () => ports.snapshot?.().queue?.items || [];
  const queuedEntries = songId => queueItems().filter(item => String(item.songId) === String(songId));
  function button(label, action, songId = '') {
    const item = document.createElement('button'); item.type = 'button';
    item.dataset.pftAction = action; item.dataset.songId = songId; item.textContent = label;
    return item;
  }
  function close(restoreFocus = true) {
    if (!pane || pane.hidden) return;
    pane.hidden = true; if (backdrop) backdrop.hidden = true;
    opener?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) opener?.focus();
  }
  function scopedMatches(term) {
    // Includes Smart scopes, folders/groups/tags/classifiers, exclusions,
    // current library view, advanced filters and library search.
    if (!term) return [];
    return (front.getVisibleSongs?.() || []).filter(song => {
      const metadata = [song.title, song.artist, song.source,
        ...(taxonomy?.folders?.(song) || []), ...(taxonomy?.groups?.(song) || []),
        ...(taxonomy?.classifiers?.(song) || []), song.identifiers?.tags || '', song.identifiers?.genre || ''];
      return metadata.some(value => String(value || '').toLowerCase().includes(term));
    });
  }
  function render() {
    if (!pane || pane.hidden) return;
    const results = pane.querySelector('[data-pft-results]');
    const status = pane.querySelector('[data-pft-status]');
    const term = String(search?.value || '').trim().toLowerCase();
    results.replaceChildren(); matchingIds.clear();
    if (!term) { status.textContent = 'Start typing to search your Piano library.'; return; }
    const matching = scopedMatches(term);
    matching.forEach(song => matchingIds.add(String(song.id)));
    status.textContent = matching.length
      ? 'Showing ' + Math.min(LIMIT, matching.length) + ' of ' + matching.length + ' matches.'
      : 'No Piano songs match this search inside the current library scope.';
    const playable = panel()?.dataset.running === 'true' && front.bridgeReady?.() === true;
    for (const song of matching.slice(0, LIMIT)) {
      const row = document.createElement('div'); row.className = 'piano-pft-result';
      const text = document.createElement('div'); text.className = 'piano-pft-result-text';
      const title = document.createElement('strong'); title.textContent = readable(song.title) || 'Untitled';
      const extras = [
        song.artist,
        ...(taxonomy?.folders?.(song) || []),
        ...(taxonomy?.groups?.(song) || []),
        ...(taxonomy?.classifiers?.(song) || [])
      ].map(readable).filter(Boolean);
      const subtitle = document.createElement('small');
      subtitle.textContent = [...new Set(extras)].slice(0, 6).join(' · ') || 'Piano song';
      text.append(title, subtitle);
      const actions = document.createElement('div'); actions.className = 'piano-pft-actions';
      actions.append(button('Jump', 'jump', song.id));
      const play = button('Play', 'play', song.id); play.disabled = !playable;
      play.title = playable ? 'Play using the current Piano Backend' : 'Start Piano and connect playback before playing';
      const queued = queuedEntries(song.id);
      const add = button('+ Queue', 'queue-add', song.id);
      add.disabled = !front.bridgeReady?.();
      add.title = add.disabled ? 'Connect the Piano Backend before changing its queue' : 'Add another copy to the shared Player Queue';
      const remove = button(queued.length > 1 ? `− Queue (${queued.length})` : '− Queue', 'queue-remove', song.id);
      remove.disabled = !queued.length || !front.bridgeReady?.();
      remove.title = queued.length ? 'Remove the most recently added matching queue entry' : 'This song is not queued';
      actions.append(play, add, remove, button('Details', 'details', song.id));
      row.append(text, actions); results.append(row);
    }
  }
  function jump(songId) {
    let row = [...(canvas()?.querySelectorAll('.piano-frontend-song') || [])]
      .find(node => node.dataset.songId === songId);
    if (!row) { const item = (front.getSongs?.() || []).find(song => String(song.id) === songId); const filter = query('[data-pf-search]'); if (item && filter) { filter.value = item.title || ''; filter.dispatchEvent(new Event('input', { bubbles: true })); row = [...(canvas()?.querySelectorAll('.piano-frontend-song') || [])].find(node => node.dataset.songId === songId); } if (!row) { render(); return null; } }
    close(false);
    row.tabIndex = -1;
    row.focus?.({ preventScroll: true });
    row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    return row;
  }
  function act(action, songId) {
    if (action === 'toggle') {
      const opening = pane.hidden;
      if (opening) { pane.hidden = false; if (backdrop) backdrop.hidden = false; opener?.setAttribute('aria-expanded', 'true'); render(); search?.focus(); }
      else close();
      return;
    }
    if (action === 'close') { close(); return; }
    if (action === 'clear') {
      if (search) { search.value = ''; render(); search.focus(); }
      return;
    }
    // A filter can change while Fast Track is open. Check again immediately
    // before Play, queue mutation, Jump or Details; never act on a stale result.
    if (!songId || !matchingIds.has(String(songId)) ||
        !scopedMatches(String(search?.value || '').trim().toLowerCase())
          .some(song => String(song.id) === String(songId))) { render(); return; }
    if (action === 'queue-add') {
      if (ports.command?.('queue:add', { songId }) !== false) render();
    } else if (action === 'queue-remove') {
      const entry = queuedEntries(songId).at(-1);
      if (entry?.queueId && ports.command?.('queue:remove', { queueId: entry.queueId }) !== false) render();
    } else if (action === 'play') {
      if (panel()?.dataset.running !== 'true' || front.bridgeReady?.() !== true) return;
      front.handleAction?.({ dataset: { afAction: 'piano-frontend-play', songId } });
      close();
    } else if (action === 'jump' || action === 'details') {
      const card = jump(songId);
      if (card && action === 'details') {
        window.EveAudioflixPianoFrontendSettings?.open?.(songId, 'settings');
      }
    }
  }
  function mount(nextHost) {
    host = nextHost || host;
    const toolbar = query('.piano-pfo-toolbar'), nexus = query('[data-pfo-search-panel]');
    const link = toolbar?.querySelector('[data-pfo-action="nexus"]');
    const librarySearch = query('[data-pf-search]');
    if (!toolbar || !link || !nexus || !librarySearch || toolbar.querySelector('[data-pft-action="toggle"]')) return;
    const combo = document.createElement('span'); combo.className = 'piano-pft-combo';
    link.before(combo); combo.append(link);
    opener = button('⌕', 'toggle'); opener.title = 'Fast Track: search Piano songs';
    opener.setAttribute('aria-label', 'Fast Track song search');
    opener.setAttribute('aria-controls', 'piano-fast-track');
    opener.setAttribute('aria-expanded', 'false'); combo.append(opener);
    backdrop = document.createElement('div'); backdrop.className = 'piano-pft-backdrop';
    backdrop.hidden = true; document.body.append(backdrop);
    pane = document.createElement('section'); pane.className = 'piano-pft-panel';
    pane.dataset.pftPanel = ''; pane.id = 'piano-fast-track';
    pane.setAttribute('role', 'dialog'); pane.setAttribute('aria-modal', 'true');
    pane.setAttribute('aria-label', 'Fast Track Piano library search'); pane.hidden = true;
    pane.innerHTML = '<div class="piano-pft-head"><strong>Fast Track · Piano songs</strong><button type="button" data-pft-action="close" aria-label="Close Fast Track">Close</button></div>'
      + '<div class="piano-pft-search"><div data-pft-input></div><button type="button" data-pft-action="clear">Clear</button></div>'
      + '<p data-pft-status role="status">Start typing to search your Piano library.</p><div data-pft-results class="piano-pft-results"></div>';
    document.body.append(pane);
    search = document.createElement('input'); search.type = 'search';
    search.setAttribute('aria-label', 'Search Piano songs in Fast Track');
    search.placeholder = 'Search titles, artists, folders, groups, tags…';
    pane.querySelector('[data-pft-input]').append(search);
    search.addEventListener('input', render);
    // Nexus link search keeps its existing library filtering behavior.
    nexusSearch = nexus.querySelector('[data-pfo-search]');
    if (!nexusSearch) {
      nexusSearch = document.createElement('input'); nexusSearch.type = 'search';
      nexusSearch.dataset.pfoSearch = ''; nexusSearch.placeholder = 'Search Piano songs';
      nexusSearch.setAttribute('aria-label', 'Nexus Piano Link search'); nexus.prepend(nexusSearch);
    }
    nexusSearch.addEventListener('input', () => { librarySearch.value = nexusSearch.value; librarySearch.dispatchEvent(new Event('input', { bubbles: true })); });
    backdrop.addEventListener('click', () => close());
    pane.addEventListener('click', event => { const control = event.target.closest?.('[data-pft-action]'); if (control) act(control.dataset.pftAction, control.dataset.songId); });
    toolbar.addEventListener('click', event => { const control = event.target.closest?.('[data-pft-action]'); if (control) { act(control.dataset.pftAction, control.dataset.songId); return; } if (event.target.closest?.('[data-pfo-action]')) close(false); });
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !pane.hidden) { event.preventDefault(); close(); } });
    unsubscribe?.(); unsubscribe = ports.subscribe?.(() => render()) || null;
    const decorate = ports.decorateSongs;
    ports.decorateSongs = (...args) => { const result = decorate?.(...args); render(); return result; };
  }
  const oldMount = front.mount;
  front.mount = nextHost => { oldMount(nextHost); mount(nextHost); };
  Object.assign(ns, { ready: true, mount, close, render, scopedMatches });
})(window.EveAudioflixPianoFastTrack = window.EveAudioflixPianoFastTrack || {},
  window.EveAudioflixPianoFrontend, window.EveAudioflixPianoFrontendPorts,
  window.EveAudioflixPianoTaxonomy);
