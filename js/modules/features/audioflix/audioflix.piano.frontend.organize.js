// Soundboard-inspired Piano organization, projected over the Backend song owner.
(function (ns, front, ports) {
  'use strict';
  if (ns.ready || !front?.ready || !ports?.ready) return;
  let host = null, tab = '', folder = '', group = '', signature = '';
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const $ = selector => canvas()?.querySelector(selector);
  const list = value => (Array.isArray(value) ? value : String(value || '').split(','))
    .map(item => String(item).trim()).filter(Boolean);
  const custom = song => song?.identifiers?.custom || {};
  const tabOf = song => String(custom(song).piano_tab || '').trim();
  const folderOf = song => String(custom(song).piano_folder || '').trim();
  const groupOf = song => String(custom(song).piano_group || '').trim();
  const libraryGroupOf = song => groupOf(song) || tabOf(song); // non-destructive legacy fallback
  const classifiers = song => {
    const ids = song?.identifiers || {}, automatic = song?.automatic_identifiers || {};
    return [...list(ids.genre), ...list(ids.tags), ...list(automatic.tags)].slice(0, 16);
  };
  const unique = values => [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
  function button(label, action, className = '') {
    const node = document.createElement('button');
    node.type = 'button'; node.textContent = label; node.dataset.pfoAction = action; node.className = className;
    return node;
  }
  function active(buttonNode, yes) {
    buttonNode.classList.toggle('active', yes);
    buttonNode.setAttribute('aria-pressed', String(yes));
  }
  function selectCustom(kind, value) {
    const all = $('[data-pxp-scope="all"]');
    all?.click();
    tab = kind === 'tab' ? value : '';
    folder = kind === 'folder' ? value : '';
    group = kind === 'group' ? value : '';
    updateActive(); front.repaint?.();
  }
  function updateActive() {
    canvas()?.querySelectorAll('[data-pfo-tab]').forEach(node => active(node, !!tab && node.dataset.pfoTab === tab));
    canvas()?.querySelectorAll('[data-pfo-folder]').forEach(node => active(node, !!folder && node.dataset.pfoFolder === folder));
    canvas()?.querySelectorAll('[data-pfo-group]').forEach(node => active(node, !!group && node.dataset.pfoGroup === group));
  }
  function navButtons(target, values, kind) {
    if (!target) return;
    target.replaceChildren();
    if (!values.length) {
      const empty = document.createElement('span'); empty.className = 'piano-pfo-empty';
      empty.textContent = `No ${kind}s assigned yet.`; target.append(empty); return;
    }
    for (const value of values) {
      const node = button(value, kind);
      node.dataset[kind === 'tab' ? 'pfoTab' : kind === 'folder' ? 'pfoFolder' : 'pfoGroup'] = value;
      node.title = `Show Piano songs in ${value}`;
      node.addEventListener('click', () => selectCustom(kind, value));
      target.append(node);
    }
  }
  function refreshNavigation(songs) {
    const tabs = unique(songs.map(tabOf));
    const folders = unique(songs.map(folderOf));
    const groups = unique(songs.map(libraryGroupOf));
    const labels = unique(songs.flatMap(classifiers)).slice(0, 30);
    const next = JSON.stringify({ songs: songs.map(song => [song.id, song.title, tabOf(song), folderOf(song), groupOf(song)]), tabs, folders, groups, labels });
    if (next === signature) { updateActive(); return; }
    signature = next;
    navButtons($('[data-pfo-tabs]'), groups, 'group');
    navButtons($('[data-pfo-folders]'), folders, 'folder');
    navButtons($('[data-pfo-groups]'), groups, 'group');
    const classifierTarget = $('[data-pfo-classifiers]'); classifierTarget?.replaceChildren();
    for (const label of labels) {
      const node = button(label, 'classifier'); node.dataset.pfoClassifier = label;
      node.addEventListener('click', () => search(label)); classifierTarget?.append(node);
    }
    if (classifierTarget && !labels.length) {
      const empty = document.createElement('span'); empty.className = 'piano-pfo-empty'; empty.textContent = 'No classifiers found.'; classifierTarget.append(empty);
    }
    const songSelect = $('[data-pfo-song]');
    if (songSelect) {
      const before = songSelect.value; songSelect.replaceChildren();
      for (const song of songs) {
        const option = document.createElement('option'); option.value = song.id; option.textContent = song.title; songSelect.append(option);
      }
      songSelect.value = before;
      if (songSelect.selectedIndex < 0 && songSelect.options.length) songSelect.selectedIndex = 0;
      fillEditor();
    }
    updateActive();
  }
  function selectedSong() {
    const id = $('[data-pfo-song]')?.value;
    return front.getSongs?.().find(song => String(song.id) === String(id));
  }
  function fillEditor() {
    const song = selectedSong();
    const tabInput = $('[data-pfo-tab-input]'), folderInput = $('[data-pfo-folder-input]'), groupInput = $('[data-pfo-group-input]');
    if (tabInput) tabInput.value = tabOf(song);
    if (folderInput) folderInput.value = folderOf(song);
    if (groupInput) groupInput.value = groupOf(song);
  }
  function saveOrganization(clear = false) {
    const song = selectedSong(); if (!song) return;
    const sent = ports.command?.('song:update', {
      songId: song.id,
      tab: clear ? '' : $('[data-pfo-tab-input]')?.value || '',
      folder: clear ? '' : $('[data-pfo-folder-input]')?.value || '',
      group: clear ? '' : $('[data-pfo-group-input]')?.value || ''
    });
    const note = $('[data-pfo-note]');
    if (note) note.textContent = sent === false ? 'Backend is not ready.' : 'Saving through the Piano Backend…';
  }
  function search(value) {
    const primary = $('[data-pf-search]'), linked = $('[data-pfo-search]');
    if (primary) { primary.value = value; primary.dispatchEvent(new Event('input', { bubbles: true })); }
    if (linked && linked.value !== value) linked.value = value;
  }
  // Each action owns exactly one panel; the other drawers close when it opens.
  const drawers = {
    player: '[data-pfo-player-panel]', organize: '[data-pfo-manager]', nexus: '[data-pfo-search-panel]',
    classifiers: '[data-pfo-classifier-panel]', groups: '[data-pfo-group-panel]'
  };
  function togglePanel(action) {
    const target = $(drawers[action]); if (!target) return;
    const opening = target.hidden;
    Object.entries(drawers).forEach(([name, selector]) => {
      const panel = $(selector), trigger = $(`[data-pfo-action="${name}"]`);
      if (!panel) return;
      panel.hidden = !(opening && name === action);
      trigger?.setAttribute('aria-expanded', String(!panel.hidden));
      trigger?.classList.toggle('active', !panel.hidden);
    });
    if (opening && action === 'nexus' && !dockAdvancedFilters())
      console.warn('Piano frontend: backend filters not mounted yet; keeping Nexus searchable');
    if (opening && action === 'player' && !dockPlayer()) {
      console.warn('Piano frontend: player modules have not mounted; preserving the source workspace');
      target.hidden = true;
      const trigger = $('[data-pfo-action="player"]');
      trigger?.setAttribute('aria-expanded','false'); trigger?.classList.remove('active');
      return;
    }
    if (opening) target.querySelector('input,select,button')?.focus();
    if (opening && action === 'player') { ports.command?.('controls:get'); ports.command?.('queue:get'); }
  }
  // Move original DOM nodes (never clone). A deferred legacy mount is recovered once
  // through the original wrapper chain, which contains the port and media modules.
  function dockPlayer() {
    const c = canvas(), player = $('[data-pfo-player-panel]');
    if (!c || !player) return false;
    if (!c.querySelector('.piano-pxp-controls') || !c.querySelector('.piano-pxp-queue') || !c.querySelector('.piano-pxm-listener')) oldMount(host);
    for (const selector of ['.piano-pxp-controls','.piano-pxp-queue','.piano-pxm-listener']) {
      const node = c.querySelector(selector);
      if (node) { node.hidden = false; if (!player.contains(node)) player.append(node); }
    }
    c.querySelectorAll('.piano-pxp-workspace').forEach(node => {
      if (!node.querySelector('.piano-pxp-controls,.piano-pxp-queue')) node.remove();
    });
    return ['.piano-pxp-controls','.piano-pxp-queue','.piano-pxm-listener'].every(selector => !!player.querySelector(selector));
  }
  function dockAdvancedFilters() {
    const c = canvas(), nexus = $('[data-pfo-search-panel]');
    if (!c || !nexus) return false;
    let advanced = c.querySelector('.piano-pxp-advanced');
    if (!advanced) { ports.ensureFilters?.(); advanced = c.querySelector('.piano-pxp-advanced'); }
    if (!advanced) return false;
    if (!nexus.contains(advanced)) nexus.append(advanced);
    const orphan = c.querySelector('.piano-pxp-filters');
    if (orphan && !orphan.querySelector('.piano-pxp-advanced,.piano-pxp-pills')) orphan.remove();
    return nexus.contains(advanced);
  }
  function mount(nextHost) {
    host = nextHost || host;
    const library = canvas()?.querySelector('.piano-frontend-library');
    if (!library || library.querySelector('.piano-pfo-toolbar')) return;
    // A fresh organizer mount must rebuild its navigation even for the same library.
    signature = '';
    const toolbar = document.createElement('section'); toolbar.className = 'piano-pfo-toolbar';
    toolbar.innerHTML = `    <div class="piano-pfo-heading">Piano frontend tools</div>
    <div class="piano-pfo-actions" aria-label="Piano frontend header buttons">
      <button type="button" data-pfo-action="player" aria-controls="pfo-player-tools" aria-expanded="false">Player controls &amp; library tools</button>
      <button type="button" data-af-action="piano-frontend-media-import">Import Song</button>
      <button type="button" data-pfo-action="organize" aria-controls="pfo-edit-folders" aria-expanded="false">Edit Folders</button>
      <button type="button" disabled title="Future capability: convert Piano sheets into localized media files">Localize</button>
      <button type="button" disabled title="Future capability: port localized Piano media into this library">Piano Port</button>
      <button type="button" data-pfo-action="nexus" aria-controls="pfo-nexus-search" aria-expanded="false">🔎 Nexus Piano Link</button>
      <button type="button" data-pfo-action="classifiers" aria-controls="pfo-classifiers" aria-expanded="false">🏷 Classifiers</button>
      <button type="button" data-pfo-action="groups" aria-controls="pfo-groups" aria-expanded="false">Groups</button>
    </div>
    <div class="piano-pfo-drawer piano-pfo-player" data-pfo-player-panel id="pfo-player-tools" hidden></div>
    <form class="piano-pfo-search" data-pfo-search-panel id="pfo-nexus-search" hidden><input data-pfo-search type="search" placeholder="Search Piano songs" aria-label="Nexus Piano Link search"><button>Search</button></form>
    <div class="piano-pfo-drawer" data-pfo-classifier-panel id="pfo-classifiers" hidden><strong>Classifiers</strong><div data-pfo-classifiers></div></div>
    <div class="piano-pfo-drawer" data-pfo-group-panel id="pfo-groups" hidden><strong>Groups</strong><div data-pfo-groups></div></div>
    <div class="piano-pfo-manager" data-pfo-manager id="pfo-edit-folders" hidden><label>Song<select data-pfo-song></select></label><label hidden>Legacy tab<input data-pfo-tab-input maxlength="80" placeholder="Custom tab"></label><label>Folder<input data-pfo-folder-input maxlength="80" placeholder="Folder name"></label><label>Group<input data-pfo-group-input maxlength="80" placeholder="Group name"></label><div><button type="button" data-pfo-action="save">Apply</button><button type="button" data-pfo-action="clear">Clear</button></div><div class="piano-pfo-folder-list"><strong>Folders</strong><div data-pfo-folders></div></div><span data-pfo-note>Saved by the Piano Backend.</span></div>`;
    library.prepend(toolbar);
    // Keep live port/media controls mounted until the user opens their destination drawer.
    const c = canvas(), player = toolbar.querySelector('[data-pfo-player-panel]');
    c.querySelector('.piano-pxp-workspace')?.setAttribute('hidden','');
    c.querySelector('.piano-pxm-listener')?.setAttribute('hidden','');
    // Event View stays visible immediately beneath the always-visible transport controls.
    const events = c.querySelector('.piano-pxp-events');
    const transport = c.querySelector('.piano-frontend-transport');
    if (events && transport) transport.after(events);
    const filters = c.querySelector('.piano-pxp-filters');
    const advanced = filters?.querySelector('.piano-pxp-advanced');
    const search = toolbar.querySelector('[data-pfo-search-panel]');
    if (advanced && search) search.append(advanced);
    const pills = filters?.querySelector('.piano-pxp-pills') || c.querySelector('.piano-pxp-pills');
    if (pills) {
      pills.querySelector('[data-pxp-scope="sheets"]')?.remove();
      pills.querySelector('[data-pxp-scope="recordings"]')?.remove();
      pills.classList.add('piano-pfo-library-tabs');
      if (!pills.querySelector('.piano-pfo-tab-title')) {
        const title = document.createElement('span'); title.className = 'piano-pfo-tab-title'; title.textContent = 'Library groups';
        pills.prepend(title);
      }
      c.querySelector('.piano-frontend-library-head')?.after(pills);
    }
    if (filters && !filters.querySelector('.piano-pxp-advanced,.piano-pxp-pills')) filters.remove();
    const tabs = document.createElement('div'); tabs.className = 'piano-pfo-tabs'; tabs.dataset.pfoTabs = '';
    pills?.append(tabs);
    pills?.addEventListener('click', event => {
      if (!event.target.closest('[data-pxp-scope]')) return;
      tab = folder = group = ''; updateActive(); front.repaint?.();
    });
    toolbar.addEventListener('click', event => {
      const action = event.target.closest('[data-pfo-action]')?.dataset.pfoAction;
      if (action === 'player') togglePanel('player');
      else if (action === 'organize') togglePanel('organize');
      else if (action === 'nexus') togglePanel('nexus');
      else if (action === 'classifiers') togglePanel('classifiers');
      else if (action === 'groups') togglePanel('groups');
      else if (action === 'save') saveOrganization(false);
      else if (action === 'clear') saveOrganization(true);
    });
    toolbar.querySelector('[data-pfo-search-panel]')?.addEventListener('submit', event => { event.preventDefault(); search($('[data-pfo-search]')?.value || ''); });
    toolbar.querySelector('[data-pfo-search]')?.addEventListener('input', event => search(event.target.value));
    // Card Details must reveal the panel that now owns the existing editor.
    c.addEventListener('click', event => {
      if (!event.target.closest?.('[data-af-action="piano-frontend-media-details"]')) return;
      if ($('[data-pfo-player-panel]')?.hidden) togglePanel('player');
    }, true);
    toolbar.querySelector('[data-pfo-song]')?.addEventListener('change', fillEditor);
    refreshNavigation(front.getSongs?.() || []);
  }
  const oldMount = front.mount, oldMatches = ports.matches, oldDecorate = ports.decorateSongs;
  front.mount = nextHost => { oldMount(nextHost); mount(nextHost); };
  ports.matches = (song, searchText) => oldMatches(song, searchText) && (!tab || tabOf(song) === tab) && (!folder || folderOf(song) === folder) && (!group || libraryGroupOf(song) === group);
  ports.decorateSongs = (target, visible, all) => {
    oldDecorate(target, visible, all); refreshNavigation(all);
    for (const row of target.querySelectorAll('.piano-frontend-song')) {
      const song = visible.find(item => String(item.id) === String(row.dataset.songId)); if (!song) continue;
      row.dataset.tab = tabOf(song); row.dataset.folder = folderOf(song); row.dataset.group = groupOf(song);
      const details = row.querySelector('.piano-pxp-song-details');
      for (const value of [tabOf(song), folderOf(song), groupOf(song)]) if (value && details) {
        const chip = document.createElement('span'); chip.className = 'piano-pxp-chip piano-pfo-chip'; chip.textContent = value; details.append(chip);
      }
    }
  };
  Object.assign(ns, { ready: true, mount, refresh: () => refreshNavigation(front.getSongs?.() || []) });
})(window.EveAudioflixPianoFrontendOrganize = window.EveAudioflixPianoFrontendOrganize || {}, window.EveAudioflixPianoFrontend, window.EveAudioflixPianoFrontendPorts);
