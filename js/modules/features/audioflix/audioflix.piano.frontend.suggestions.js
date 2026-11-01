// Themeable Piano taxonomy suggestions; native datalist popups are browser/OS-owned.
(function (ns) {
  'use strict';
  if (ns.ready) return;
  let popup = null, input = null, active = -1;
  const tax = () => window.EveAudioflixPianoTaxonomy;
  const values = (song, kind) => {
    const ids = song?.identifiers || {}, custom = ids.custom || {}, automatic = song?.automatic_identifiers || {};
    if (kind === 'folder') return tax()?.folders?.(song) || [];
    if (kind === 'group') return tax()?.assignedGroups?.(song) || [];
    if (kind === 'genre') return tax()?.list?.(ids.genre) || [];
    return tax()?.unique?.([...(tax()?.list?.(ids.tags) || []), ...(tax()?.list?.(automatic.tags) || [])]) || [];
  };
  function catalog(kind) {
    const found = new Set();
    for (const song of window.EveAudioflixPianoFrontend?.getSongs?.() || []) for (const value of values(song, kind)) found.add(value);
    return [...found].sort((a, b) => a.localeCompare(b)).slice(0, 300);
  }
  function token(node) { return node.dataset.pianoSuggestMulti === 'true' ? node.value.split(',').pop().trim() : node.value.trim(); }
  function close() { popup?.remove(); popup = null; input = null; active = -1; }
  function choose(value) {
    if (!input) return;
    if (input.dataset.pianoSuggestMulti === 'true') {
      const parts = input.value.split(','); parts[parts.length - 1] = value; input.value = parts.map(part => part.trim()).filter(Boolean).join(', ');
    } else input.value = value;
    input.dispatchEvent(new Event('input', { bubbles: true })); input.focus(); close();
  }
  function highlight(next) {
    const rows = [...(popup?.querySelectorAll('button') || [])]; if (!rows.length) return;
    active = (next + rows.length) % rows.length; rows.forEach((row, i) => row.classList.toggle('is-active', i === active)); rows[active].scrollIntoView({ block: 'nearest' });
  }
  function open(node) {
    const query = token(node).toLowerCase(), options = catalog(node.dataset.pianoSuggest).filter(value => !query || value.toLowerCase().includes(query)).slice(0, 12);
    close(); if (!options.length) return;
    input = node; popup = document.createElement('div'); popup.className = 'piano-taxonomy-suggestions'; popup.setAttribute('role', 'listbox');
    for (const value of options) { const row = document.createElement('button'); row.type = 'button'; row.textContent = value; row.setAttribute('role', 'option'); row.addEventListener('pointerdown', event => { event.preventDefault(); choose(value); }); popup.append(row); }
    document.body.append(popup); const rect = node.getBoundingClientRect(); popup.style.left = `${Math.max(8, rect.left)}px`; popup.style.top = `${rect.bottom + 4}px`; popup.style.width = `${Math.max(180, rect.width)}px`;
  }
  document.addEventListener('focusin', event => { if (event.target?.matches?.('[data-piano-suggest]')) open(event.target); });
  document.addEventListener('input', event => { if (event.target === input || event.target?.matches?.('[data-piano-suggest]')) open(event.target); });
  document.addEventListener('focusout', event => { if (event.target === input) setTimeout(() => document.activeElement === input || close(), 80); });
  document.addEventListener('keydown', event => {
    if (event.target !== input || !popup) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); highlight(active + (event.key === 'ArrowDown' ? 1 : -1)); }
    else if (event.key === 'Enter' && active >= 0) { event.preventDefault(); choose(popup.querySelectorAll('button')[active].textContent); }
    else if (event.key === 'Escape') close();
  });
  window.addEventListener('resize', close); window.addEventListener('scroll', close, true);
  Object.assign(ns, { ready: true, close, catalog });
})(window.EveAudioflixPianoSuggestions = window.EveAudioflixPianoSuggestions || {});
