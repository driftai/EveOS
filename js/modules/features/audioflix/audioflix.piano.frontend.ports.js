// Presentation-only ports into the existing Piano Backend selectors and PlayerQueue.
(function (ports, front) {
  'use strict';
  if (ports.ready) return;
  let host = null, remote = '', seq = 1000000, controls = null, queue = null, progress = null, media = null;
  let lastRead = 0, updating = false, scope = 'all', genre = '', author = '', source = '', tag = '', rating = '', duration = '', events = '';
  let membershipSignature = '', queueRenderSignature = '', draggedQueueId = '';
  const pending = new Map();
  const subscribers = new Set();
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const frame = () => host?.querySelector('[data-piano-frame]');
  const $ = selector => canvas()?.querySelector(selector);
  const active = () => { const panel = host?.querySelector('[data-audioflix-piano]'); return panel?.dataset.pianoView === 'frontend' && panel.dataset.running === 'true'; };
  const list = value => (Array.isArray(value) ? value : String(value || '').split(',')).map(x => String(x).trim()).filter(Boolean);
  const norm = value => String(value || '').toLowerCase().trim();
  const favorite = song => song.identifiers?.custom?.favorite === 'true' ||
    (song.identifiers?.custom?.favorite !== 'false' && (list(song.identifiers?.tags).some(x => norm(x) === 'favorite') || Number(song.identifiers?.personal_rating) >= 4.5));
  const queued = song => queue?.items?.some(item => String(item.songId) === String(song.id)) || false;
  const kind = song => song.kind === 'recording' || song.automatic_identifiers?.kind === 'performance' ? 'recording' : 'sheet';
  const durationMs = song => Number(song.automatic_identifiers?.duration_ms || song.duration_ms || 0);
  const eventCount = song => Number(song.automatic_identifiers?.event_count || 0);

  function matches(song, search) {
    if (scope === 'favorites' && !favorite(song)) return false;
    if (scope === 'sheets' && kind(song) !== 'sheet') return false;
    if (scope === 'recordings' && kind(song) !== 'recording') return false;
    if (scope === 'queued' && !queued(song)) return false;
    const id = song.identifiers || {}, auto = song.automatic_identifiers || {};
    const tags = [...list(id.tags), ...list(auto.tags)];
    const hay = [song.title, song.artist, id.author, song.source, auto.source_host, auto.kind, ...list(id.genre), ...tags].map(norm).join(' ');
    if (search && !hay.includes(norm(search))) return false;
    if (genre && !list(id.genre).some(x => norm(x) === norm(genre))) return false;
    if (author && norm(id.author || song.artist) !== norm(author)) return false;
    if (source && norm(auto.source_host || song.source) !== norm(source)) return false;
    if (tag && !tags.some(x => norm(x).includes(norm(tag)))) return false;
    if (rating && !(id.personal_rating != null && Number(id.personal_rating) >= Number(rating))) return false;
    if (duration && durationMs(song) < Number(duration) * 60000) return false;
    if (events && Number(auto.event_count || 0) < Number(events)) return false;
    return true;
  }
  function sortSongs(items, order) {
    return items.sort((a, b) => {
      if (order === 'rating') return Number(b.identifiers?.personal_rating || 0) - Number(a.identifiers?.personal_rating || 0);
      if (order === 'conversion') return Number(b.automatic_identifiers?.conversion_rating || 0) - Number(a.automatic_identifiers?.conversion_rating || 0);
      if (order === 'longest') return durationMs(b) - durationMs(a);
      if (order === 'shortest') return durationMs(a) - durationMs(b);
      if (order === 'events') return eventCount(b) - eventCount(a);
      if (order === 'az') return a.title.localeCompare(b.title);
      if (order === 'za') return b.title.localeCompare(a.title);
      if (order === 'type') return kind(a).localeCompare(kind(b)) || a.title.localeCompare(b.title);
      return b.updatedAt - a.updatedAt;
    });
  }
  function optionNodes(node, values, placeholder, selectedValue) {
    if (!node) return;
    const oldValue = selectedValue ?? node.value;
    node.replaceChildren();
    for (const { value, label } of [{value:'',label:placeholder}, ...values]) {
      const o = document.createElement('option'); o.value = String(value); o.textContent = label; node.append(o);
    }
    node.value = oldValue;
    if (node.selectedIndex < 0) node.selectedIndex = 0;
  }
  function filterOptions(all) {
    for (const [selector, pick, empty] of [
      ['[data-pxp-genre]', song => list(song.identifiers?.genre), 'All genres'],
      ['[data-pxp-author]', song => [song.identifiers?.author || song.artist].filter(Boolean), 'All authors'],
      ['[data-pxp-source]', song => [song.automatic_identifiers?.source_host || song.source].filter(Boolean), 'All sources']
    ]) {
      const node = $(selector); if (!node) continue;
      const values = [...new Set(all.flatMap(pick))].sort((a,b)=>a.localeCompare(b));
      const signature = JSON.stringify(values);
      if (node.dataset.options === signature) continue;
      node.dataset.options = signature;
      optionNodes(node, values.map(v => ({value:v,label:v})), empty);
    }
  }
  function badge(text, cls = '') {
    const el = document.createElement('span'); el.className = `piano-pxp-chip ${cls}`; el.textContent = text; return el;
  }
  function membershipCounts(items = queue?.items || []) {
    const counts = new Map();
    for (const item of items) {
      const id = String(item?.songId || '');
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    }
    return counts;
  }
  function membershipKey(counts) {
    return JSON.stringify([...counts].sort(([a], [b]) => a.localeCompare(b)));
  }
  function updateSongMembership(counts) {
    canvas()?.querySelectorAll('.piano-frontend-song[data-song-id]').forEach(row => {
      const n = counts.get(String(row.dataset.songId || '')) || 0;
      let queuedBadge = row.querySelector('[data-pxp-queued-count]');
      if (n) {
        if (!queuedBadge) {
          queuedBadge = badge('', 'is-queued'); queuedBadge.dataset.pxpQueuedCount = '';
          let details = row.querySelector('.piano-pxp-song-details');
          if (!details) {
            details = document.createElement('div'); details.className = 'piano-pxp-song-details';
            row.querySelector('.piano-frontend-song-info')?.append(details);
          }
          details.append(queuedBadge);
        }
        queuedBadge.textContent = `${n} queued`;
      } else queuedBadge?.remove();
      const remove = row.querySelector('[data-af-action="piano-frontend-port-queue-remove-song"]');
      if (remove) remove.disabled = !active() || !front.bridgeReady?.() || !n;
    });
  }
  function decorateSongs(target, visible, all) {
    filterOptions(all);
    const count = $('[data-pxp-matches]'); if (count) count.textContent = `${visible.length} shown`;
    [...target.querySelectorAll('.piano-frontend-song')].forEach((row, index) => {
      const song = visible[index]; if (!song) return;
      const n = queue?.items?.filter(item => String(item.songId) === String(song.id)).length || 0;
      const info = row.querySelector('.piano-frontend-song-info');
      if (info) {
        const details = document.createElement('div'); details.className = 'piano-pxp-song-details';
        const id = song.identifiers || {}, auto = song.automatic_identifiers || {};
        const authorText = id.author || song.artist;
        if (authorText && authorText !== song.artist) details.append(badge(authorText));
        list(id.genre).slice(0, 2).forEach(v => details.append(badge(v)));
        list(id.tags).slice(0, 3).forEach(v => details.append(badge(`#${v}`)));
        if (eventCount(song)) details.append(badge(`${eventCount(song)} events`));
        if (durationMs(song)) details.append(badge(`${(durationMs(song) / 60000).toFixed(1)} min`));
        if (id.personal_rating != null) details.append(badge(`★ ${Number(id.personal_rating).toFixed(1)}`));
        if (auto.conversion_rating != null) details.append(badge(`Conv ${Number(auto.conversion_rating).toFixed(1)}`));
        if (favorite(song)) details.append(badge('★ Favorite', 'is-favorite'));
        if (n) { const queuedBadge = badge(`${n} queued`, 'is-queued'); queuedBadge.dataset.pxpQueuedCount = ''; details.append(queuedBadge); }
        if (details.childElementCount) info.append(details);
      }
      const add = document.createElement('button'); add.type = 'button'; add.className = 'piano-pxp-add';
      add.dataset.afAction = 'piano-frontend-port-queue-add'; add.dataset.songId = song.id;
      add.textContent = '+ Queue'; add.title = `Add ${song.title} to the Player Queue`;
      add.disabled = !active() || !front.bridgeReady?.();
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'piano-pxp-remove';
      remove.dataset.afAction = 'piano-frontend-port-queue-remove-song'; remove.dataset.songId = song.id;
      remove.textContent = '− Queue'; remove.title = `Remove the latest ${song.title} entry from the Player Queue`;
      remove.disabled = !active() || !front.bridgeReady?.() || !n;
      const actions = document.createElement('div'); actions.className = 'piano-pxp-queue-actions';
      actions.append(add, remove); row.append(actions);
    });
  }
  function send(action, fields = {}) {
    const dest = front.serviceOrigin?.(), receiver = frame()?.contentWindow;
    if (!active() || !receiver || !dest) return false;
    const id = ++seq;
    pending.set(id, { action, sent: Date.now() });
    try { receiver.postMessage({ type: 'eveos:piano-frontend-port-command', action, id, ...fields }, dest); }
    catch (_) { pending.delete(id); return false; }
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); note('Piano controls did not respond. Try Refresh.'); } }, 7000);
    return true;
  }
  function note(message) { const node = $('[data-pxp-notice]'); if (node) node.textContent = message; }
  function publish() { for (const listener of subscribers) { try { listener({ controls, queue, progress, media }); } catch (_) {} } }
  function updateControls() {
    const internal = $('[data-pxp-internal]'), target = $('[data-pxp-target]');
    if (internal) internal.disabled = !active() || !controls;
    if (!controls) { for (const selector of ['[data-pxp-target]','[data-pxp-layout]','[data-pxp-sound]']) { const node = $(selector); if (node) node.disabled = true; } return; }
    if (internal) internal.checked = !!controls.internal;
    for (const [selector, key, optionsKey] of [
      ['[data-pxp-target]', 'target', 'targets'], ['[data-pxp-layout]', 'layout', 'layouts'], ['[data-pxp-sound]', 'sound', 'sounds']
    ]) {
      const node = $(selector); if (!node) continue;
      optionNodes(node, controls[optionsKey] || [], 'Choose…', controls[key]?.value || '');
      node.disabled = !active() || (key === 'target' && (!!controls.internal || !!controls.targetDisabled));
    }
    const targetLabel = $('[data-pxp-target-note]'); if (targetLabel) targetLabel.textContent = controls.internal ? 'Not used during Internal Play' : 'Sends notes to the selected window';
    if (target) target.setAttribute('aria-disabled', String(!!controls.internal || !!controls.targetDisabled));
    const sound = $('[data-pxp-sound-note]'); if (sound) sound.textContent = controls.soundStatus || 'Choose the built-in instrument';
  }
  function updateQueue() {
    const c = canvas(); if (!c) return;
    const total = c.querySelector('[data-pxp-queue-count]');
    const now = c.querySelector('[data-pxp-now]'), next = c.querySelector('[data-pxp-next]');
    const listNode = c.querySelector('[data-pxp-queue-list]');
    const items = Array.isArray(queue?.items) ? queue.items : [];
    const counts = membershipCounts(items), nextMembershipSignature = membershipKey(counts);
    const membershipChanged = membershipSignature !== nextMembershipSignature;
    const nextQueueRenderSignature = JSON.stringify([
      queue?.mode || '', queue?.currentId || '', Number(queue?.cursor) || 0, !!queue?.active,
      items.map(item => [item.queueId, item.songId, item.label])
    ]);
    membershipSignature = nextMembershipSignature;
    if (total) total.textContent = queue ? `${items.length} queued` : (active() ? 'Queue starting…' : '0 queued');
    if (now) now.textContent = queue?.currentId ? (items.find(x => x.queueId === queue.currentId)?.label || 'Ready') : 'Nothing playing';
    if (next) {
      const currentIndex = items.findIndex(x => x.queueId === queue?.currentId);
      const nextSong = currentIndex >= 0 ? items[currentIndex + 1] : items[0];
      next.textContent = nextSong?.label || 'Nothing queued next';
    }
    const mode = c.querySelector('[data-pxp-mode]'); if (mode) { mode.disabled = !active() || !queue; if (queue?.mode) mode.value = queue.mode; }
    c.querySelectorAll('.piano-pxp-queue-toolbar button').forEach(button => { button.disabled = !active() || !queue; });
    const play = c.querySelector('[data-af-action="piano-frontend-port-queue-play"]');
    if (play) play.textContent = queue?.active ? 'Playing queue' : queue?.items?.length && (queue?.currentId || Number(queue?.cursor) > 0) ? 'Resume queue' : 'Play queue';
    if (membershipChanged) {
      if (scope === 'queued') front.repaint?.();
      else updateSongMembership(counts);
    }
    if (!listNode || queueRenderSignature === nextQueueRenderSignature) return;
    queueRenderSignature = nextQueueRenderSignature;
    listNode.replaceChildren();
    const currentIndex = items.findIndex(item => item.queueId === queue?.currentId);
    const cursor = Math.max(0, Number(queue?.cursor) || 0);
    for (const [i, item] of items.slice(0, 200).entries()) {
      const row = document.createElement('div'); row.className = 'piano-pxp-queue-row';
      row.dataset.queueId = item.queueId;
      row.dataset.queueStatus = i === currentIndex ? 'current' : i < cursor ? 'played' :
        (i === currentIndex + 1 || (currentIndex < 0 && i === cursor)) ? 'next' : queue?.mode === 'shuffle' ? 'candidate' : 'queued';
      if (queue?.mode === 'manual') {
        row.draggable = true;
        row.title = 'Drag to change the Player Queue order';
        row.addEventListener('dragstart', event => {
          draggedQueueId = item.queueId; row.classList.add('dragging');
          event.dataTransfer?.setData('text/plain', item.queueId);
          if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
        });
        row.addEventListener('dragover', event => {
          if (!draggedQueueId || draggedQueueId === item.queueId) return;
          event.preventDefault();
          row.dataset.dropAfter = event.clientY >= row.getBoundingClientRect().top + row.getBoundingClientRect().height / 2 ? '1' : '0';
          if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
        });
        row.addEventListener('dragleave', () => { delete row.dataset.dropAfter; });
        row.addEventListener('drop', event => {
          event.preventDefault();
          const source = draggedQueueId || event.dataTransfer?.getData('text/plain');
          if (source && source !== item.queueId) send('queue:reorder', { queueId: source, targetQueueId: item.queueId, after: row.dataset.dropAfter === '1' });
          delete row.dataset.dropAfter;
        });
        row.addEventListener('dragend', () => {
          draggedQueueId = ''; row.classList.remove('dragging');
          listNode.querySelectorAll('[data-drop-after]').forEach(node => { delete node.dataset.dropAfter; });
        });
      }
      const title = document.createElement('span'); title.className = 'piano-pxp-queue-title'; title.textContent = `${i + 1}. ${item.label || 'Untitled'}`;
      if (item.queueId === queue.currentId) title.classList.add('is-current');
      const playItem = document.createElement('button'); playItem.type = 'button'; playItem.textContent = 'Play';
      playItem.dataset.afAction = 'piano-frontend-port-queue-play-item'; playItem.dataset.queueId = item.queueId;
      if (queue?.mode === 'manual') {
        const handle = document.createElement('span'); handle.className = 'piano-pxp-drag-handle'; handle.textContent = '↕'; handle.title = 'Drag this entry to reorder the queue';
        const duplicate = document.createElement('button'); duplicate.type = 'button'; duplicate.textContent = '+'; duplicate.title = 'Add another copy directly after this entry';
        duplicate.dataset.afAction = 'piano-frontend-port-queue-duplicate'; duplicate.dataset.queueId = item.queueId;
        row.append(handle, title, playItem, duplicate);
      } else row.append(title, playItem);
      const remove = document.createElement('button'); remove.type = 'button'; remove.textContent = '−'; remove.title = 'Remove this queue entry';
      remove.dataset.afAction = 'piano-frontend-port-queue-remove'; remove.dataset.queueId = item.queueId;
      row.append(remove); listNode.append(row);
    }
  }
  function updateEventProgress() {
    const c = canvas(); if (!c) return;
    const total = Math.max(0, Number(progress?.total || 0));
    const current = total ? Math.max(0, Math.min(total, Number(progress?.index || 0))) : 0;
    const label = c.querySelector('[data-pxp-event-count]');
    const token = c.querySelector('[data-pxp-event-token]');
    const status = c.querySelector('[data-pxp-event-state]');
    const rail = c.querySelector('[data-pxp-event-rail]');
    const fill = c.querySelector('[data-pxp-event-fill]');
    if (label) label.textContent = `${current} / ${total} events`;
    if (token) token.textContent = String(progress?.token || '—').slice(0, 120);
    if (status) status.textContent = !active() ? 'Offline' : !progress ? 'Connecting…' :
      progress.status === 'playing' ? 'Playing' : progress.status === 'paused' ? 'Paused' :
      progress.status === 'countdown' ? 'Starting…' : progress.status === 'complete' ? 'Finished' : 'Ready';
    if (rail) { rail.setAttribute('aria-valuenow', String(current)); rail.setAttribute('aria-valuemax', String(Math.max(1, total))); }
    if (fill) fill.style.width = `${total ? (100 * current / total).toFixed(2) : 0}%`;
  }
  function invalidate() {
    controls = null; queue = null; progress = null; media = null;
    membershipSignature = ''; queueRenderSignature = ''; draggedQueueId = ''; lastRead = 0;
    pending.clear(); updateControls(); updateQueue(); updateEventProgress(); publish();
  }
  function refresh(force = false) {
    const src = frame()?.getAttribute('src') || '';
    if (src !== remote) { remote = src; invalidate(); }
    if (!active()) { updateControls(); updateQueue(); updateEventProgress(); return; }
    if (force || Date.now() - lastRead > 5000) {
      send('controls:get'); send('queue:get'); send('progress:get'); send('media:get'); lastRead = Date.now();
    }
  }
  function mount() {
    const c = canvas(); if (!c || c.querySelector('.piano-pxp-controls')) return;
    const settings = document.createElement('details'); settings.className = 'piano-pxp-controls';
    settings.innerHTML = `<summary class="piano-pxp-heading"><strong>Playback setup</strong><span>Optional controls · expand to configure</span></summary>
      <div class="piano-pxp-control-grid">
        <label class="piano-pxp-toggle"><span>Internal Play</span><input type="checkbox" data-pxp-internal aria-label="Internal Play"><small>Play through the built-in Piano</small></label>
        <label><span>Target Window</span><select data-pxp-target aria-label="Piano target window" disabled><option>Connecting…</option></select><small data-pxp-target-note>External keyboard target</small></label>
        <label><span>Piano Layout</span><select data-pxp-layout aria-label="Piano layout" disabled><option>Connecting…</option></select><small>Choose the keyboard range</small></label>
        <label><span>Internal Piano Sound</span><select data-pxp-sound aria-label="Internal Piano Sound" disabled><option>Connecting…</option></select><small data-pxp-sound-note>Choose the built-in instrument</small></label>
      </div><div class="piano-pxp-mini"><button type="button" data-af-action="piano-frontend-port-controls-refresh">Refresh target windows</button><span data-pxp-notice role="status"></span></div>`;
    c.querySelector('.piano-frontend-header')?.after(settings);
    const events = document.createElement('details'); events.className = 'piano-pxp-events';
    events.setAttribute('aria-label', 'Live Piano event progress');
    events.innerHTML = `<summary class="piano-pxp-events-head"><strong>Event view</strong><span data-pxp-event-state>Connecting…</span></summary>
      <div class="piano-pxp-events-data"><span data-pxp-event-count>0 / 0 events</span><span>Current note <b data-pxp-event-token>—</b></span></div>
      <div class="piano-pxp-event-rail" data-pxp-event-rail role="progressbar" aria-label="Piano song event progression" aria-valuemin="0" aria-valuemax="1" aria-valuenow="0"><span data-pxp-event-fill></span></div>`;
    settings.before(events);
    const filter = document.createElement('section'); filter.className = 'piano-pxp-filters';
    filter.innerHTML = `<div class="piano-pxp-pills" role="group" aria-label="Piano library scope">
       <button type="button" class="active" data-pxp-scope="all">All</button><button type="button" data-pxp-scope="favorites">★ Favorites</button>
       <button type="button" data-pxp-scope="sheets">Sheets</button><button type="button" data-pxp-scope="recordings">Recordings</button><button type="button" data-pxp-scope="queued">Queued</button></div>
       <details class="piano-pxp-advanced"><summary>Advanced library filters <span data-pxp-matches></span></summary><div class="piano-pxp-filters-grid">
         <select data-pxp-genre aria-label="Filter genre"><option value="">All genres</option></select>
         <select data-pxp-author aria-label="Filter author"><option value="">All authors</option></select>
         <select data-pxp-source aria-label="Filter source"><option value="">All sources</option></select>
         <input data-pxp-tags type="search" placeholder="Search tags" aria-label="Filter tags">
         <input data-pxp-rating type="number" min="0" max="5" step="0.5" placeholder="Min rating" aria-label="Minimum rating">
         <input data-pxp-duration type="number" min="0" step="1" placeholder="Min minutes" aria-label="Minimum duration in minutes">
         <input data-pxp-events type="number" min="0" step="1" placeholder="Min events" aria-label="Minimum event count">
         <button type="button" data-af-action="piano-frontend-port-filters-clear">Reset filters</button>
       </div></details>`;
    c.querySelector('.piano-frontend-library-head')?.after(filter);
    const queuePanel = document.createElement('details'); queuePanel.className = 'piano-pxp-queue';
    queuePanel.innerHTML = `<summary><strong>Player Queue</strong><span data-pxp-queue-count>Queue starting…</span></summary>
      <div class="piano-pxp-queue-now"><div><small>NOW</small><strong data-pxp-now>Nothing playing</strong></div><div><small>NEXT</small><strong data-pxp-next>Nothing queued next</strong></div></div>
      <div class="piano-pxp-queue-toolbar"><label>Mode <select data-pxp-mode aria-label="Queue playback mode"><option value="manual">Manual</option><option value="ordered">Ordered</option><option value="shuffle">Shuffle</option></select></label>
      <button type="button" data-af-action="piano-frontend-port-queue-play">Play queue</button><button type="button" data-af-action="piano-frontend-port-queue-stop">Stop queue</button>
      <button type="button" data-af-action="piano-frontend-port-queue-previous">Previous</button><button type="button" data-af-action="piano-frontend-port-queue-next">Next</button>
      <button type="button" data-af-action="piano-frontend-port-queue-shuffle">Shuffle</button><button type="button" data-af-action="piano-frontend-port-queue-play-all">Play all</button>
      <button type="button" data-af-action="piano-frontend-port-queue-clear">Clear queue</button></div><div data-pxp-queue-list class="piano-pxp-queue-list"></div>`;
    settings.after(queuePanel);
    const sort = c.querySelector('[data-pf-sort]'); if (sort) for (const [value,text] of [['rating','Personal rating'],['conversion','Conversion rating'],['longest','Longest'],['shortest','Shortest'],['events','Most events']]) { const op=document.createElement('option');op.value=value;op.textContent=text;sort.append(op); }
    c.addEventListener('change', event => {
      const el = event.target;
      if (el.matches('[data-pxp-internal]')) {
        if (controls) { controls.internal = el.checked; updateControls(); }
        send('controls:set',{field:'internal',value:el.checked}); return;
      }
      if (el.matches('[data-pxp-target],[data-pxp-layout],[data-pxp-sound]')) {
        const id = el.matches('[data-pxp-target]') ? 'target' : el.matches('[data-pxp-layout]') ? 'layout' : 'sound';
        send('controls:set',{field:id,value:el.value}); return;
      }
      if (el.matches('[data-pxp-mode]')) { send('queue:mode',{value:el.value}); return; }
      const filters = {'[data-pxp-genre]':'genre','[data-pxp-author]':'author','[data-pxp-source]':'source'};
      for (const [selector,key] of Object.entries(filters)) if (el.matches(selector)) { if(key==='genre')genre=el.value;if(key==='author')author=el.value;if(key==='source')source=el.value;front.repaint?.();return; }
    });
    c.addEventListener('input', event => {
      const el = event.target;
      if (el.matches('[data-pxp-tags]')) tag=el.value;
      else if (el.matches('[data-pxp-rating]')) rating=el.value;
      else if (el.matches('[data-pxp-duration]')) duration=el.value;
      else if (el.matches('[data-pxp-events]')) events=el.value;
      else return;
      front.repaint?.();
    });
    c.querySelectorAll('[data-pxp-scope]').forEach(button => button.addEventListener('click', () => {
      scope = button.dataset.pxpScope;
      c.querySelectorAll('[data-pxp-scope]').forEach(b => b.classList.toggle('active', b===button));
      front.repaint?.();
    }));
    updateControls(); updateQueue(); updateEventProgress();
  }
  function handleAction(button) {
    const action = button?.dataset?.afAction || '';
    if (!action.startsWith('piano-frontend-port-')) return false;
    if (!active()) return true;
    const name = action.slice('piano-frontend-port-'.length);
    if (name === 'controls-refresh') { send('controls:refresh'); setTimeout(()=>send('controls:get'), 900); }
    else if (name === 'filters-clear') {
      genre=author=source=tag=rating=duration=events='';scope='all';
      for (const selector of ['[data-pxp-genre]','[data-pxp-author]','[data-pxp-source]','[data-pxp-tags]','[data-pxp-rating]','[data-pxp-duration]','[data-pxp-events]']) { const n=$(selector); if(n)n.value=''; }
      canvas()?.querySelector('[data-pxp-scope="all"]')?.click(); front.repaint?.();
    } else if (name === 'queue-add') send('queue:add',{songId:button.dataset.songId});
    else if (name === 'queue-remove-song') {
      const entry = [...(queue?.items || [])].reverse().find(item => String(item.songId) === String(button.dataset.songId));
      if (entry?.queueId) send('queue:remove',{queueId:entry.queueId});
    }
    else if (name === 'queue-remove') send('queue:remove',{queueId:button.dataset.queueId});
    else if (name === 'queue-duplicate') send('queue:duplicate',{queueId:button.dataset.queueId});
    else if (name === 'queue-play-item') send('queue:play-item',{queueId:button.dataset.queueId});
    else if (['queue-play','queue-stop','queue-next','queue-previous','queue-shuffle','queue-clear','queue-play-all'].includes(name)) send(name.replace('queue-','queue:'));
    return true;
  }
  window.addEventListener('message', event => {
    if (!host || event.source !== frame()?.contentWindow || event.origin !== front.serviceOrigin?.()) return;
    const data = event.data;
    if (data?.type === 'piano:eveos-port-update') {
      if (data.controls) { controls=data.controls; updateControls(); }
      if (data.queue) { queue=data.queue; updateQueue(); }
      if (data.progress) { progress=data.progress; updateEventProgress(); }
      if (data.media) media=data.media;
      publish();
      return;
    }
    if (data?.type !== 'piano:eveos-frontend-port-response' || !pending.has(data.id)) return;
    const action = pending.get(data.id)?.action; pending.delete(data.id);
    if (data.error) {
      note(data.error);
      if (action?.startsWith('queue:')) { const count = $('[data-pxp-queue-count]'); if (count) count.textContent = 'Queue unavailable · Refresh'; }
    }
    else {
      if (data.controls) { controls=data.controls; updateControls(); }
      if (data.queue) { queue=data.queue; updateQueue(); }
      if (data.progress) { progress=data.progress; updateEventProgress(); }
      if (data.media) media=data.media;
      if (!data.queue && action === 'queue:get') note('Player Queue is starting…');
      else note('');
      publish();
    }
  });
  const oldMount = front.mount, oldSync = front.sync, oldHandle = front.handleAction, oldRefresh = front.refresh;
  front.mount = h => { host = h; oldMount(h); mount(); };
  front.sync = h => { if (h) host=h; oldSync(h); refresh(); };
  front.handleAction = button => handleAction(button) || oldHandle(button);
  front.refresh = force => { oldRefresh(force); refresh(force); };
  Object.assign(ports,{
    ready:true,matches,sortSongs,
    decorateSongs(target, visible, all) { decorateSongs(target, visible, all); window.EveAudioflixPianoFrontendMedia?.decorateSongs?.(target, visible, all); },
    command: send, invalidate,
    snapshot: () => ({ controls, queue, progress, media }),
    subscribe(listener) { if (typeof listener !== 'function') return () => {}; subscribers.add(listener); listener({ controls, queue, progress, media }); return () => subscribers.delete(listener); }
  });
})(window.EveAudioflixPianoFrontendPorts = window.EveAudioflixPianoFrontendPorts || {}, window.EveAudioflixPianoFrontend);
