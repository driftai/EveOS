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

async function fetchSongs() {
  const response = await fetch("/api/songs", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Library request failed (${response.status})`);
  return Array.isArray(body.songs) ? body.songs : [];
}

async function saveIdentifiers(songId, identifiers) {
  const response = await fetch("/api/songs/identifiers", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ id: songId, identifiers })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Metadata save failed (${response.status})`);
  return body.song || null;
}

function loadStyles() {
  if (document.getElementById("pianoPlayerPlannerStyles")) return;
  const link = document.createElement("link");
  link.id = "pianoPlayerPlannerStyles";
  link.rel = "stylesheet";
  link.href = "/assets/player_queue_advanced.css";
  document.head.append(link);
}

function waitForWorkspace(timeout = 6000) {
  const started = Date.now();
  return new Promise(resolve => {
    const check = () => {
      const host = document.querySelector(".sheet-workspace");
      if (host || Date.now() - started >= timeout) return resolve(host || null);
      setTimeout(check, 100);
    };
    check();
  });
}

function waitForQueueApi(timeout = 4000) {
  const started = Date.now();
  return new Promise(resolve => {
    const check = () => {
      const queue = window.PianoPlayerQueue;
      if (queue?.addSongs || Date.now() - started >= timeout) return resolve(queue?.addSongs ? queue : null);
      setTimeout(check, 50);
    };
    check();
  });
}

