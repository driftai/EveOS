// Piano V3 smart scopes and per-card playback projection. Playback remains Backend-owned.
(function (ns, front, ports) {
  'use strict';
  if (ns.ready || !front?.ready || !ports?.ready) return;
  const KEY = 'evePianoFrontendSmartScopeV1';
  let host = null, smart = '', snapshot = ports.snapshot?.() || {};
  const canvas = () => host?.querySelector('[data-piano-frontend]');
  const custom = song => song?.identifiers?.custom || {};
  const auto = song => song?.automatic_identifiers || {};
  const rating = song => Number(song?.identifiers?.personal_rating || 0);
  const duration = song => Number(song?.duration_ms || auto(song).duration_ms || 0);
  function restore() { try { smart = String(localStorage.getItem(KEY) || ''); } catch (_) { smart = ''; } }
  function save() { try { localStorage.setItem(KEY, smart); } catch (_) {} }
  restore();
  function smartMatches(song) {
    if (!smart) return true;
    if (smart === 'top') return rating(song) >= 4;
    if (smart === 'short') return duration(song) > 0 && duration(song) <= 180000;
    if (smart === 'long') return duration(song) >= 360000;
    if (smart === 'internal') return custom(song).piano_playback_v1?.route === 'internal';
    if (smart === 'target') return custom(song).piano_playback_v1?.route === 'target';
    if (smart === 'recent') {
      let time = Number(song.updatedAt || song.updated_at || 0); if (time && time < 100000000000) time *= 1000;
      return time > Date.now() - 90 * 86400000;
    }
    return true;
  }
  function makeButton(label, action) {
    const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
    button.dataset.pfv3Smart = action; button.setAttribute('aria-pressed', String(smart === action));
    button.classList.toggle('active', smart === action); return button;
  }
  function mountSmart() {
    const c = canvas(), tabs = c?.querySelector('.piano-pfo-library-tabs');
    if (!tabs || tabs.querySelector('.piano-pfv3-smart')) return;
    const wrap = document.createElement('div'); wrap.className = 'piano-pfv3-smart'; wrap.setAttribute('aria-label', 'Smart Piano filters');
    const label = document.createElement('span'); label.textContent = 'Smart'; wrap.append(label);
    for (const [id, text] of [['recent','Recent'],['top','Top Rated'],['short','Short'],['long','Long'],['internal','Internal'],['target','Target']]) wrap.append(makeButton(text, id));
    wrap.addEventListener('click', event => {
      const next = event.target.closest('[data-pfv3-smart]')?.dataset.pfv3Smart; if (!next) return;
      smart = smart === next ? '' : next; save();
      wrap.querySelectorAll('[data-pfv3-smart]').forEach(button => { button.classList.toggle('active', button.dataset.pfv3Smart === smart); button.setAttribute('aria-pressed', String(button.dataset.pfv3Smart === smart)); });
      front.repaint?.();
    });
    tabs.append(wrap);
  }
  function current() {
    const media = snapshot.media || {}, progress = snapshot.progress || {};
    return { id: String(media.current?.id || ''), status: String(progress.status || media.status || 'idle'),
      index: Number(progress.index || media.index || 0), total: Number(progress.total || media.total || 0),
      position: Number(media.positionMs || 0), duration: Number(media.durationMs || 0) };
  }
  function updateCards() {
    const active = current(), live = ['countdown','playing','paused'].includes(active.status);
    canvas()?.querySelectorAll('.piano-frontend-song').forEach(row => {
      const songId = String(row.dataset.songId || ''), mine = songId === active.id;
      const progress = row.querySelector('[data-pfv3-progress]'), fill = row.querySelector('[data-pfv3-fill]'), text = row.querySelector('[data-pfv3-progress-text]');
      const value = mine ? (active.total ? active.index / active.total : active.duration ? active.position / active.duration : 0) : 0;
      if (progress) { progress.hidden = !mine; progress.setAttribute('aria-valuenow', String(Math.round(Math.max(0, Math.min(1, value)) * 100))); }
      if (fill) fill.style.width = `${(Math.max(0, Math.min(1, value)) * 100).toFixed(2)}%`;
      if (text) text.textContent = mine ? `${active.status === 'paused' ? 'Paused' : 'Playing'} · ${Math.round(value * 100)}%` : '';
      const pause = row.querySelector('[data-pfv3-pause]'), stop = row.querySelector('[data-pfv3-stop]');
      if (pause) { pause.hidden = !(mine && live); pause.textContent = active.status === 'paused' ? 'Resume' : 'Pause'; pause.disabled = !mine || !live; }
      if (stop) { stop.hidden = !(mine && live); stop.disabled = !mine || !live; }
    });
  }
  function decorate(target) {
    mountSmart();
    target.querySelectorAll('.piano-frontend-song').forEach(row => {
      if (row.querySelector('[data-pfv3-progress]')) return;
      const controls = document.createElement('div'); controls.className = 'piano-pfv3-card-controls';
      const pause = document.createElement('button'); pause.type = 'button'; pause.dataset.pfv3Pause = ''; pause.dataset.afAction = 'piano-frontend-pause'; pause.textContent = 'Pause';
      const stop = document.createElement('button'); stop.type = 'button'; stop.dataset.pfv3Stop = ''; stop.dataset.afAction = 'piano-frontend-stop-song'; stop.dataset.songId = row.dataset.songId; stop.textContent = 'Stop';
      controls.append(pause, stop); row.append(controls);
      const rail = document.createElement('div'); rail.className = 'piano-pfv3-progress'; rail.dataset.pfv3Progress = ''; rail.hidden = true;
      rail.setAttribute('role', 'progressbar'); rail.setAttribute('aria-valuemin', '0'); rail.setAttribute('aria-valuemax', '100');
      const fill = document.createElement('span'); fill.dataset.pfv3Fill = '';
      const label = document.createElement('small'); label.dataset.pfv3ProgressText = ''; rail.append(fill, label); row.append(rail);
    });
    updateCards();
  }
  const oldMount = front.mount, oldMatches = ports.matches, oldDecorate = ports.decorateSongs;
  front.mount = nextHost => { oldMount(nextHost); host = nextHost || host; mountSmart(); };
  ports.matches = (song, searchText) => oldMatches(song, searchText) && smartMatches(song);
  ports.decorateSongs = (target, visible, all) => { oldDecorate(target, visible, all); decorate(target); };
  ports.subscribe?.(next => { snapshot = next || snapshot; updateCards(); });
  Object.assign(ns, { ready: true, smartMatches, updateCards });
})(window.EveAudioflixPianoFrontendV3Cards = window.EveAudioflixPianoFrontendV3Cards || {}, window.EveAudioflixPianoFrontend, window.EveAudioflixPianoFrontendPorts);
