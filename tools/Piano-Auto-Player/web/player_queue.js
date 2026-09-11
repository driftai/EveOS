const STORAGE_KEY = "piano_player_queue_v1";
const MODES = new Set(["manual", "ordered", "shuffle"]);
const TRANSITIONS = new Set([250, 500, 750, 1000, 1500]);

const wait = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const labelFor = song => String(song?.artist || "").trim() && !String(song.title || "").includes(String(song.artist).trim())
  ? `${song.title || "Untitled"} — ${song.artist}`
  : String(song?.title || "Untitled sheet").trim();

function safeState() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    const mode = MODES.has(parsed?.mode) ? parsed.mode : "manual";
    const transitionMs = TRANSITIONS.has(Number(parsed?.transitionMs)) ? Number(parsed.transitionMs) : 750;
    const items = Array.isArray(parsed?.items) ? parsed.items.filter(item => item?.songId) : [];
    return { items, mode, transitionMs, active: false, currentId: null };
  } catch (_) {
    return { items: [], mode: "manual", transitionMs: 750, active: false, currentId: null };
  }
}

function persist(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ items: state.items, mode: state.mode, transitionMs: state.transitionMs }));
  } catch (_) {}
}

function shuffle(items) {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

async function fetchSongs() {
  const response = await fetch("/api/songs", { cache: "no-store" });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Library request failed (${response.status})`);
  return Array.isArray(body.songs) ? body.songs : [];
}

function loadStyles() {
  if (document.getElementById("pianoPlayerQueueStyles")) return;
  const link = document.createElement("link");
  link.id = "pianoPlayerQueueStyles";
  link.rel = "stylesheet";
  link.href = "/assets/player_queue.css";
  document.head.append(link);
}

function waitForWorkspace(timeout = 5000) {
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

function buildQueue(host) {
  const section = document.createElement("details");
  section.className = "sheet-workspace-queue";
  section.open = true;
  section.innerHTML = `
    <summary>
      <span>
        <strong>PLAYER QUEUE</strong>
        <small>Shortcut layer for planned playback from your Local Song + Recording Library.</small>
      </span>
      <b data-queue-count>0 queued</b>
    </summary>
    <div class="player-queue-body">
      <div class="player-queue-now">
        <div><span>NOW</span><strong data-queue-current>Nothing playing from queue</strong></div>
        <div><span>NEXT</span><strong data-queue-next>Nothing next</strong></div>
      </div>
      <div class="player-queue-toolbar">
        <label><span>Playback mode</span><select data-queue-mode aria-label="Player queue playback mode">
          <option value="manual">Manual — stop after each song</option>
          <option value="ordered">Ordered — advance in queue order</option>
          <option value="shuffle">Shuffle — choose a random next song</option>
        </select></label>
        <label><span>Transition pause</span><select data-queue-transition aria-label="Queue transition pause">
          <option value="250">0.25 s</option><option value="500">0.50 s</option><option value="750">0.75 s</option><option value="1000">1.00 s</option><option value="1500">1.50 s</option>
        </select></label>
        <div class="player-queue-actions">
          <button type="button" class="primary" data-queue-play>Play queue</button>
          <button type="button" data-queue-play-all>Play all library</button>
          <button type="button" data-queue-shuffle>Shuffle</button>
          <button type="button" class="ghost" data-queue-clear>Clear</button>
        </div>
      </div>
      <div class="player-queue-list" data-queue-list></div>
    </div>`;
  const staging = host.querySelector(".sheet-workspace-staging");
  host.insertBefore(section, staging || null);
  return section;
}

function installPlayerQueue() {
  loadStyles();
  return waitForWorkspace().then(host => {
    if (!host) return null;
    const existing = host.querySelector(".sheet-workspace-queue");
    if (existing?.pianoQueueController) return existing.pianoQueueController;
    if (existing) return null;
    const section = buildQueue(host);
    const list = section.querySelector("[data-queue-list]");
    const count = section.querySelector("[data-queue-count]");
    const current = section.querySelector("[data-queue-current]");
    const next = section.querySelector("[data-queue-next]");
    const mode = section.querySelector("[data-queue-mode]");
    const transition = section.querySelector("[data-queue-transition]");
    const play = section.querySelector("[data-queue-play]");
    const playAll = section.querySelector("[data-queue-play-all]");
    const shuffleButton = section.querySelector("[data-queue-shuffle]");
    const clear = section.querySelector("[data-queue-clear]");
    const library = document.getElementById("libraryList");
    const titleInput = document.getElementById("titleInput");
    const playButton = document.getElementById("playBtn");
    const stopButton = document.getElementById("stopBtn");
    let state = safeState();
    let suppressCancel = false;
    let syncTimer = null;
    let busy = false;
    let lastStatus = "";

    function toast(message, status = "idle") {
      const text = document.getElementById("statusText");
      const chip = document.getElementById("statusChip");
      if (text) text.textContent = message;
      if (chip) chip.dataset.state = status;
    }

    function render() {
      mode.value = state.mode;
      transition.value = String(state.transitionMs);
      count.textContent = `${state.items.length} queued`;
      current.textContent = state.active && state.currentId ? state.items.find(item => item.queueId === state.currentId)?.label || "Playing…" : "Nothing playing from queue";
      next.textContent = state.items.length > 1 ? state.items[1].label : "Nothing next";
      list.replaceChildren();
      if (!state.items.length) {
        const empty = document.createElement("div");
        empty.className = "player-queue-empty";
        empty.textContent = "Add songs from the Local Library with Queue, or use Play all library.";
        list.append(empty);
        return;
      }
      state.items.forEach((item, index) => {
        const row = document.createElement("article");
        row.className = "player-queue-item";
        if (item.queueId === state.currentId) row.dataset.current = "true";
        const meta = document.createElement("div");
        meta.className = "player-queue-item-copy";
        const pos = document.createElement("span");
        pos.textContent = index === 0 && state.active ? "NOW" : `#${index + 1}`;
        const title = document.createElement("strong");
        title.textContent = item.label;
        const sub = document.createElement("small");
        sub.textContent = item.kind || "Library song";
        meta.append(pos, title, sub);
        const actions = document.createElement("div");
        actions.className = "player-queue-item-actions";
        const now = document.createElement("button");
        now.type = "button"; now.textContent = "Play now";
        now.addEventListener("click", () => void playNow(item.queueId));
        const up = document.createElement("button");
        up.type = "button"; up.textContent = "↑"; up.disabled = index === 0;
        up.addEventListener("click", () => move(index, -1));
        const down = document.createElement("button");
        down.type = "button"; down.textContent = "↓"; down.disabled = index === state.items.length - 1;
        down.addEventListener("click", () => move(index, 1));
        const remove = document.createElement("button");
        remove.type = "button"; remove.className = "danger"; remove.textContent = "×";
        remove.addEventListener("click", () => removeItem(item.queueId));
        actions.append(now, up, down, remove);
        row.append(meta, actions); list.append(row);
      });
    }

    function makeItem(song) {
      return { queueId: `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`, songId: String(song.id), label: labelFor(song), kind: song.performance?.length ? `Recording · ${song.performance.length} events` : String(song.source || "Sheet") };
    }

    function addSong(song, announce = true) {
      if (!song?.id) return false;
      state.items.push(makeItem(song));
      persist(state); render();
      if (announce) toast(`${labelFor(song)} added to Player Queue`, "complete");
      return true;
    }

    async function addSongs(songs, { replace = false, play = false, shuffle: shouldShuffle = false } = {}) {
      const valid = (Array.isArray(songs) ? songs : []).filter(song => song?.id);
      if (!valid.length) return 0;
      if (replace) { state.items = []; state.active = false; state.currentId = null; }
      valid.forEach(song => state.items.push(makeItem(song)));
      if (shouldShuffle) state.items = shuffle(state.items);
      persist(state); render();
      if ((play || shouldShuffle) && state.items.length) await playQueue();
      return valid.length;
    }

    function removeItem(queueId) {
      const index = state.items.findIndex(item => item.queueId === queueId);
      if (index < 0) return;
      if (state.currentId === queueId) state.currentId = null;
      state.items.splice(index, 1);
      if (!state.items.length) state.active = false;
      persist(state); render();
    }

    function move(index, delta) {
      const target = index + delta;
      if (target < 0 || target >= state.items.length) return;
      [state.items[index], state.items[target]] = [state.items[target], state.items[index]];
      persist(state); render();
    }

    function shuffleRemaining() {
      if (state.items.length < 2) return;
      const head = state.active ? state.items[0] : null;
      const rest = state.active ? state.items.slice(1) : state.items;
      const shuffled = shuffle(rest);
      state.items = head ? [head, ...shuffled] : shuffled;
      persist(state); render();
    }

    function clearQueue() {
      state.items = []; state.active = false; state.currentId = null; persist(state); render();
    }

    function cancel(reason = "") {
      state.active = false;
      state.currentId = null;
      persist(state); render();
      if (reason) toast(reason, "idle");
    }

    async function librarySongs() {
      const songs = await fetchSongs();
      syncLibraryCards(songs);
      return songs;
    }

    function syncLibraryCards(songs = []) {
      if (!library) return;
      const cards = [...library.children].filter(node => node.querySelector?.(".result-title"));
      cards.forEach((card, index) => {
        const song = songs[index];
        if (!song?.id) return;
        card.dataset.pianoSongId = String(song.id);
        const actions = card.querySelector(".result-actions");
        if (!actions || actions.querySelector("[data-add-player-queue]")) return;
        const button = document.createElement("button");
        button.type = "button"; button.className = "ghost small"; button.textContent = "Queue"; button.dataset.addPlayerQueue = "";
        button.addEventListener("click", () => addSong(song));
        actions.append(button);
      });
    }

    async function syncLibraryDecoration() {
      try { syncLibraryCards(await fetchSongs()); } catch (_) {}
    }

    function findLibraryLoadButton(songId) {
      const card = [...(library?.children || [])].find(node => node.dataset?.pianoSongId === String(songId));
      if (!card) return null;
      return [...card.querySelectorAll("button")].find(button => button.textContent.trim() === "Load") || null;
    }

    async function playLibrarySong(songId) {
      const songs = await fetchSongs();
      const song = songs.find(item => String(item.id) === String(songId));
      if (!song) throw new Error("That queued library song no longer exists.");
      syncLibraryCards(songs);
      const loadButton = findLibraryLoadButton(song.id);
      if (!loadButton) throw new Error("Could not locate the library Load shortcut. Refresh the library and try again.");
      suppressCancel = true;
      try { loadButton.click(); } finally { suppressCancel = false; }
      await wait(80);
      const expected = labelFor(song);
      const deadline = Date.now() + 2000;
      let loaded = false;
      while (Date.now() < deadline) {
        loaded = normalize(titleInput?.value) === normalize(expected) || normalize(titleInput?.value).startsWith(normalize(song.title));
        if (loaded) break;
        await wait(60);
      }
      if (!loaded) throw new Error(`Queued song did not finish loading: ${song.title || "Untitled"}`);
      if (!playButton) throw new Error("Player Play control is unavailable.");
      suppressCancel = true;
      try { playButton.click(); } finally { suppressCancel = false; }
    }

    function moveToFront(queueId) {
      const index = state.items.findIndex(item => item.queueId === queueId);
      if (index < 0) return null;
      const [item] = state.items.splice(index, 1);
      state.items.unshift(item);
      return item;
    }

    async function playNow(queueId) {
      if (busy) return;
      const item = moveToFront(queueId);
      if (!item) return;
      state.active = true;
      state.currentId = item.queueId;
      persist(state); render();
      busy = true;
      try {
        await playLibrarySong(item.songId);
      } catch (error) {
        cancel(); toast(error.message, "error");
      } finally { busy = false; }
    }

    async function playQueue() {
      if (busy || !state.items.length) {
        if (!state.items.length) toast("Player Queue is empty", "error");
        return;
      }
      state.active = true; state.currentId = state.items[0].queueId; persist(state); render();
      busy = true;
      try { await playLibrarySong(state.items[0].songId); }
      catch (error) { cancel(); toast(error.message, "error"); }
      finally { busy = false; }
    }

    async function playAllLibrary() {
      if (busy) return;
      try {
        const songs = await librarySongs();
        if (!songs.length) return toast("Local Library has no saved songs to play.", "error");
        state.items = songs.map(makeItem);
        state.mode = "ordered";
        state.active = false;
        state.currentId = null;
        persist(state); render();
        await playQueue();
      } catch (error) { toast(error.message, "error"); }
    }

    async function advanceAfterComplete() {
      if (!state.active || !state.currentId || busy) return false;
      const currentItem = state.items.find(item => item.queueId === state.currentId) || state.items[0];
      const currentTitle = normalize(titleInput?.value);
      if (currentItem && currentTitle && !currentTitle.startsWith(normalize(currentItem.label.split(" — ")[0]))) {
        cancel();
        return false;
      }
      state.items = state.items.filter(item => item.queueId !== currentItem?.queueId);
      state.currentId = null;
      if (!state.items.length) {
        cancel("Player Queue finished.");
        return true;
      }
      if (state.mode === "manual") {
        persist(state); render();
        toast("Song finished — Player Queue is waiting for your next choice.", "complete");
        return false;
      }
      if (state.mode === "shuffle") {
        const nextIndex = Math.floor(Math.random() * state.items.length);
        const [nextItem] = state.items.splice(nextIndex, 1);
        state.items.unshift(nextItem);
      }
      state.currentId = state.items[0].queueId;
      persist(state); render();
      await wait(state.transitionMs);
      return playNow(state.currentId).then(() => true).catch(error => { cancel(); toast(error.message, "error"); return false; });
    }

    function bind() {
      mode.addEventListener("change", () => { state.mode = MODES.has(mode.value) ? mode.value : "manual"; persist(state); render(); });
      transition.addEventListener("change", () => { state.transitionMs = Number(transition.value) || 750; persist(state); render(); });
      play.addEventListener("click", () => void playQueue());
      playAll.addEventListener("click", () => void playAllLibrary());
      shuffleButton.addEventListener("click", () => { shuffleRemaining(); if (!state.active && state.items.length) void playQueue(); });
      clear.addEventListener("click", clearQueue);
      stopButton?.addEventListener("click", () => { if (!suppressCancel) cancel("Player Queue stopped."); });
      playButton?.addEventListener("click", () => { if (!suppressCancel && state.active && state.mode !== "manual") cancel("Player Queue released to manual playback."); });
    }

    const observer = new MutationObserver(() => {
      clearTimeout(syncTimer);
      syncTimer = setTimeout(syncLibraryDecoration, 40);
    });
    if (library) observer.observe(library, { childList: true, subtree: true });

    const statusChip = document.getElementById("statusChip");
    if (statusChip) {
      const statusObserver = new MutationObserver(() => {
        const stateValue = statusChip.dataset.state || "";
        if (stateValue === "complete" && lastStatus !== "complete") {
          lastStatus = "complete";
          void advanceAfterComplete();
        } else if (stateValue !== "complete") lastStatus = stateValue;
      });
      statusObserver.observe(statusChip, { attributes: true, attributeFilter: ["data-state"] });
    }

    bind(); render(); syncLibraryDecoration();
    const controller = Object.freeze({ addSong, addSongs, playQueue, playAllLibrary, clearQueue, cancel, advanceAfterComplete, render });
    section.pianoQueueController = controller;
    return controller;
  });
}

let controllerPromise = null;
function playerQueueReady() {
  if (!controllerPromise) controllerPromise = installPlayerQueue();
  return controllerPromise;
}

if (document.readyState === "loading") {
  window.addEventListener("DOMContentLoaded", () => { void playerQueueReady(); }, { once: true });
} else {
  void playerQueueReady();
}
export { installPlayerQueue, playerQueueReady };