function htmlFor(host) {
  const section = document.createElement("details");
  section.className = "sheet-workspace-planner";
  section.innerHTML = `
    <summary><span><strong>ADVANCED PLAYBACK</strong><small>Smart selection, identifiers, ratings, and queue planning.</small></span><b data-planner-count>0 matches</b></summary>
    <div class="planner-body">
      <div class="planner-pills" data-p-pills>
        <button type="button" class="planner-pill" data-pill="all">All</button><button type="button" class="planner-pill" data-pill="favorites">★ Favorites</button><button type="button" class="planner-pill" data-pill="sheets">Sheets</button><button type="button" class="planner-pill" data-pill="recordings">Recordings</button><button type="button" class="planner-pill" data-pill="queued">Queued</button>
      </div>
      <div class="planner-filterbar">
        <input data-p-search placeholder="Search title, author, tags…" aria-label="Search library metadata">
        <select data-p-genre aria-label="Genre"><option value="">All genres</option></select><select data-p-author aria-label="Author"><option value="">All authors</option></select><select data-p-host aria-label="Source"><option value="">All sources</option></select><select data-p-kind aria-label="Song type"><option value="">All types</option></select>
        <input data-p-tags placeholder="Required tag" aria-label="Required tag">
        <input data-p-min-rating type="number" min="0" max="5" step="0.5" placeholder="Min personal rating"><input data-p-min-conversion type="number" min="0" max="5" step="0.5" placeholder="Min conversion rating">
        <input data-p-min-duration type="number" min="0" step="1" placeholder="Min minutes"><input data-p-max-duration type="number" min="0" step="1" placeholder="Max minutes">
        <input data-p-min-events type="number" min="0" step="1" placeholder="Min events"><input data-p-max-events type="number" min="0" step="1" placeholder="Max events">
        <select data-p-sort aria-label="Sort matching songs">
          <option value="updated">Recently updated</option><option value="title">Title A–Z</option><option value="rating">Personal rating ↓</option><option value="conversion">Conversion rating ↓</option>
          <option value="duration-short">Shortest first</option><option value="duration-long">Longest first</option><option value="events-low">Fewest events first</option><option value="events-high">Most events first</option>
        </select>
      </div>
      <div class="planner-actions">
        <span data-p-selection>0 selected</span>
        <button type="button" data-p-select-all>Select visible</button><button type="button" class="ghost" data-p-clear-selection>Clear selection</button>
        <button type="button" class="primary" data-p-add>Send to Queue</button><button type="button" data-p-replace>Replace Queue</button><button type="button" data-p-play>Play selected</button><button type="button" data-p-shuffle>Shuffle selected</button>
      </div>
      <div class="planner-grid">
        <div class="planner-results"><div class="planner-list" data-p-list></div></div>
        <aside class="planner-editor">
          <div class="planner-editor-head"><span>IDENTIFIERS</span><strong data-p-editor-title>No song selected for editing</strong></div>
          <label><span>Author</span><input data-p-author-edit placeholder="Author / artist"></label>
          <label><span>Genre</span><input data-p-genre-edit placeholder="Anime, electronic, classical…"></label>
          <label><span>Tags</span><input data-p-tags-edit placeholder="calm, boss-fight, favorite…"></label>
          <label><span>Personal rating</span><select data-p-rating-edit><option value="">Unrated</option><option>1</option><option>1.5</option><option>2</option><option>2.5</option><option>3</option><option>3.5</option><option>4</option><option>4.5</option><option>5</option></select></label>
          <label><span>Custom identifiers · key=value per line</span><textarea data-p-custom-edit placeholder="era=2020s&#10;energy=high&#10;context=late-night"></textarea></label>
          <div class="planner-overrides">
            <span>PLAYBACK OVERRIDES</span>
            <div class="planner-override-grid">
              <label><span>Speed (×)</span><input data-p-ov-speed type="number" min="0.25" max="3" step="0.05" placeholder="Default"></label><label><span>Interval (ms)</span><input data-p-ov-interval type="number" min="25" max="500" step="5" placeholder="Default"></label>
              <label><span>Hold (ms)</span><input data-p-ov-hold type="number" min="2" max="100" step="1" placeholder="Default"></label><label><span>Gate (%)</span><input data-p-ov-gate type="number" min="20" max="80" step="1" placeholder="Default"></label>
            </div>
          </div>
          <div class="planner-queue-section">
            <span>QUEUE STATUS</span>
            <div class="planner-queue-row">
              <span data-p-queue-status>Not queued</span>
              <div class="planner-queue-btns"><button type="button" class="small ghost" data-p-q-play>Play</button><button type="button" class="small ghost" data-p-q-toggle>+ Queue</button><button type="button" class="small ghost" data-p-q-up title="Move up">↑</button><button type="button" class="small ghost" data-p-q-down title="Move down">↓</button></div>
            </div>
          </div>
          <div class="planner-auto"><span>AUTOMATIC</span><div data-p-auto-chips></div></div>
          <button type="button" class="primary" data-p-save-meta disabled>Save identifiers</button>
        </aside>
      </div>
    </div>`;
  host.append(section);
  return section;
}

function tagsFor(song) {
  const custom = song.identifiers || {};
  return [...listValue(custom.tags), ...listValue(song.automatic_identifiers?.tags)];
}

function labelFor(song) {
  const artist = clean(song.identifiers?.author || song.artist || "");
  return artist && !clean(song.title).includes(artist) ? `${song.title} — ${artist}` : clean(song.title) || "Untitled sheet";
}

function isFavorite(song) {
  const custom = song.identifiers?.custom || {};
  if (custom.favorite === "true") return true;
  if (custom.favorite === "false") return false;
  return listValue(song.identifiers?.tags).some(t => norm(t) === "favorite") || Number(song.identifiers?.personal_rating) >= 4.5;
}

