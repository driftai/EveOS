// Shared Piano metadata projection. The Backend remains the only persistence owner.
(function (ns) {
  'use strict';
  if (ns.ready) return;
  function list(value, depth = 0) {
    if (depth > 3) return [];
    if (Array.isArray(value)) return value.flatMap(item => list(item, depth + 1));
    const raw = String(value || '').trim(); if (!raw) return [];
    if (/^\[.*\]$/.test(raw)) {
      for (const candidate of [raw, raw.includes('"') ? '' : raw.replace(/'/g, '"')]) {
        try { const parsed = JSON.parse(candidate); if (Array.isArray(parsed)) return list(parsed, depth + 1); } catch (_) {}
      }
    }
    return raw.split(',').map(item => item.trim()).filter(Boolean);
  }
  const unique = values => [...new Set(values.filter(Boolean))];
  const custom = song => song?.identifiers?.custom || {};
  const tab = song => String(custom(song).piano_tab || '').trim();
  const folders = song => unique(list(custom(song).piano_folders_v1).concat(list(custom(song).piano_folder)));
  const assignedGroups = song => unique(list(custom(song).piano_groups_v1).concat(list(custom(song).piano_group)));
  const groups = song => assignedGroups(song).length ? assignedGroups(song) : list(tab(song));
  const searchTerms = song => unique([...folders(song), ...groups(song)]);
  const classifiers = song => {
    const ids = song?.identifiers || {}, automatic = song?.automatic_identifiers || {};
    return unique([...list(ids.genre), ...list(ids.tags), ...list(automatic.tags)]).slice(0, 60);
  };
  const append = (current, additions) => unique([...list(current), ...list(additions)]).slice(0, 80);
  const remove = (current, value) => list(current).filter(item => item !== String(value || '').trim());
  Object.assign(ns, { ready: true, list, unique, custom, tab, folders, assignedGroups, groups, searchTerms, classifiers, append, remove });
})(window.EveAudioflixPianoTaxonomy = window.EveAudioflixPianoTaxonomy || {});
