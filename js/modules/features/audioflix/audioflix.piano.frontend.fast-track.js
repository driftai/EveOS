// Saved-library Fast Track. Reuses the Frontend library/filter and the sole Piano playback owner.
(function (ns, front, ports, taxonomy) {
  'use strict';
  if (ns.ready || !front?.ready || !ports?.ready) return;
  const LIMIT = 40;
  let host = null, pane = null, opener = null, search = null, nexusSearch = null;
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const panel = () => host?.querySelector('[data-audioflix-piano]');
  const query = selector => canvas()?.querySelector(selector);
  const readable = value => String(value || '').trim();
  function button(label, action, songId = '') {
    const item = document.createElement('button'); item.type = 'button';
    item.dataset.pftAction = action; item.dataset.songId = songId; item.textContent = label;
    return item;
  }
  function close(restoreFocus = true) {
    if (!pane || pane.hidden) return;
    pane.hidden = true;
    opener?.setAttribute('aria-expanded', 'false');
    if (restoreFocus) opener?.focus();
  }
  function render() {
    if (!pane || pane.hidden) return;
    const results = pane.querySelector('[data-pft-results]');
    const status = pane.querySelector('[data-pft-status]');
    const matching = front.getVisibleSongs?.() || [];
    results.replaceChildren();
    status.textContent = matching.length
      ? 'Showing ' + Math.min(LIMIT, matching.length) + ' of ' + matching.length + ' scoped songs.'
      : 'No songs match this search and the selected library scopes.';
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
      actions.append(play, button('Details', 'details', song.id));
      row.append(text, actions); results.append(row);
    }
  }
  function jump(songId) {
    const row = [...(canvas()?.querySelectorAll('.piano-frontend-song') || [])]
      .find(node => node.dataset.songId === songId);
    if (!row) { render(); return null; }
    close(false);
    row.tabIndex = -1;
    row.focus?.({ preventScroll: true });
    row.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
    return row;
  }
  function act(action, songId) {
    if (action === 'toggle') {
      const opening = pane.hidden;
      if (opening) { pane.hidden = false; opener?.setAttribute('aria-expanded', 'true'); render(); search?.focus(); }
      else close();
      return;
    }
    if (action === 'close') { close(); return; }
    if (action === 'clear') {
      if (search) { search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true })); search.focus(); }
      return;
    }
    if (!songId || !front.getVisibleSongs?.().some(song => song.id === songId)) return;
    if (action === 'play') {
      if (panel()?.dataset.running !== 'true' || front.bridgeReady?.() !== true) return;
      front.handleAction?.({ dataset: { afAction: 'piano-frontend-play', songId } });
      close();
    } else if (action === 'jump' || action === 'details') {
      const card = jump(songId);
      if (card && action === 'details') {
        card.querySelector('[data-af-action="piano-frontend-media-details"]')?.click();
      }
    }
  }
  function mount(nextHost) {
    host = nextHost || host;
    const toolbar = query('.piano-pfo-toolbar'), nexus = query('[data-pfo-search-panel]');
    const link = toolbar?.querySelector('[data-pfo-action="nexus"]');
    const original = query('[data-pf-search]');
    if (!toolbar || !link || !nexus || !original || toolbar.querySelector('[data-pft-action="toggle"]')) return;
    opener = button('⌕ Fast Track', 'toggle');
    opener.setAttribute('aria-label', 'Open Fast Track song search');
    opener.setAttribute('aria-controls', 'piano-fast-track');
    opener.setAttribute('aria-expanded', 'false');
    link.after(opener);
    pane = document.createElement('section');
    pane.className = 'piano-pft-panel';
    pane.dataset.pftPanel = '';
    pane.id = 'piano-fast-track';
    pane.setAttribute('role', 'dialog');
    pane.setAttribute('aria-label', 'Fast Track Piano library search');
    pane.hidden = true;
    pane.innerHTML = '<div class="piano-pft-head"><strong>Fast Track · Piano songs</strong><button type="button" data-pft-action="close" aria-label="Close Fast Track">Close</button></div>'
      + '<div class="piano-pft-search"><div data-pft-input></div><button type="button" data-pft-action="clear">Clear</button></div>'
      + '<p data-pft-status role="status"></p><div data-pft-results class="piano-pft-results"></div>';
    toolbar.append(pane);
    // Move the original search input with its existing filter listener: no second search state.
    const label = original.closest('label');
    pane.querySelector('[data-pft-input]').append(label);
    search = original;
    search.removeAttribute('data-pfo-search');
    search.setAttribute('aria-label', 'Fast Track: search saved Piano songs');
    search.placeholder = 'Search titles, artists, folders, groups, tags…';
    // Nexus Piano Link retains its own scoped-search field, synchronized with Fast Track.
    nexusSearch = document.createElement('input');
    nexusSearch.type = 'search'; nexusSearch.dataset.pfoSearch = '';
    nexusSearch.placeholder = 'Search Piano songs';
    nexusSearch.setAttribute('aria-label', 'Nexus Piano Link search');
    nexus.prepend(nexusSearch);
    nexusSearch.value = search.value;
    nexusSearch.addEventListener('input', () => {
      if (search.value === nexusSearch.value) return;
      search.value = nexusSearch.value;
      search.dispatchEvent(new Event('input', { bubbles: true }));
    });
    search.addEventListener('input', () => { nexusSearch.value = search.value; render(); });
    toolbar.addEventListener('click', event => {
      const control = event.target.closest?.('[data-pft-action]');
      if (control) { act(control.dataset.pftAction, control.dataset.songId); return; }
      if (event.target.closest?.('[data-pfo-action]')) close(false);
    });
    toolbar.addEventListener('keydown', event => {
      if (event.key === 'Escape' && !pane.hidden) { event.preventDefault(); close(); }
    });
    const decorate = ports.decorateSongs;
    ports.decorateSongs = (...args) => { const result = decorate?.(...args); render(); return result; };
  }
  const oldMount = front.mount;
  front.mount = nextHost => { oldMount(nextHost); mount(nextHost); };
  Object.assign(ns, { ready: true, mount, close, render });
})(window.EveAudioflixPianoFastTrack = window.EveAudioflixPianoFastTrack || {},
  window.EveAudioflixPianoFrontend, window.EveAudioflixPianoFrontendPorts,
  window.EveAudioflixPianoTaxonomy);
