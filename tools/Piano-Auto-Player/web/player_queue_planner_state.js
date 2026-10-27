const PREFS_KEY = "piano_player_planner_v1";
const clean = value => String(value || "").trim();
const norm = value => clean(value).toLowerCase();
const listValue = value => [...new Set((Array.isArray(value) ? value : String(value || "").split(",")).map(clean).filter(Boolean))];
const durationText = ms => `${(Number(ms || 0) / 60000).toFixed(1)} min`;
const ratingText = value => value == null ? "—" : `${Number(value).toFixed(1)}/5`;

function safePrefs() {
  try {
    const raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}");
    return {
      search: clean(raw.search), genre: clean(raw.genre), author: clean(raw.author), host: clean(raw.host), kind: clean(raw.kind),
      tags: clean(raw.tags), minRating: clean(raw.minRating), minConversion: clean(raw.minConversion), minDuration: clean(raw.minDuration),
      maxDuration: clean(raw.maxDuration), minEvents: clean(raw.minEvents), maxEvents: clean(raw.maxEvents), sort: clean(raw.sort) || "updated",
      pill: clean(raw.pill) || "all"
    };
  } catch (_) {
    return { search: "", genre: "", author: "", host: "", kind: "", tags: "", minRating: "", minConversion: "", minDuration: "", maxDuration: "", minEvents: "", maxEvents: "", sort: "updated", pill: "all" };
  }
}

function persistPrefs(prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (_) {}
}

function tagsFor(song) {
  return [...listValue(song.identifiers?.tags), ...listValue(song.automatic_identifiers?.tags)];
}

function labelFor(song) {
  const artist = clean(song.identifiers?.author || song.artist || "");
  return artist && !clean(song.title).includes(artist) ? `${song.title} — ${artist}` : clean(song.title) || "Untitled sheet";
}

function isFavorite(song) {
  const custom = song.identifiers?.custom || {};
  if (custom.favorite === "true") return true;
  if (custom.favorite === "false") return false;
  return listValue(song.identifiers?.tags).some(tag => norm(tag) === "favorite") || Number(song.identifiers?.personal_rating) >= 4.5;
}

function filteredSongs(songs, prefs) {
  const queue = window.PianoPlayerQueue;
  const filtered = songs.filter(song => {
    const auto = song.automatic_identifiers || {}, custom = song.identifiers || {};
    if (prefs.pill === "favorites" && !isFavorite(song)) return false;
    if (prefs.pill === "sheets" && (auto.kind === "performance" || song.kind === "performance" || song.performance?.length)) return false;
    if (prefs.pill === "recordings" && !(auto.kind === "performance" || song.kind === "performance" || song.performance?.length)) return false;
    if (prefs.pill === "queued" && !queue?.hasSong?.(song.id)) return false;
    const haystack = [song.title, song.artist, custom.author, ...listValue(custom.genre), ...tagsFor(song), song.source, auto.kind].map(norm).join(" ");
    if (prefs.search && !haystack.includes(norm(prefs.search))) return false;
    if (prefs.genre && !listValue(custom.genre).some(value => norm(value) === norm(prefs.genre))) return false;
    if (prefs.author && norm(custom.author || song.artist) !== norm(prefs.author)) return false;
    if (prefs.host && norm(auto.source_host) !== norm(prefs.host)) return false;
    if (prefs.kind && norm(auto.kind) !== norm(prefs.kind)) return false;
    if (prefs.tags && !tagsFor(song).some(value => norm(value).includes(norm(prefs.tags)))) return false;
    const rating = Number(custom.personal_rating), conversion = Number(auto.conversion_rating);
    const duration = Number(auto.duration_ms || song.duration_ms || 0) / 60000, events = Number(auto.event_count || 0);
    if (prefs.minRating && !(Number.isFinite(rating) && rating >= Number(prefs.minRating))) return false;
    if (prefs.minConversion && !(Number.isFinite(conversion) && conversion >= Number(prefs.minConversion))) return false;
    if (prefs.minDuration && duration < Number(prefs.minDuration)) return false;
    if (prefs.maxDuration && duration > Number(prefs.maxDuration)) return false;
    if (prefs.minEvents && events < Number(prefs.minEvents)) return false;
    if (prefs.maxEvents && events > Number(prefs.maxEvents)) return false;
    return true;
  });
  return filtered.sort((a, b) => {
    const aa = a.automatic_identifiers || {}, bb = b.automatic_identifiers || {}, ac = a.identifiers || {}, bc = b.identifiers || {};
    if (prefs.sort === "title") return labelFor(a).localeCompare(labelFor(b));
    if (prefs.sort === "rating") return (Number(bc.personal_rating) || 0) - (Number(ac.personal_rating) || 0);
    if (prefs.sort === "conversion") return (Number(bb.conversion_rating) || -1) - (Number(aa.conversion_rating) || -1);
    if (prefs.sort === "duration-short") return Number(aa.duration_ms || 0) - Number(bb.duration_ms || 0);
    if (prefs.sort === "duration-long") return Number(bb.duration_ms || 0) - Number(aa.duration_ms || 0);
    if (prefs.sort === "events-low") return Number(aa.event_count || 0) - Number(bb.event_count || 0);
    if (prefs.sort === "events-high") return Number(bb.event_count || 0) - Number(aa.event_count || 0);
    return Number(bb.updated_at || 0) - Number(aa.updated_at || 0);
  });
}

export { clean, norm, listValue, durationText, ratingText, safePrefs, persistPrefs, labelFor, isFavorite, filteredSongs };
