const CACHE_KEY = "piano_sheet_workspace_cache_v1";
const CACHE_TTL_MS = 12 * 60 * 60 * 1000;
const HISTORY_LIMIT = 10;

function id(prefix = "sheet") {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function hasContent(song) {
  return Boolean(String(song?.sheet || "").trim() || (Array.isArray(song?.performance) && song.performance.length));
}

function safeState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CACHE_KEY) || "null");
    if (!parsed || Number(parsed.expiresAt || 0) < Date.now()) return { history: [], cursor: -1, staging: [] };
    return {
      history: Array.isArray(parsed.history) ? parsed.history.slice(-HISTORY_LIMIT) : [],
      cursor: Number.isInteger(parsed.cursor) ? parsed.cursor : -1,
      staging: Array.isArray(parsed.staging) ? parsed.staging : []
    };
  } catch (_) {
    return { history: [], cursor: -1, staging: [] };
  }
}

function labelFor(song) {
  const title = String(song?.title || "").trim() || "Untitled sheet";
  const artist = String(song?.artist || "").trim();
  return artist && !title.includes(artist) ? `${title} — ${artist}` : title;
}

function sourceFor(song, meta = {}) {
  return String(meta.provider_name || song?.source || "Sheet Finder").trim() || "Sheet Finder";
}

function ensureStylesheet() {
  if (document.getElementById("pianoWorkspaceStyles")) return;
  const link = document.createElement("link");
  link.id = "pianoWorkspaceStyles";
  link.rel = "stylesheet";
  link.href = "/assets/piano_workspace.css";
  document.head.append(link);
}

function buildHost() {
  const player = document.querySelector(".player-panel");
  if (!player) return null;
  const host = document.createElement("section");
  host.className = "sheet-workspace";
  host.dataset.sheetWorkspace = "";
  host.innerHTML = `
    <div class="sheet-workspace-flow" aria-label="Auto Player workflow">
      <span>AUTO PLAYER WORKFLOW</span>
      <strong>Source Inbox <b>→</b> Player <b>→</b> Queue / Output</strong>
      <small>Sheet Finder, AI conversion, local library, history, and queue all feed the same playback state.</small>
    </div>
    <details class="sheet-workspace-cache">
      <summary>
        <div class="sheet-workspace-copy">
          <span>AUTO PLAYER HISTORY</span>
          <strong data-workspace-current>Nothing loaded yet</strong>
          <small>Temporary navigation for the last 10 items loaded into this Auto Player.</small>
        </div>
        <b class="sheet-workspace-cache-toggle" aria-hidden="true"></b>
      </summary>
      <div class="sheet-workspace-controls">
        <button type="button" data-workspace-back title="Previous loaded sheet">← Back</button>
        <select data-workspace-history aria-label="Recent Auto Player items"><option value="">No recent items</option></select>
        <span data-workspace-position>0 / 10</span>
        <button type="button" data-workspace-forward title="Next loaded sheet">Forward →</button>
      </div>
    </details>
    <details class="sheet-workspace-staging" open>
      <summary>
        <span><strong>SOURCE INBOX</strong><small>Sheet Finder and AI-converted results wait here before entering the same Auto Player timeline.</small></span>
        <b data-workspace-staging-count>0 waiting</b>
      </summary>
      <div class="sheet-workspace-inbox" data-workspace-staging></div>
    </details>`;
  player.querySelector(".panel-head")?.insertAdjacentElement("afterend", host);
  return host;
}

