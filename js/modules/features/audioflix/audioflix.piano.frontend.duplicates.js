// Non-destructive Piano duplicate comparison and metadata merge helpers.
(function (ns) {
  'use strict';
  if (ns.ready) return;
  const list = value => (Array.isArray(value) ? value : String(value || '').split(','))
    .map(item => String(item).trim()).filter(Boolean);
  const normalizedTitle = value => String(value || '').toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ').trim();
  function canonicalSource(song) {
    const raw = String(song?.source_url || '').trim(); if (!raw) return '';
    try {
      const url = new URL(raw), host = url.hostname.toLowerCase().replace(/^www\./, '');
      let id = '';
      if (host === 'youtu.be') id = url.pathname.split('/').filter(Boolean)[0] || '';
      if (host.endsWith('youtube.com')) id = url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|embed)\/([^/?]+)/)?.[1] || '';
      if (id) return `youtube:${id.toLowerCase()}`;
      for (const key of [...url.searchParams.keys()]) if (/^(utm_|si$|feature$|fbclid$)/i.test(key)) url.searchParams.delete(key);
      url.hash = ''; url.pathname = url.pathname.replace(/\/$/, '');
      return `${host}${url.pathname}${url.search}`.toLowerCase();
    } catch (_) { return raw.toLowerCase().replace(/[?#].*$/, '').replace(/\/$/, ''); }
  }
  const keepList = song => list(song?.identifiers?.custom?.piano_duplicate_keep_v1);
  const pairKept = (a, b) => keepList(a).includes(String(b?.id)) || keepList(b).includes(String(a?.id));
  function find(songs, song) {
    const title = normalizedTitle(song?.title), source = canonicalSource(song);
    return (songs || []).filter(other => other && other.id !== song?.id && !pairKept(song, other)).map(other => {
      const hard = !!source && source === canonicalSource(other);
      const soft = !hard && !!title && title === normalizedTitle(other.title);
      return hard || soft ? { song: other, level: hard ? 'hard' : 'soft' } : null;
    }).filter(Boolean);
  }
  function keepPayload(song, other) {
    return [...new Set([...keepList(song), String(other?.id || '')].filter(Boolean))].slice(0, 20).join(',');
  }
  function mergePayload(song, other) {
    const mine = song?.identifiers || {}, theirs = other?.identifiers || {}, mineCustom = mine.custom || {}, theirCustom = theirs.custom || {};
    const rating = Math.max(Number(mine.personal_rating || 0), Number(theirs.personal_rating || 0)) || '';
    return {
      songId: song.id,
      artist: mine.author || song.artist || theirs.author || other.artist || '',
      genre: [...new Set([...list(mine.genre), ...list(theirs.genre)])].slice(0, 30).join(', '),
      tags: [...new Set([...list(mine.tags), ...list(theirs.tags)])].slice(0, 30).join(', '),
      rating,
      favorite: mineCustom.favorite === 'true' || theirCustom.favorite === 'true',
      duplicateKeep: keepPayload(song, other)
    };
  }
  function details(song) {
    const ids = song?.identifiers || {}, auto = song?.automatic_identifiers || {};
    const duration = Number(song?.duration_ms || auto.duration_ms || 0);
    return [ids.author || song?.artist || 'Unknown artist', duration ? `${(duration / 60000).toFixed(1)} min` : 'Unknown duration',
      auto.event_count ? `${auto.event_count} events` : '', canonicalSource(song) || song?.source || 'Local source'].filter(Boolean);
  }
  Object.assign(ns, { ready: true, canonicalSource, find, keepPayload, mergePayload, details });
})(window.EveAudioflixPianoDuplicateTools = window.EveAudioflixPianoDuplicateTools || {});
