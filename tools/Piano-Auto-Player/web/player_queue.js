import { api } from "./api.js";
import {
  MODES, TRANSITIONS, restoreQueueState, queueSnapshot, currentIndex, nextIndex, normalizeQueueState,
  activateQueueId, activateNext, activateRandomNext, stepQueue, completeCurrent, removeQueueIds, removeSongIds, removeLatestSongIds,
  moveQueueId, moveQueueIdTo, shuffleRemaining as shuffleQueueRemainder, shuffleSelected, entryStatus, entriesForSong
} from "./player_queue_state.js";

const STORAGE_KEY = "piano_player_queue_v1";
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
const normalize = value => String(value || "").trim().toLowerCase().replace(/\s+/g, " ");
const labelFor = song => String(song?.artist || "").trim() && !String(song.title || "").includes(String(song.artist).trim())
  ? `${song.title || "Untitled"} — ${song.artist}` : String(song?.title || "Untitled sheet").trim();
const fetchSongs = () => api.songs().then(body => Array.isArray(body.songs) ? body.songs : []);

function safeState() {
  try { return restoreQueueState(JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}")); }
  catch (_) { return restoreQueueState(); }
}

function persist(state) {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(queueSnapshot(state))); } catch (_) {}
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
    <summary><span><strong>PLAYER QUEUE</strong><small>Persistent playback timeline with history, current song, and upcoming order.</small></span><b data-queue-count>0 items</b></summary>
    <div class="player-queue-body">
      <div class="player-queue-now"><div><span>NOW</span><strong data-queue-current>Nothing playing from queue</strong></div><div><span>NEXT</span><strong data-queue-next>Nothing next</strong></div></div>
      <div class="player-queue-toolbar">
        <label><span>Playback mode</span><select data-queue-mode aria-label="Player queue playback mode">
          <option value="manual">Manual — stop after each song</option><option value="ordered">Ordered — advance in queue order</option><option value="shuffle">Shuffle — choose a random next song</option>
        </select></label>
        <label><span>Transition pause</span><select data-queue-transition aria-label="Queue transition pause">
          <option value="250">0.25 s</option><option value="500">0.50 s</option><option value="750">0.75 s</option><option value="1000">1.00 s</option><option value="1500">1.50 s</option>
        </select></label>
        <div class="player-queue-actions"><button type="button" class="primary" data-queue-play>Play queue</button><button type="button" data-queue-play-all>Play all library</button><button type="button" data-queue-shuffle>Shuffle future</button><button type="button" class="ghost" data-queue-clear>Clear queue</button></div>
      </div>
      <div class="player-queue-list" data-queue-list></div>
    </div>`;
  host.insertBefore(section, host.querySelector(".sheet-workspace-staging") || null);
  return section;
}

function installPlayerQueue() {
  loadStyles();
  return waitForWorkspace().then(host => {
    if (!host || host.querySelector(".sheet-workspace-queue")) return window.PianoPlayerQueue || null;
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
    const pauseButton = document.getElementById("pauseBtn");
    const stopButton = document.getElementById("stopBtn");
    let state = safeState();
    let suppressCancel = false;
    let syncTimer = null;
    let busy = false;
    let lastStatus = "";

    function toast(message, status = "idle") {
      const text = document.getElementById("statusText"), chip = document.getElementById("statusChip");
      if (text) text.textContent = message;
      if (chip) chip.dataset.state = status;
    }

    function emitUpdate() {
      window.dispatchEvent(new CustomEvent("piano:queue-updated", { detail: queueSnapshot(state) }));
    }

    function render() {
      normalizeQueueState(state);
      const currentAt = currentIndex(state), nextAt = nextIndex(state);
      mode.value = state.mode;
      transition.value = String(state.transitionMs);
      count.textContent = `${state.items.length} timeline item${state.items.length === 1 ? "" : "s"}`;
      current.textContent = currentAt >= 0 ? state.items[currentAt].label : "Nothing playing from queue";
      next.textContent = state.mode === "shuffle" && nextAt < state.items.length ? "Random unplayed song" : nextAt < state.items.length ? state.items[nextAt].label : "Nothing next";
      play.textContent = state.active ? "Stop queue" : "Play queue";
      play.dataset.action = state.active ? "stop" : "play";
      list.replaceChildren();
      if (!state.items.length) {
        const empty = document.createElement("div"); empty.className = "player-queue-empty"; empty.textContent = "Send songs from My Songs to build a playback timeline."; list.append(empty);
      } else state.items.forEach((item, index) => {
        const status = entryStatus(state, index);
        const row = document.createElement("article"); row.className = "player-queue-item"; row.dataset.status = status;
        const meta = document.createElement("div"); meta.className = "player-queue-item-copy";
        const pos = document.createElement("span");
        pos.textContent = status === "current" ? `NOW · #${index + 1}` : status === "played" ? `PLAYED · #${index + 1}` : status === "next" ? `NEXT · #${index + 1}` : `#${index + 1}`;
        const title = document.createElement("strong"); title.textContent = item.label;
        const sub = document.createElement("small"); sub.textContent = item.kind || "Library song";
        meta.append(pos, title, sub);
        const actions = document.createElement("div"); actions.className = "player-queue-item-actions";
        const now = document.createElement("button"); now.type = "button"; now.textContent = status === "current" ? "Resume" : "Play"; now.addEventListener("click", () => void playNow(item.queueId));
        const up = document.createElement("button"); up.type = "button"; up.textContent = "↑"; up.disabled = index <= nextAt; up.addEventListener("click", () => move(item.queueId, -1));
        const down = document.createElement("button"); down.type = "button"; down.textContent = "↓"; down.disabled = index < nextAt || index === state.items.length - 1; down.addEventListener("click", () => move(item.queueId, 1));
        const remove = document.createElement("button"); remove.type = "button"; remove.className = "danger"; remove.textContent = "×"; remove.addEventListener("click", () => removeItem(item.queueId));
        actions.append(now, up, down, remove); row.append(meta, actions); list.append(row);
      });
      persist(state);
      emitUpdate();
    }

    function makeItem(song) {
      return { queueId: `queue-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`, songId: String(song.id), label: labelFor(song), kind: song.performance?.length ? `Recording · ${song.performance.length} events` : String(song.source || "Sheet") };
    }

    function addSong(song, announce = true) {
      if (!song?.id) return false;
      state.items.push(makeItem(song)); render();
      if (announce) toast(`${labelFor(song)} added to Player Queue`, "complete");
      return true;
    }

    async function addSongs(songs, { replace = false, play: start = false, shuffle = false, announce = true } = {}) {
      const valid = Array.isArray(songs) ? songs.filter(song => song?.id) : [];
      if (!valid.length) return 0;
      if (replace) state = restoreQueueState({ mode: state.mode, transitionMs: state.transitionMs });
      valid.forEach(song => state.items.push(makeItem(song)));
      if (shuffle) shuffleQueueRemainder(state);
      render();
      if (announce) toast(`${valid.length} song${valid.length === 1 ? "" : "s"} sent to Player Queue`, "complete");
      if (start) await playQueue();
      return valid.length;
    }

    function clearQueue() { state = restoreQueueState({ mode: state.mode, transitionMs: state.transitionMs }); render(); toast("Player Queue cleared.", "idle"); }
    function removeItem(queueId) { removeQueueIds(state, [queueId]); render(); }
    function removeSongs(songIds) { const removed = removeLatestSongIds(state, songIds); render(); return removed; }
    function removeAllSongs(songIds) { const removed = removeSongIds(state, songIds); render(); return removed; }
    function move(queueId, delta) { if (moveQueueId(state, queueId, delta)) render(); }
    function reorder(queueId, targetQueueId, after = false) { if (state.mode !== "manual") return false; const changed = moveQueueIdTo(state, queueId, targetQueueId, after); if (changed) render(); return changed; }
    function duplicateAfter(queueId) {
      if (state.mode !== "manual") return false;
      const index = state.items.findIndex(item => item.queueId === queueId); if (index < 0) return false;
      state.items.splice(index + 1, 0, { ...state.items[index], queueId: makeItem({ id: state.items[index].songId }).queueId }); render(); return true;
    }
    function shuffleRemaining() { const changed = shuffleQueueRemainder(state); if (changed) render(); return changed; }
    function shuffleSelectedSongs(songIds) { const changed = shuffleSelected(state, songIds); if (changed) render(); return changed; }

    function releaseQueue(reason = "") { state.active = false; render(); if (reason) toast(reason, "idle"); }
    async function librarySongs() { const songs = await fetchSongs(); syncLibraryCards(songs); return songs; }

    function syncLibraryCards(songs = []) {
      if (!library) return;
      const cards = [...library.children].filter(node => node.querySelector?.(".result-title"));
      cards.forEach((card, index) => {
        const song = songs[index]; if (!song?.id) return;
        card.dataset.pianoSongId = String(song.id);
        const actions = card.querySelector(".result-actions"); if (!actions || actions.querySelector("[data-add-player-queue]")) return;
        const button = document.createElement("button"); button.type = "button"; button.className = "ghost small"; button.textContent = "Queue"; button.dataset.addPlayerQueue = ""; button.addEventListener("click", () => addSong(song)); actions.append(button);
      });
    }

    async function syncLibraryDecoration() { try { syncLibraryCards(await fetchSongs()); } catch (_) {} }

    function findLibraryLoadButton(songId) {
      const card = [...(library?.children || [])].find(node => node.dataset?.pianoSongId === String(songId));
      return card ? [...card.querySelectorAll("button")].find(button => button.textContent.trim() === "Load") || null : null;
    }

    async function waitForLibraryLoadButton(songId, timeout = 5000) {
      let button = findLibraryLoadButton(songId);
      if (button) return button;
      document.getElementById("refreshLibraryBtn")?.click();
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        await wait(60);
        button = findLibraryLoadButton(songId);
        if (button) return button;
      }
      return null;
    }

    function titleMatches(item) {
      const currentTitle = normalize(titleInput?.value);
      return currentTitle && currentTitle.startsWith(normalize(item.label.split(" — ")[0]));
    }

    async function playLibrarySong(item, { resume = false } = {}) {
      const songs = await fetchSongs();
      const song = songs.find(entry => String(entry.id) === String(item.songId));
      if (!song) throw new Error("That queued library song no longer exists.");
      const owner = window.PianoPlaybackOwner;
      if (typeof owner?.playSong === "function") {
        suppressCancel = true;
        try { await owner.playSong(song, { resume }); } finally { suppressCancel = false; }
        return;
      }
      if (resume && titleMatches(item) && /resume/i.test(pauseButton?.textContent || "")) {
        suppressCancel = true;
        try { pauseButton.click(); } finally { suppressCancel = false; }
        return;
      }
      syncLibraryCards(songs);
      const loadButton = await waitForLibraryLoadButton(song.id);
      if (!loadButton || !playButton) throw new Error("Player controls remain unavailable after a fresh library repair. Reload Piano and try again.");
      window.dispatchEvent(new CustomEvent("piano:preserve-playback-scroll", { detail: { top: window.scrollY } }));
      suppressCancel = true;
      try {
        loadButton.click(); await wait(80);
        const expected = labelFor(song), deadline = Date.now() + 2000;
        let loaded = false;
        while (Date.now() < deadline) {
          loaded = normalize(titleInput?.value) === normalize(expected) || normalize(titleInput?.value).startsWith(normalize(song.title));
          if (loaded) break;
          await wait(60);
        }
        if (!loaded) throw new Error(`Library song did not finish loading before playback: ${song.title || "Untitled"}`);
        playButton.click();
      } finally { suppressCancel = false; }
    }

    async function playActivated(item, { resume = false } = {}) {
      if (!item || busy) return false;
      render(); busy = true;
      try { await playLibrarySong(item, { resume }); return true; }
      catch (error) { releaseQueue(); toast(error.message, "error"); return false; }
      finally { busy = false; }
    }

    async function playNow(queueId) {
      if (busy) return false;
      const wasCurrent = state.currentId === queueId;
      return playActivated(activateQueueId(state, queueId, { discardSkipped: true }), { resume: wasCurrent });
    }

    async function playQueue() {
      if (busy || !state.items.length) { if (!state.items.length) toast("Player Queue is empty", "error"); return false; }
      if (!state.currentId && state.cursor >= state.items.length) state.cursor = 0;
      const item = state.currentId ? state.items[currentIndex(state)] : state.mode === "shuffle" ? activateRandomNext(state) : activateNext(state);
      if (!item) return false;
      state.active = true;
      return playActivated(item, { resume: true });
    }

    async function stopQueue() {
      state.active = false; render();
      if (state.currentId) {
        suppressCancel = true;
        try {
          if (typeof window.PianoPlaybackOwner?.stop === "function") await window.PianoPlaybackOwner.stop();
          else stopButton?.click();
        } finally { suppressCancel = false; }
      }
      toast("Player Queue stopped. Play Queue will resume the current song.", "idle");
    }

    function toggleQueue() { return state.active ? stopQueue() : playQueue(); }

    async function playAllLibrary() {
      if (busy) return;
      try {
        const songs = await librarySongs(); if (!songs.length) return toast("Local Library has no saved songs to play.", "error");
        state = restoreQueueState({ items: songs.map(makeItem), mode: "ordered", transitionMs: state.transitionMs });
        render(); await playQueue();
      } catch (error) { toast(error.message, "error"); }
    }

    async function step(delta) {
      if (busy) return false;
      const item = state.mode === "shuffle" && delta > 0 ? activateRandomNext(state) : stepQueue(state, delta);
      if (!item) { toast(delta < 0 ? "No earlier queue song." : "End of Player Queue.", "idle"); return false; }
      return playActivated(item);
    }

    async function advanceAfterComplete() {
      if (!state.active || !state.currentId || busy) return false;
      const item = state.items[currentIndex(state)];
      if (item && !titleMatches(item)) { releaseQueue("Player Queue released to manual playback."); return false; }
      completeCurrent(state);
      if (state.cursor >= state.items.length) { state.active = false; render(); toast("Player Queue finished.", "complete"); return true; }
      if (state.mode === "manual") { state.active = false; render(); toast("Song finished — Player Queue is waiting for Play Queue.", "complete"); return false; }
      const itemNext = state.mode === "shuffle" ? activateRandomNext(state) : activateNext(state);
      render(); await wait(state.transitionMs); return playActivated(itemNext);
    }

    async function playSongNow(songId) {
      const entries = entriesForSong(state, songId);
      let entry = entries.find(item => item.status === "current") || entries.find(item => item.status === "next" || item.status === "queued") || entries[0];
      if (!entry) {
        const song = (await librarySongs()).find(item => String(item.id) === String(songId));
        if (!song) return false;
        addSong(song, false);
        entry = entriesForSong(state, songId).at(-1);
      }
      return playNow(entry.queueId);
    }

    function bind() {
      mode.addEventListener("change", () => { state.mode = MODES.has(mode.value) ? mode.value : "ordered"; render(); });
      transition.addEventListener("change", () => { const value = Number(transition.value); state.transitionMs = TRANSITIONS.has(value) ? value : 750; render(); });
      play.addEventListener("click", () => void toggleQueue());
      playAll.addEventListener("click", () => void playAllLibrary());
      shuffleButton.addEventListener("click", shuffleRemaining);
      clear.addEventListener("click", clearQueue);
      stopButton?.addEventListener("click", () => { if (!suppressCancel && state.active) releaseQueue("Player Queue stopped."); });
      playButton?.addEventListener("click", () => { if (!suppressCancel && state.active) releaseQueue("Player Queue released to manual playback."); });
    }

    const observer = new MutationObserver(() => { clearTimeout(syncTimer); syncTimer = setTimeout(syncLibraryDecoration, 40); });
    if (library) observer.observe(library, { childList: true, subtree: true });
    const statusChip = document.getElementById("statusChip");
    if (statusChip) {
      const statusObserver = new MutationObserver(() => {
        const value = statusChip.dataset.state || "";
        if (value === "complete" && lastStatus !== "complete") { lastStatus = "complete"; void advanceAfterComplete(); }
        else if (value !== "complete") lastStatus = value;
      });
      statusObserver.observe(statusChip, { attributes: true, attributeFilter: ["data-state"] });
    }

    const publicApi = Object.freeze({
      addSong, addSongs, playQueue, toggleQueue, stopQueue, playAllLibrary, clearQueue, shuffleRemaining, advanceAfterComplete, render,
      previous: () => step(-1), next: () => step(1), shuffleSelected: shuffleSelectedSongs, removeSongs, removeAllSongs,
      playQueueId: queueId => playNow(queueId),
      reorderQueueId: reorder, duplicateQueueIdAfter: duplicateAfter, removeQueueId: queueId => { const before = state.items.length; removeItem(queueId); return before - state.items.length; },
      getState: () => queueSnapshot(state), getSongEntries: songId => entriesForSong(state, songId),
      hasSong: songId => entriesForSong(state, songId).length > 0,
      getSongPosition: songId => entriesForSong(state, songId).find(item => item.status !== "played")?.index ?? entriesForSong(state, songId)[0]?.index ?? -1,
      removeSong: songId => removeSongs([songId]),
      moveSong: (songId, delta) => { const entry = entriesForSong(state, songId).find(item => item.status === "next" || item.status === "queued"); if (entry) move(entry.queueId, delta); },
      playSongNow,
      setMode: value => { if (MODES.has(value)) { state.mode = value; render(); } }
    });
    window.PianoPlayerQueue = publicApi;
    window.dispatchEvent(new CustomEvent("piano:player-queue-ready", { detail: publicApi }));
    bind(); render(); syncLibraryDecoration();
    return publicApi;
  });
}

const boot = () => { void installPlayerQueue(); };
if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", boot, { once: true });
else boot();

export { installPlayerQueue };