export function setupSheetWorkspace({ onLoad, getCurrent, toast }) {
  ensureStylesheet();
  const host = buildHost();
  if (!host) return { stage() {}, load() {}, countStaged: () => 0, rememberCurrent() {} };
  const back = host.querySelector("[data-workspace-back]");
  const forward = host.querySelector("[data-workspace-forward]");
  const historySelect = host.querySelector("[data-workspace-history]");
  const currentLabel = host.querySelector("[data-workspace-current]");
  const position = host.querySelector("[data-workspace-position]");
  const stagingCount = host.querySelector("[data-workspace-staging-count]");
  const stagingHost = host.querySelector("[data-workspace-staging]");
  const searchResults = document.getElementById("searchResults");
  let state = safeState();
  let warnedQuota = false;

  function relabelFinderActions() {
    searchResults?.querySelectorAll("button").forEach(button => {
      if (button.textContent.trim() === "Import") button.textContent = "Stage";
    });
  }
  if (searchResults) new MutationObserver(relabelFinderActions).observe(searchResults, { childList: true, subtree: true });

  function persist() {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ ...state, expiresAt: Date.now() + CACHE_TTL_MS }));
      warnedQuota = false;
    } catch (_) {
      if (!warnedQuota) toast?.("Auto Player history is full; current items remain available in this window.", "error");
      warnedQuota = true;
    }
  }

  function updateCurrentHistory() {
    if (state.cursor < 0 || state.cursor >= state.history.length) return;
    const song = getCurrent?.();
    if (!hasContent(song)) return;
    state.history[state.cursor] = { ...state.history[state.cursor], song, label: labelFor(song), touchedAt: Date.now() };
  }

  function renderHistory() {
    const count = state.history.length;
    state.cursor = count ? Math.max(0, Math.min(state.cursor, count - 1)) : -1;
    historySelect.replaceChildren();
    if (!count) {
      const option = document.createElement("option");
      option.value = ""; option.textContent = "No recent items"; historySelect.append(option);
    } else {
      state.history.forEach((entry, index) => {
        const option = document.createElement("option");
        option.value = String(index); option.textContent = entry.label || labelFor(entry.song);
        historySelect.append(option);
      });
      historySelect.value = String(state.cursor);
    }
    const current = state.cursor >= 0 ? state.history[state.cursor] : null;
    currentLabel.textContent = current?.label || "Nothing loaded yet";
    position.textContent = count ? `${state.cursor + 1} / ${count}` : "0 / 10";
    back.disabled = state.cursor <= 0;
    forward.disabled = state.cursor < 0 || state.cursor >= count - 1;
    historySelect.disabled = !count;
  }

  function stagedRow(entry) {
    const row = document.createElement("article");
    row.className = "sheet-workspace-item";
    row.dataset.workspaceStageId = entry.id;
    const copy = document.createElement("div"); copy.className = "sheet-workspace-item-copy";
    const title = document.createElement("strong"); title.textContent = entry.label;
    const kind = entry.song?.performance?.length ? `timed performance · ${entry.song.performance.length} events` : "sheet";
    const sub = document.createElement("span"); sub.textContent = `${entry.source} · ${kind}`;
    const actions = document.createElement("div"); actions.className = "sheet-workspace-item-actions";
    const load = document.createElement("button"); load.type = "button"; load.className = "primary"; load.textContent = "Load into Auto Player";
    load.addEventListener("click", () => loadEntry(entry));
    const discard = document.createElement("button"); discard.type = "button"; discard.className = "ghost"; discard.textContent = "Discard";
    discard.addEventListener("click", () => { state.staging = state.staging.filter(item => item.id !== entry.id); persist(); render(); });
    copy.append(title, sub); actions.append(load, discard); row.append(copy, actions); return row;
  }

  function renderStaging() {
    stagingCount.textContent = `${state.staging.length} waiting`;
    stagingHost.replaceChildren();
    if (!state.staging.length) {
      const empty = document.createElement("div");
      empty.className = "sheet-workspace-empty";
      empty.textContent = "Nothing waiting. Stage a Sheet Finder result or complete an AI conversion to feed the Auto Player.";
      stagingHost.append(empty);
      return;
    }
    state.staging.forEach(entry => stagingHost.append(stagedRow(entry)));
  }

  function render() { renderHistory(); renderStaging(); relabelFinderActions(); }

  function rememberCurrent() {
    const song = getCurrent?.();
    if (!hasContent(song)) return;
    if (state.cursor >= 0) state.history = state.history.slice(0, state.cursor + 1);
    const entry = { id: id("history"), song, label: labelFor(song), source: sourceFor(song), loadedAt: Date.now() };
    state.history.push(entry);
    if (state.history.length > HISTORY_LIMIT) state.history = state.history.slice(-HISTORY_LIMIT);
    state.cursor = state.history.length - 1;
    persist(); renderHistory();
  }

  async function loadEntry(entry, { removeStage = true, remember = true } = {}) {
    try {
      if (remember) updateCurrentHistory();
      await onLoad?.(entry.song, entry.meta || { provider_name: entry.source, url: entry.song?.source_url || "" });
      if (removeStage) state.staging = state.staging.filter(item => item.id !== entry.id);
      if (remember) rememberCurrent(); else { persist(); render(); }
      if (removeStage) { persist(); renderStaging(); }
    } catch (error) {
      toast?.(error?.message || "Could not load Auto Player history item.", "error");
    }
  }

  async function navigate(index) {
    const target = Math.max(0, Math.min(Number(index), state.history.length - 1));
    if (!state.history.length || target === state.cursor) return;
    updateCurrentHistory();
    state.cursor = target;
    persist(); renderHistory();
    await loadEntry(state.history[target], { removeStage: false, remember: false });
  }

  function stage(song, meta = {}) {
    if (!hasContent(song)) return null;
    const entry = { id: id("staged"), song, meta, label: labelFor(song), source: sourceFor(song, meta), stagedAt: Date.now() };
    state.staging.push(entry);
    persist(); renderStaging();
    host.querySelector(".sheet-workspace-staging").open = true;
    window.dispatchEvent(new CustomEvent("piano:workspace-staged", { detail: { id: entry.id, label: entry.label } }));
    toast?.(`${entry.label} added to Auto Player Source Inbox`, "complete");
    return entry.id;
  }

  async function load(song, meta = {}) {
    if (!hasContent(song)) return;
    const entry = { id: id("direct"), song, meta, label: labelFor(song), source: sourceFor(song, meta) };
    await loadEntry(entry, { removeStage: false, remember: true });
  }

  back.addEventListener("click", () => navigate(state.cursor - 1));
  forward.addEventListener("click", () => navigate(state.cursor + 1));
  historySelect.addEventListener("change", () => navigate(Number(historySelect.value)));
  window.addEventListener("storage", event => {
    if (event.key !== CACHE_KEY) return;
    state = safeState(); render();
  });

  render();
  return { stage, load, rememberCurrent, countStaged: () => state.staging.length, render };
}