function filteredSongs(songs, prefs) {
  const queue = window.PianoPlayerQueue;
  const filtered = songs.filter(song => {
    const auto = song.automatic_identifiers || {}, custom = song.identifiers || {};
    if (prefs.pill === "favorites" && !isFavorite(song)) return false;
    if (prefs.pill === "sheets" && (auto.kind === "performance" || song.kind === "performance" || (song.performance?.length))) return false;
    if (prefs.pill === "recordings" && !(auto.kind === "performance" || song.kind === "performance" || (song.performance?.length))) return false;
    if (prefs.pill === "queued" && !(queue?.hasSong && queue.hasSong(song.id))) return false;
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

async function installPlanner() {
  loadStyles();
  const host = await waitForWorkspace();
  if (!host || host.querySelector(".sheet-workspace-planner")) return;
  const section = htmlFor(host);
  const els = {
    search: section.querySelector("[data-p-search]"), genre: section.querySelector("[data-p-genre]"), author: section.querySelector("[data-p-author]"),
    host: section.querySelector("[data-p-host]"), kind: section.querySelector("[data-p-kind]"), tags: section.querySelector("[data-p-tags]"),
    minRating: section.querySelector("[data-p-min-rating]"), minConversion: section.querySelector("[data-p-min-conversion]"), minDuration: section.querySelector("[data-p-min-duration]"),
    maxDuration: section.querySelector("[data-p-max-duration]"), minEvents: section.querySelector("[data-p-min-events]"), maxEvents: section.querySelector("[data-p-max-events]"), sort: section.querySelector("[data-p-sort]"),
    list: section.querySelector("[data-p-list]"), count: section.querySelector("[data-planner-count]"), selection: section.querySelector("[data-p-selection]"),
    editorTitle: section.querySelector("[data-p-editor-title]"), authorEdit: section.querySelector("[data-p-author-edit]"), genreEdit: section.querySelector("[data-p-genre-edit]"), tagsEdit: section.querySelector("[data-p-tags-edit]"), ratingEdit: section.querySelector("[data-p-rating-edit]"),
    customEdit: section.querySelector("[data-p-custom-edit]"), autoChips: section.querySelector("[data-p-auto-chips]"), saveMeta: section.querySelector("[data-p-save-meta]"),
    ovSpeed: section.querySelector("[data-p-ov-speed]"), ovInterval: section.querySelector("[data-p-ov-interval]"), ovHold: section.querySelector("[data-p-ov-hold]"), ovGate: section.querySelector("[data-p-ov-gate]"),
    queueStatus: section.querySelector("[data-p-queue-status]"), qPlay: section.querySelector("[data-p-q-play]"), qToggle: section.querySelector("[data-p-q-toggle]"), qUp: section.querySelector("[data-p-q-up]"), qDown: section.querySelector("[data-p-q-down]")
  };
  const state = { songs: [], prefs: safePrefs(), selected: new Set(), editingId: "" };
  const favoritePending = new Set();
  let busy = false;

  function toast(message, status = "idle") {
    const text = document.getElementById("statusText"), chip = document.getElementById("statusChip");
    if (text) text.textContent = message;
    if (chip) chip.dataset.state = status;
  }

  async function withQueue(action) {
    const queue = await waitForQueueApi();
    if (!queue) return toast("Player Queue controller is unavailable. Reload the Piano workspace and try again.", "error");
    return action(queue);
  }

  function syncPrefsToControls() {
    Object.entries(state.prefs).forEach(([key, value]) => { if (els[key]) els[key].value = value; });
    section.querySelectorAll("[data-pill]").forEach(btn => btn.classList.toggle("active", btn.dataset.pill === state.prefs.pill));
  }
  function savePrefs() {
    state.prefs = { ...state.prefs, ...Object.fromEntries(Object.keys(state.prefs).filter(k => els[k]).map(key => [key, els[key]?.value || ""])) };
    persistPrefs(state.prefs);
  }

  function optionList(select, values, label) {
    const current = select.value;
    select.replaceChildren(new Option(label, ""));
    [...new Set(values.filter(Boolean).map(clean))].sort((a, b) => a.localeCompare(b)).forEach(value => select.append(new Option(value, value)));
    if ([...select.options].some(option => option.value === current)) select.value = current;
  }

  function renderFilterOptions() {
    optionList(els.genre, state.songs.flatMap(song => listValue(song.identifiers?.genre)), "All genres");
    optionList(els.author, state.songs.map(song => song.identifiers?.author || song.artist).filter(Boolean), "All authors");
    optionList(els.host, state.songs.map(song => song.automatic_identifiers?.source_host).filter(Boolean), "All sources");
    optionList(els.kind, state.songs.map(song => song.automatic_identifiers?.kind || song.kind).filter(Boolean), "All types");
  }

  function renderAuto(song) {
    const auto = song?.automatic_identifiers || {};
    const chips = [
      ["SOURCE", auto.source || song.source || "—"], ["HOST", auto.source_host || "local"], ["TYPE", auto.kind || song.kind || "sheet"],
      ["DURATION", durationText(auto.duration_ms || song.duration_ms)], ["EVENTS", Number(auto.event_count || 0).toLocaleString()], ["NOTES", Number(auto.note_count || 0).toLocaleString()],
      ["DENSITY", `${auto.event_density_per_minute || 0}/min`], ["ENGINE", auto.transcription_engine || "—"], ["QUALITY", auto.transcription_quality || "—"], ["CONVERSION", ratingText(auto.conversion_rating)]
    ];
    els.autoChips.replaceChildren(...chips.map(([key, value]) => {
      const node = document.createElement("span"), label = document.createElement("b");
      label.textContent = key; node.append(label, document.createTextNode(String(value))); return node;
    }));
  }

  function currentQueueIndex(qState) {
    if (!qState?.currentId || !Array.isArray(qState.items)) return -1;
    return qState.items.findIndex(item => String(item.queueId) === String(qState.currentId));
  }

  function updateEditorQueueUI() {
    const song = state.songs.find(item => String(item.id) === String(state.editingId));
    if (!song || !els.queueStatus) return;
    const queue = window.PianoPlayerQueue;
    const pos = queue?.getSongPosition ? queue.getSongPosition(song.id) : -1;
    const qState = queue?.getState ? queue.getState() : null;
    const currIdx = currentQueueIndex(qState);
    const isCurrent = pos >= 0 && currIdx >= 0 && String(qState.items[currIdx]?.songId) === String(song.id);
    if (isCurrent) els.queueStatus.textContent = "NOW PLAYING";
    else if (pos >= 0) els.queueStatus.textContent = `Queued position #${pos + 1}`;
    else els.queueStatus.textContent = "Not queued";
    if (els.qToggle) els.qToggle.textContent = pos >= 0 ? "− Queue" : "+ Queue";
    if (els.qUp) els.qUp.disabled = pos <= 0;
    if (els.qDown) els.qDown.disabled = pos < 0 || (qState && pos >= qState.items.length - 1);
  }

  function openEditor(song) {
    state.editingId = song.id; const ids = song.identifiers || {}, custom = ids.custom || {};
    els.editorTitle.textContent = labelFor(song); els.authorEdit.value = ids.author || song.artist || ""; els.genreEdit.value = listValue(ids.genre).join(", "); els.tagsEdit.value = listValue(ids.tags).join(", "); els.ratingEdit.value = ids.personal_rating == null ? "" : String(ids.personal_rating);
    els.customEdit.value = Object.entries(custom).filter(([k]) => !k.startsWith("override_") && k !== "favorite").map(([key, value]) => `${key}=${value}`).join("\n");
    els.ovSpeed.value = custom.override_speed || "";
    els.ovInterval.value = custom.override_interval || "";
    els.ovHold.value = custom.override_hold || "";
    els.ovGate.value = custom.override_gate || "";
    els.saveMeta.disabled = false; renderAuto(song); updateEditorQueueUI();
  }

  async function toggleFavorite(songId) {
    const key = String(songId);
    if (favoritePending.has(key)) return;
    const index = state.songs.findIndex(item => String(item.id) === key);
    if (index < 0) return;

    const previous = state.songs[index];
    const desired = !isFavorite(previous);
    const identifiers = {
      ...(previous.identifiers || {}),
      genre: listValue(previous.identifiers?.genre),
      tags: listValue(previous.identifiers?.tags),
      author: clean(previous.identifiers?.author || previous.artist),
      personal_rating: previous.identifiers?.personal_rating ?? null,
      custom: { ...(previous.identifiers?.custom || {}), favorite: desired ? "true" : "false" }
    };
    const optimistic = { ...previous, identifiers };

    favoritePending.add(key);
    state.songs[index] = optimistic;
    renderResults();
    if (String(state.editingId) === key) openEditor(optimistic);

    try {
      const updated = await saveIdentifiers(previous.id, identifiers);
      if (!updated) throw new Error("Favorite update returned no song record.");
      state.songs = state.songs.map(item => String(item.id) === key ? updated : item);
      if (String(state.editingId) === key) openEditor(updated);
    } catch (err) {
      state.songs = state.songs.map(item => String(item.id) === key ? previous : item);
      if (String(state.editingId) === key) openEditor(previous);
      toast(err.message, "error");
    } finally {
      favoritePending.delete(key);
      renderResults();
    }
  }

  function renderResults() {
    const queue = window.PianoPlayerQueue;
    const qState = queue?.getState ? queue.getState() : null;
    const currIdx = currentQueueIndex(qState);
    const visible = filteredSongs(state.songs, state.prefs);
    els.count.textContent = `${visible.length} matches`; els.selection.textContent = `${state.selected.size} selected`; els.list.replaceChildren();
    if (!visible.length) { const empty = document.createElement("div"); empty.className = "planner-empty"; empty.textContent = "No songs match the current plan."; els.list.append(empty); return; }
    visible.forEach(song => {
      const row = document.createElement("article"); row.className = "planner-song";
      const custom = song.identifiers?.custom || {};
      const pos = queue?.getSongPosition ? queue.getSongPosition(song.id) : -1;
      const inQueue = pos >= 0;
      const isCurrent = inQueue && currIdx >= 0 && String(qState.items[currIdx]?.songId) === String(song.id);
      const isNext = inQueue && currIdx >= 0 && String(qState.items[currIdx + 1]?.songId) === String(song.id);

      const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.checked = state.selected.has(song.id); checkbox.addEventListener("change", () => { checkbox.checked ? state.selected.add(song.id) : state.selected.delete(song.id); renderResults(); });
      const favorite = isFavorite(song);
      const favoriteBusy = favoritePending.has(String(song.id));
      const favBtn = document.createElement("button");
      favBtn.type = "button";
      favBtn.className = `planner-fav-btn ${favorite ? "active" : ""}`;
      favBtn.textContent = favorite ? "★" : "☆";
      favBtn.title = favorite ? "Unfavorite" : "Favorite";
      favBtn.setAttribute("aria-pressed", favorite ? "true" : "false");
      favBtn.setAttribute("aria-label", `${favorite ? "Remove favorite from" : "Favorite"} ${labelFor(song)}`);
      favBtn.disabled = favoriteBusy;
      if (favoriteBusy) favBtn.setAttribute("aria-busy", "true");
      favBtn.addEventListener("click", event => { event.preventDefault(); event.stopPropagation(); void toggleFavorite(song.id); });
      const copy = document.createElement("div"); copy.className = "planner-song-copy";
      const title = document.createElement("strong"); title.textContent = labelFor(song);
      const sub = document.createElement("small"); sub.textContent = `${song.identifiers?.genre?.join(", ") || "No genre"} · ${song.automatic_identifiers?.event_count || 0} events · ${durationText(song.automatic_identifiers?.duration_ms || song.duration_ms)}`;
      const chips = document.createElement("div"); chips.className = "planner-song-chips";
      [song.identifiers?.personal_rating == null ? "Unrated" : `★ ${ratingText(song.identifiers.personal_rating)}`, song.automatic_identifiers?.conversion_rating == null ? "Conversion —" : `Conv ${ratingText(song.automatic_identifiers.conversion_rating)}`, ...listValue(song.identifiers?.tags).slice(0, 3)].forEach(value => { const chip = document.createElement("span"); chip.textContent = value; chips.append(chip); });
      if (isCurrent) { const qChip = document.createElement("span"); qChip.className = "planner-qtag now"; qChip.textContent = "NOW PLAYING"; chips.append(qChip); }
      else if (isNext) { const qChip = document.createElement("span"); qChip.className = "planner-qtag next"; qChip.textContent = "NEXT"; chips.append(qChip); }
      else if (inQueue) { const qChip = document.createElement("span"); qChip.className = "planner-qtag queued"; qChip.textContent = `#${pos + 1} QUEUED`; chips.append(qChip); }
      if (custom.override_speed || custom.override_interval) { const ovChip = document.createElement("span"); ovChip.className = "planner-qtag override"; ovChip.textContent = `⚡ ${custom.override_speed ? `${custom.override_speed}×` : "Custom"}`; chips.append(ovChip); }
      copy.append(title, sub, chips);

      const actions = document.createElement("div"); actions.className = "planner-song-actions";
      const playBtn = document.createElement("button"); playBtn.type = "button"; playBtn.textContent = "Play"; playBtn.addEventListener("click", () => void withQueue(live => live.hasSong(song.id) ? live.playSongNow(song.id) : sendToQueue([song], { replace: true, play: true })));
      const qBtn = document.createElement("button"); qBtn.type = "button"; qBtn.className = inQueue ? "ghost" : ""; qBtn.textContent = inQueue ? "− Queue" : "+ Queue"; qBtn.addEventListener("click", () => void withQueue(live => { if (live.hasSong(song.id)) live.removeSong(song.id); else live.addSongs([song], { announce: false }); }));
      const edit = document.createElement("button"); edit.type = "button"; edit.textContent = "Edit"; edit.addEventListener("click", () => openEditor(song));
      actions.append(playBtn, qBtn, edit);
      row.append(checkbox, favBtn, copy, actions); els.list.append(row);
    });
  }

  async function refresh() { try { state.songs = await fetchSongs(); renderFilterOptions(); renderResults(); } catch (error) { toast(error.message, "error"); } }

  function selectedSongs() {
    const byId = new Map(state.songs.map(song => [String(song.id), song]));
    return filteredSongs(state.songs, state.prefs).filter(song => state.selected.has(song.id)).map(song => byId.get(String(song.id))).filter(Boolean);
  }

  async function sendToQueue(songs, { replace = false, play = false, shuffle = false } = {}) {
    if (busy) return;
    if (!songs.length) return toast("Select at least one song first.", "error");
    busy = true;
    try {
      const queue = await waitForQueueApi();
      if (!queue) throw new Error("Player Queue controller is unavailable. Reload the Piano workspace and try again.");
      const added = await queue.addSongs(songs, { replace, play, shuffle, announce: false });
      if (!added) throw new Error("No selected songs could be added to Player Queue.");
      toast(`${added} song${added === 1 ? "" : "s"} sent to Player Queue`, "complete");
    } catch (error) { toast(error.message, "error"); }
    finally { busy = false; }
  }

  async function saveEditor() {
    const song = state.songs.find(item => String(item.id) === String(state.editingId)); if (!song) return;
    const custom = {};
    els.customEdit.value.split(/\r?\n/).forEach(line => { const index = line.indexOf("="); if (index > 0) custom[clean(line.slice(0, index))] = clean(line.slice(index + 1)); });
    if (clean(els.ovSpeed.value)) custom.override_speed = clean(els.ovSpeed.value); else delete custom.override_speed;
    if (clean(els.ovInterval.value)) custom.override_interval = clean(els.ovInterval.value); else delete custom.override_interval;
    if (clean(els.ovHold.value)) custom.override_hold = clean(els.ovHold.value); else delete custom.override_hold;
    if (clean(els.ovGate.value)) custom.override_gate = clean(els.ovGate.value); else delete custom.override_gate;
    if (song.identifiers?.custom?.favorite === "true" || song.identifiers?.custom?.favorite === "false") custom.favorite = song.identifiers.custom.favorite;
    try {
      const identifiers = { genre: listValue(els.genreEdit.value), tags: listValue(els.tagsEdit.value), author: clean(els.authorEdit.value), personal_rating: els.ratingEdit.value ? Number(els.ratingEdit.value) : null, custom };
      const updated = await saveIdentifiers(song.id, identifiers);
      if (!updated) throw new Error("Metadata update returned no song record.");
      state.songs = state.songs.map(item => String(item.id) === String(updated.id) ? updated : item); renderFilterOptions(); renderResults(); openEditor(updated); toast("Identifiers saved to the Local Library", "complete");
    } catch (error) { toast(error.message, "error"); }
  }

  function bind() {
    syncPrefsToControls();
    section.querySelectorAll("[data-pill]").forEach(btn => btn.addEventListener("click", () => {
      state.prefs.pill = btn.dataset.pill || "all";
      section.querySelectorAll("[data-pill]").forEach(b => b.classList.toggle("active", b === btn));
      persistPrefs(state.prefs); renderResults();
    }));
    const controls = [els.search, els.genre, els.author, els.host, els.kind, els.tags, els.minRating, els.minConversion, els.minDuration, els.maxDuration, els.minEvents, els.maxEvents, els.sort];
    controls.forEach(control => control.addEventListener("input", () => { savePrefs(); renderResults(); }));
    section.querySelector("[data-p-select-all]").addEventListener("click", () => { filteredSongs(state.songs, state.prefs).forEach(song => state.selected.add(song.id)); renderResults(); });
    section.querySelector("[data-p-clear-selection]").addEventListener("click", () => { state.selected.clear(); renderResults(); });
    section.querySelector("[data-p-add]").addEventListener("click", () => void sendToQueue(selectedSongs()));
    section.querySelector("[data-p-replace]").addEventListener("click", () => void sendToQueue(selectedSongs(), { replace: true }));
    section.querySelector("[data-p-play]").addEventListener("click", () => void sendToQueue(selectedSongs(), { replace: true, play: true }));
    section.querySelector("[data-p-shuffle]").addEventListener("click", () => void sendToQueue(selectedSongs(), { replace: true, shuffle: true }));
    els.saveMeta.addEventListener("click", () => void saveEditor());
    els.qPlay?.addEventListener("click", () => { const s = state.songs.find(item => String(item.id) === String(state.editingId)); if (s) void withQueue(queue => queue.hasSong(s.id) ? queue.playSongNow(s.id) : sendToQueue([s], { replace: true, play: true })); });
    els.qToggle?.addEventListener("click", () => { const s = state.songs.find(item => String(item.id) === String(state.editingId)); if (s) void withQueue(queue => { if (queue.hasSong(s.id)) queue.removeSong(s.id); else queue.addSongs([s], { announce: false }); updateEditorQueueUI(); renderResults(); }); });
    els.qUp?.addEventListener("click", () => { const s = state.songs.find(item => String(item.id) === String(state.editingId)); if (s) void withQueue(queue => { queue.moveSong(s.id, -1); updateEditorQueueUI(); renderResults(); }); });
    els.qDown?.addEventListener("click", () => { const s = state.songs.find(item => String(item.id) === String(state.editingId)); if (s) void withQueue(queue => { queue.moveSong(s.id, 1); updateEditorQueueUI(); renderResults(); }); });
    window.addEventListener("piano:queue-updated", () => { renderResults(); updateEditorQueueUI(); });
    window.addEventListener("piano:unified-refresh-requested", () => void refresh());
  }

  bind(); await refresh();
}

if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", () => { void installPlanner(); }, { once: true });
else void installPlanner();

export { installPlanner };