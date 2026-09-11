import { api } from "./api.js";
import { PerformanceRecorder, bindPhysicalPiano } from "./piano.js";
import { setupPianoControls } from "./piano_controls.js";
import { InternalPreviewPlayer } from "./internal_preview.js";
import { actionButton, escapeHtml, formatTime, resultNode as buildResultNode } from "./ui_helpers.js";
import { setupYoutubePiano } from "./youtube_piano.js";
import { setupLibraryTransfer } from "./library_transfer.js";
import { setupSheetWorkspace } from "./sheet_workspace.js";
import { setupBulkConversion } from "./bulk_conversion.js";
const $ = (id) => document.getElementById(id);
const els = {
  title: $("titleInput"), sheet: $("sheetInput"), stats: $("sheetStats"),
  play: $("playBtn"), pause: $("pauseBtn"), stop: $("stopBtn"), save: $("saveSongBtn"),
  dryRun: $("dryRun"), internalPlay: $("internalPlay"), pianoLayout: $("pianoLayout"), pianoSound: $("pianoSound"), pianoSoundStatus: $("pianoSoundStatus"), autoFocus: $("autoFocus"), inputMode: $("inputMode"), window: $("windowSelect"), refreshWindows: $("refreshWindowsBtn"),
  interval: $("intervalRange"), intervalValue: $("intervalValue"), hold: $("holdRange"), holdValue: $("holdValue"),
  adaptiveHold: $("adaptiveHold"), gate: $("gateRange"), gateValue: $("gateValue"),
  blackLead: $("blackLeadRange"), blackLeadValue: $("blackLeadValue"), chordSpread: $("chordSpreadRange"), chordSpreadValue: $("chordSpreadValue"),
  countdown: $("countdownRange"), countdownValue: $("countdownValue"), globalSpeed: $("globalSpeedRange"), globalSpeedValue: $("globalSpeedValue"),
  statusChip: $("statusChip"), statusText: $("statusText"), progressBar: $("progressBar"), progressText: $("progressText"), currentToken: $("currentToken"),
  seekRange: $("eventSeekRange"), seekInput: $("eventSeekInput"), seekTotal: $("eventSeekTotal"), seekGo: $("seekGoBtn"), seekStart: $("seekStartBtn"), seekEnd: $("seekEndBtn"),
  searchForm: $("searchForm"), search: $("searchInput"), searchMessage: $("searchMessage"), searchResults: $("searchResults"), providerFilters: $("providerFilters"),
  youtubeForm: $("youtubePianoForm"), youtubeUrl: $("youtubePianoUrl"), youtubeMessage: $("youtubePianoMessage"), youtubeButton: $("youtubePianoBtn"),
  library: $("libraryList"), refreshLibrary: $("refreshLibraryBtn"), template: $("resultTemplate"),
  piano: $("practicePiano"), record: $("recordBtn"), recordStop: $("recordStopBtn"), replay: $("replayRecordingBtn"), clearRecording: $("clearRecordingBtn"), saveRecording: $("saveRecordingBtn"),
  recordState: $("recordState"), recordStats: $("recordStats"), pianoVisualMeta: $("pianoVisualMeta"),
};
let activeSongId = null, activeTranscriptionDiagnostics = null;
let activePerformance = [];
let parseTimer = null;
let providerIds = [];
let sheetEventTotal = 0;
let seekTarget = 1;
let seekInteracting = false;
let seekInFlight = false;
let queuedSeekTarget = 0;
let seekSettlingUntil = 0;
let lastStatus = { status: "idle", current_index: 0, total_events: 0 };
let stoppedResumeEvent = 0;
let playShouldRestart = false;
const recorder = new PerformanceRecorder(updateRecordingUI);
const internalPreview = new InternalPreviewPlayer(els.piano);
const pianoControls = setupPianoControls({ layoutSelect: els.pianoLayout, soundSelect: els.pianoSound, soundStatus: els.pianoSoundStatus, visualMeta: els.pianoVisualMeta, piano: els.piano, recorder, preview: internalPreview });
bindPhysicalPiano(recorder, els.piano, () => els.pianoLayout.value);
const resultNode = (...args) => buildResultNode(els.template, ...args);
let sheetWorkspace = null;
const youtubePiano = setupYoutubePiano({ form: els.youtubeForm, input: els.youtubeUrl, message: els.youtubeMessage, button: els.youtubeButton, searchInput: els.search, onSong: (song, result) => sheetWorkspace?.stage(song, result) });
const libraryTransfer = setupLibraryTransfer({ exportAllButton: $("exportLibraryBtn"), importButton: $("importLibraryBtn"), importInput: $("importLibraryInput"), onImported: refreshLibrary, toast });
sheetWorkspace = setupSheetWorkspace({ onLoad: applyImportedSong, getCurrent: currentSheetSnapshot, toast });
setupBulkConversion({ youtubePiano, workspace: sheetWorkspace });
function playbackPayload() {
  return {
    title: els.title.value.trim() || "Untitled",
    target_window: els.window.selectedOptions[0]?.dataset.title || els.window.selectedOptions[0]?.textContent || "Roblox",
    target_hwnd: Number(els.window.value) || 0,
    input_mode: els.inputMode.value || "foreground",
    auto_focus: els.inputMode.value === "foreground" && els.autoFocus.checked,
    dry_run: els.dryRun.checked && !els.internalPlay.checked,
    interval_ms: Number(els.interval.value),
    note_hold_ms: Number(els.hold.value),
    adaptive_hold: els.adaptiveHold.checked,
    gate_percent: Number(els.gate.value),
    modifier_lead_ms: Number(els.blackLead.value),
    modifier_tail_ms: 2,
    chord_spread_ms: Number(els.chordSpread.value),
    countdown_seconds: Number(els.countdown.value),
    speed: Number(els.globalSpeed.value),
    start_event: Math.max(1, Number(seekTarget) || 1),
    timing_profile: els.sheet.dataset.timingProfile || "expressive", piano_layout: els.pianoLayout.value || "61",
  };
}
function toast(message, state = "idle") {
  els.statusText.textContent = message;
  els.statusChip.dataset.state = state;
}
function updateSliderLabels() {
  els.intervalValue.textContent = `${els.interval.value} ms`;
  els.holdValue.textContent = `${els.hold.value} ms`;
  els.gateValue.textContent = `${els.gate.value}%`;
  els.blackLeadValue.textContent = `${els.blackLead.value} ms`;
  els.chordSpreadValue.textContent = `${els.chordSpread.value} ms`;
  els.countdownValue.textContent = `${Number(els.countdown.value).toFixed(1)} s`;
  els.globalSpeedValue.textContent = `${Number(els.globalSpeed.value).toFixed(2)}×`;
  document.querySelectorAll("[data-speed]").forEach(button => button.classList.toggle("active", Number(button.dataset.speed) === Number(els.globalSpeed.value)));
}
function performanceDuration(events = activePerformance) {
  return events.reduce((max, event) => Math.max(max, Number(event.at_ms || 0) + Number(event.duration_ms || 0)), 0);
}
function currentSheetSnapshot() {
  return { _activeSongId: activeSongId, title: els.title.value.trim() || "Untitled sheet", sheet: els.sheet.value, performance: activePerformance.map(event => ({ ...event })), duration_ms: performanceDuration(), source: els.sheet.dataset.source || "manual", source_url: els.sheet.dataset.sourceUrl || "", timing_profile: els.sheet.dataset.timingProfile || "expressive", transcription_diagnostics: activeTranscriptionDiagnostics, recommended_interval_ms: Number(els.interval.value) };
}
function isTimedPerformance() { return activePerformance.length > 0; }
async function refreshStats() {
  if (isTimedPerformance()) {
    const notes = activePerformance.reduce((sum, event) => sum + Math.max(1, String(event.key || "").length), 0);
    const chords = activePerformance.filter(event => String(event.key || "").length > 1).length;
    els.stats.innerHTML = `<span>${activePerformance.length} timed events</span><span>${notes} notes</span><span>${chords} chords</span><span>${formatTime(performanceDuration())}</span>`;
    sheetEventTotal = 0; setSeekTarget(Math.min(seekTarget, activePerformance.length || 1), false); return;
  }
  try {
    const summary = await api.parse(els.sheet.value, els.sheet.dataset.timingProfile || "expressive");
    els.stats.innerHTML = `<span>${summary.events} events</span><span>${summary.notes} notes</span><span>${summary.chords} chords</span><span>${summary.pauses} pauses</span>`;
    sheetEventTotal = Number(summary.events || 0);
    setSeekTarget(Math.min(seekTarget, Math.max(sheetEventTotal, 1)), false);
  } catch (error) {
    els.stats.innerHTML = `<span>${escapeHtml(error.message || "Invalid sheet")}</span>`;
    sheetEventTotal = 0;
  }
}
function queueStats() {
  clearTimeout(parseTimer);
  parseTimer = setTimeout(refreshStats, 180);
}
function internalMode() { return els.internalPlay.checked; }
async function internalTimeline(performance = null) {
  const payload = { ...playbackPayload(), countdown_seconds: 0 };
  if (performance || isTimedPerformance()) return api.previewPerformance({ ...payload, performance: performance || activePerformance });
  return api.preview({ ...payload, sheet: els.sheet.value });
}
async function startPlayback(options = {}) {
  try {
    if (internalMode()) { internalPreview.unlock(); await pianoControls.prepareSound(); }
    const resumeEvent = Number(options.resumeEvent || 0);
    if (resumeEvent > 0) setSeekTarget(resumeEvent, false, currentSeekTotal());
    else if (playShouldRestart) setSeekTarget(1, false, currentSeekTotal());
    toast(resumeEvent ? `Resuming from event ${seekTarget}…` : isTimedPerformance() ? "Starting timed performance…" : "Starting sheet…", "countdown");
    if (internalMode()) { await api.stop().catch(() => {}); internalPreview.start(await internalTimeline(), seekTarget, Number(els.countdown.value)); }
    else {
      internalPreview.reset();
      if (isTimedPerformance()) await api.playPerformance({ ...playbackPayload(), performance: activePerformance }); else await api.play({ ...playbackPayload(), sheet: els.sheet.value });
    }
    playShouldRestart = false;
    stoppedResumeEvent = 0;
    els.pause.textContent = "Ⅱ Pause";
  } catch (error) { toast(error.message, "error"); }
}
async function replayRecording() {
  const performance = recorder.snapshot().events.length ? recorder.snapshot().events : activePerformance;
  if (!performance.length) return toast("Record or load a performance first", "error");
  try {
    if (internalMode()) { internalPreview.unlock(); await pianoControls.prepareSound(); }
    toast("Starting recorded performance…", "countdown");
    if (internalMode()) { await api.stop().catch(() => {}); internalPreview.start(await internalTimeline(performance), seekTarget, Number(els.countdown.value)); }
    else { internalPreview.reset(); await api.playPerformance({ ...playbackPayload(), performance }); }
  } catch (error) { toast(error.message, "error"); }
}
async function togglePause() {
  try {
    if (lastStatus.status === "idle" && stoppedResumeEvent > 0) {
      const resumeEvent = stoppedResumeEvent;
      await startPlayback({ resumeEvent });
      return;
    }
    const data = internalMode() ? { paused: internalPreview.togglePause() } : await api.pause();
    els.pause.textContent = data.paused ? "▶ Resume" : "Ⅱ Pause";
  } catch (error) { toast(error.message, "error"); }
}
async function stopPlayback() {
  try {
    const data = internalMode() ? internalPreview.stop() : await api.stop();
    stoppedResumeEvent = Number(data.resume_event || lastStatus.current_index || seekTarget || 0);
    playShouldRestart = true;
    setSeekTarget(1, false, currentSeekTotal());
    els.pause.textContent = stoppedResumeEvent > 0 ? "▶ Resume" : "Ⅱ Pause";
  } catch (error) { toast(error.message, "error"); }
}
async function pollStatus() {
  try {
    const status = internalMode() ? internalPreview.status() : await api.status();
    const previousStatus = lastStatus.status;
    lastStatus = status;
    window.dispatchEvent(new CustomEvent("piano:sheet-progress-status", { detail: { ...status, timing_profile: status.timing_profile || els.sheet.dataset.timingProfile || "expressive", sheet_total: sheetEventTotal } }));
    els.statusChip.dataset.state = status.status || "idle";
    els.statusText.textContent = status.message || "Ready";
    const activeTimeline = ["countdown", "playing", "paused"].includes(status.status);
    const seekBusy = seekInteracting || seekInFlight || queuedSeekTarget > 0 || Date.now() < seekSettlingUntil;
    if (!seekBusy && activeTimeline && Number(status.total_events || 0) > 0) {
      setSeekTarget(Number(status.current_index || 1), true, Number(status.total_events));
    } else {
      renderSeekProgress(seekTarget, currentSeekTotal());
    }
    els.currentToken.textContent = status.current_token || "—";
    if (status.status === "complete") {
      if (!seekInteracting && Number(status.total_events || 0) > 0) setSeekTarget(status.total_events, true, status.total_events);
      if (previousStatus !== "complete") playShouldRestart = true;
      stoppedResumeEvent = 0;
      els.pause.textContent = "Ⅱ Pause";
    } else if (status.status === "idle" && Number(status.resume_index || 0) > 0) {
      stoppedResumeEvent = Number(status.resume_index);
      els.pause.textContent = "▶ Resume";
    } else if (status.status === "paused") {
      els.pause.textContent = "▶ Resume";
    } else if (status.status !== "stopping") {
      els.pause.textContent = "Ⅱ Pause";
    }
  } catch (_) {
    els.statusChip.dataset.state = "error";
    els.statusText.textContent = "Local server disconnected";
  } finally { setTimeout(pollStatus, 300); }
}

function currentSeekTotal() {
  const runtimeTotal = Number(lastStatus.total_events || 0);
  if (["countdown", "playing", "paused", "stopping"].includes(lastStatus.status) && runtimeTotal > 0) return runtimeTotal;
  if (sheetEventTotal > 0) return sheetEventTotal;
  if (activePerformance.length) return activePerformance.length;
  return Math.max(runtimeTotal, 0);
}

function renderSeekProgress(index, total) {
  const safeTotal = Math.max(Number(total) || 0, 0);
  const safeIndex = safeTotal ? Math.max(1, Math.min(Number(index) || 1, safeTotal)) : 0;
  const progress = safeTotal ? safeIndex / safeTotal : 0;
  els.progressBar.style.width = `${Math.max(0, Math.min(100, progress * 100))}%`;
  els.progressText.textContent = `${safeIndex} / ${safeTotal} events`;
  els.seekTotal.textContent = `/ ${safeTotal}`;
}

function setSeekTarget(value, fromStatus = false, forcedTotal = 0) {
  const total = Math.max(Number(forcedTotal) || currentSeekTotal() || 0, 0);
  seekTarget = total ? Math.max(1, Math.min(Math.round(Number(value) || 1), total)) : 1;
  els.seekRange.max = String(Math.max(total, 1));
  els.seekRange.value = String(seekTarget);
  els.seekInput.max = String(Math.max(total, 1));
  els.seekInput.value = String(seekTarget);
  renderSeekProgress(seekTarget, total);
  if (fromStatus) return;
}

async function applySeek(value) {
  const total = currentSeekTotal();
  if (!total) return;
  setSeekTarget(value, false, total);
  if (!["countdown", "playing", "paused"].includes(lastStatus.status)) { playShouldRestart = false; return; }
  queuedSeekTarget = seekTarget; seekSettlingUntil = Date.now() + 450;
  if (seekInFlight) return;
  seekInFlight = true;
  try {
    while (queuedSeekTarget > 0) {
      const target = queuedSeekTarget; queuedSeekTarget = 0;
      const data = internalMode() ? { event_index: internalPreview.seek(target) } : await api.seek(target);
      if (!queuedSeekTarget) setSeekTarget(data.event_index || target, false, total);
    }
    toast(`Seeked to event ${seekTarget}`, lastStatus.status === "paused" ? "paused" : "playing");
  } catch (error) { queuedSeekTarget = 0; toast(error.message, "error"); }
  finally { seekInFlight = false; seekSettlingUntil = Date.now() + 250; }
}

function nudgeSeek(delta) {
  const total = currentSeekTotal();
  setSeekTarget(seekTarget + Number(delta || 0), false, total);
  applySeek(seekTarget);
}

async function refreshWindows() {
  try {
    const current = els.window.value;
    const data = await api.windows();
    els.window.innerHTML = "";
    const windows = (data.windows || []).filter(item => item && item.title);
    if (!windows.length) windows.push({ hwnd: 0, title: "Roblox" });
    for (const item of windows) {
      const option = document.createElement("option");
      option.value = String(item.hwnd || 0); option.textContent = item.title; option.dataset.title = item.title;
      els.window.append(option);
    }
    const match = [...els.window.options].find(option => option.value === current) || [...els.window.options].find(option => /roblox/i.test(option.textContent));
    if (match) els.window.value = match.value;
  } catch (error) { toast(error.message, "error"); }
}

async function loadProviders() {
  try {
    const data = await api.providers();
    providerIds = (data.providers || []).map(provider => provider.id);
    els.providerFilters.innerHTML = "";
    for (const provider of data.providers || []) {
      const label = document.createElement("label");
      label.className = "provider-check";
      label.innerHTML = `<input type="checkbox" value="${provider.id}" checked> <span>${provider.name}</span>`;
      els.providerFilters.append(label);
    }
  } catch (_) {}
}

function selectedProviders() {
  return [...els.providerFilters.querySelectorAll("input:checked")].map(input => input.value);
}

async function searchSheets(event) {
  event?.preventDefault();
  const query = els.search.value.trim();
  if (!query) return;
  els.searchMessage.textContent = "Searching providers independently…";
  els.searchResults.innerHTML = "";
  try {
    const data = await api.search(query, selectedProviders());
    const results = data.results || [];
    const errors = data.errors || {};
    if (!results.length) {
      const failed = Object.keys(errors).length ? ` Provider errors: ${Object.entries(errors).map(([id, msg]) => `${id}: ${msg}`).join(" · ")}` : "";
      els.searchMessage.textContent = `No matching sheets returned.${failed}`;
      return;
    }
    const sources = new Set(results.map(result => result.provider_name)).size;
    const failed = Object.keys(errors).length;
    els.searchMessage.textContent = `${results.length} result${results.length === 1 ? "" : "s"} from ${sources} source${sources === 1 ? "" : "s"}${failed ? ` · ${failed} provider error${failed === 1 ? "" : "s"}` : ""}`;
    for (const result of results) {
      const actions = [];
      if (result.importable !== false) actions.push(actionButton("Import", "primary small", () => importResult(result)));
      if (result.video_url) actions.push(actionButton("Piano from video", "primary small", () => youtubePiano.transcribe(result.video_url, result.title || "")));
      actions.push(actionButton("Source", "ghost small", () => window.open(result.url, "_blank", "noopener")));
      els.searchResults.append(resultNode(result.title || "Sheet", result.provider_name || result.artist || "Online", actions, result.provider_name));
    }
  } catch (error) { els.searchMessage.textContent = error.message; }
}

function applyPlaybackOverrides(song) {
  const c = song?.identifiers?.custom || {};
  if (c.override_speed) els.globalSpeed.value = String(c.override_speed);
  if (c.override_interval) els.interval.value = String(c.override_interval);
  if (c.override_hold) els.hold.value = String(c.override_hold);
  if (c.override_gate) els.gate.value = String(c.override_gate);
  if (c.override_chord_spread) els.chordSpread.value = String(c.override_chord_spread);
  if (c.override_black_lead) els.blackLead.value = String(c.override_black_lead);
  updateSliderLabels();
}

async function applyImportedSong(song, result = {}) {
  internalPreview.reset();
  activeSongId = song._activeSongId || null; activeTranscriptionDiagnostics = song.transcription_diagnostics || null; activePerformance = Array.isArray(song.performance) ? song.performance : []; if (activePerformance.length) recorder.load(activePerformance); else recorder.clear(); seekTarget = 1; stoppedResumeEvent = 0; playShouldRestart = false;
  els.title.value = song.artist ? `${song.title} — ${song.artist}` : (song.title || "Untitled sheet"); els.sheet.value = song.sheet || "";
  els.sheet.dataset.source = song.source || result.provider_name || "online"; els.sheet.dataset.sourceUrl = song.source_url || result.url || ""; els.sheet.dataset.timingProfile = song.timing_profile || "expressive"; youtubePiano.showDiagnostics(activeTranscriptionDiagnostics);
  const custom = song?.identifiers?.custom || {};
  const suggested = Number(custom.override_interval || song.recommended_interval_ms || (activePerformance.length ? 0 : 115));
  if (suggested > 0) { const min = Number(els.interval.min || 25), max = Number(els.interval.max || 500); els.interval.value = Math.max(min, Math.min(max, Math.round(suggested / 5) * 5)); updateSliderLabels(); }
  applyPlaybackOverrides(song);
  await refreshStats();
  const timing = suggested > 0 ? ` · source timing ~${Math.round(suggested)} ms` : "";
  const profile = song.timing_profile && song.timing_profile !== "expressive" ? ` · ${song.timing_profile} translator` : "";
  const sourceNotes = Number(song.note_count || 0) > 0 ? ` · ${song.note_count} source notes` : "";
  const chordInfo = Number(song.chord_count || 0) > 0 ? ` · ${song.chord_count} chords` : "";
  toast(`${activePerformance.length ? "Timed performance imported" : "Sheet imported"}${sourceNotes}${chordInfo}${timing}${profile}`, "complete");
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function importResult(result) {
  toast(`Importing from ${result.provider_name || "source"}…`, "countdown");
  try { sheetWorkspace.stage(await api.importSheet(result.url, result.provider || ""), result); } catch (error) { toast(error.message, "error"); }
}

async function saveCurrentSong() {
  if (!els.sheet.value.trim() && !activePerformance.length) return toast("Nothing to save yet", "error");
  try {
    const performance = isTimedPerformance() ? activePerformance : [];
    const data = await api.saveSong({ id: activeSongId, title: els.title.value.trim() || "Untitled", kind: performance.length ? "performance" : "sheet", sheet: els.sheet.value, performance, duration_ms: performanceDuration(performance), source: els.sheet.dataset.source || "manual", source_url: els.sheet.dataset.sourceUrl || "", timing_profile: els.sheet.dataset.timingProfile || "expressive", transcription_diagnostics: activeTranscriptionDiagnostics });
    activeSongId = data.song.id;
    toast("Sheet saved locally", "complete");
    await refreshLibrary();
  } catch (error) { toast(error.message, "error"); }
}

async function saveRecording() {
  const snapshot = recorder.snapshot();
  if (!snapshot.events.length) return toast("Record something first", "error");
  try {
    const data = await api.saveSong({ id: activeSongId, title: els.title.value.trim() || "Untitled recording", kind: "performance", performance: snapshot.events, duration_ms: snapshot.duration_ms, source: "recorder" });
    activeSongId = data.song.id; activeTranscriptionDiagnostics = null; youtubePiano.showDiagnostics(null); activePerformance = snapshot.events;
    toast("Timed performance saved", "complete");
    await refreshLibrary();
  } catch (error) { toast(error.message, "error"); }
}

async function refreshLibrary() {
  els.library.innerHTML = "";
  try {
    const data = await api.songs();
    const songs = data.songs || [];
    if (!songs.length) return els.library.innerHTML = '<div class="empty">No saved songs or recordings yet.</div>';
    for (const song of songs) {
      const type = song.performance?.length ? `recording · ${song.performance.length} notes · ${formatTime(song.duration_ms || 0)}` : song.source || "sheet";
      els.library.append(resultNode(song.title, type, [actionButton("Load", "primary small", () => loadSong(song)), actionButton("Export", "ghost small", () => libraryTransfer.exportSong(song)), actionButton("Delete", "danger small", () => deleteSong(song))], song.performance?.length ? "Recording" : "Sheet"));
    }
  } catch (error) { els.library.innerHTML = `<div class="empty">${error.message}</div>`; }
  window.dispatchEvent(new CustomEvent("piano:unified-refresh-requested"));
}

function loadSong(song) {
  void sheetWorkspace.load({ ...song, _activeSongId: song.id }, { provider_name: song.source || "Local library", url: song.source_url || "" });
}

async function deleteSong(song) {
  if (!confirm(`Delete “${song.title}” from the local library?`)) return;
  try { await api.deleteSong(song.id); if (activeSongId === song.id) activeSongId = null; await refreshLibrary(); } catch (error) { toast(error.message, "error"); }
}

function updateRecordingUI(snapshot) {
  activePerformance = snapshot.events;
  els.recordState.textContent = snapshot.recording ? "● Recording — play the piano" : snapshot.events.length ? "Recording captured" : "Ready to record";
  els.recordState.classList.toggle("recording-live", snapshot.recording);
  els.recordStats.textContent = `${snapshot.events.length} notes · ${formatTime(snapshot.duration_ms)}`;
  els.record.textContent = snapshot.recording ? "● Recording…" : "● Record";
}

function startRecording() { activeSongId = null; activeTranscriptionDiagnostics = null; youtubePiano.showDiagnostics(null); recorder.start(); toast("Recording local piano timing", "countdown"); }
function finishRecording() { const snap = recorder.stop(); toast(snap.events.length ? "Recording captured" : "No notes recorded", snap.events.length ? "complete" : "idle"); }
function clearRecording() { activeSongId = null; activeTranscriptionDiagnostics = null; youtubePiano.showDiagnostics(null); activePerformance = []; recorder.clear(); seekTarget = 1; setSeekTarget(1); toast("Recording cleared", "idle"); }

function updateInputModeUI() {
  const internal = internalMode();
  els.window.disabled = internal; els.refreshWindows.disabled = internal; els.inputMode.disabled = internal; els.dryRun.disabled = internal; if (internal) els.dryRun.checked = false;
  els.autoFocus.disabled = internal || els.inputMode.value !== "foreground";
}

async function changeInternalMode() {
  const internal = internalMode();
  const data = internal ? await api.stop().catch(() => ({ resume_event: 0 })) : internalPreview.stop();
  if (data.resume_event) { if (!internal) stoppedResumeEvent = data.resume_event; setSeekTarget(data.resume_event, false, currentSeekTotal()); }
  toast(internal ? "Internal play enabled — output stays inside this tool" : "External playback route restored", "idle"); updateInputModeUI();
}

function setGlobalSpeed(value) {
  els.globalSpeed.value = String(Math.max(0.25, Math.min(3, Number(value) || 1)));
  updateSliderLabels();
}

function bind() {
  els.play.addEventListener("click", startPlayback); els.pause.addEventListener("click", togglePause); els.stop.addEventListener("click", stopPlayback);
  els.save.addEventListener("click", saveCurrentSong); els.refreshLibrary.addEventListener("click", refreshLibrary); els.refreshWindows.addEventListener("click", refreshWindows);
  els.searchForm.addEventListener("submit", searchSheets); els.sheet.addEventListener("input", () => { activeSongId = null; activePerformance = []; activeTranscriptionDiagnostics = null; youtubePiano.showDiagnostics(null); internalPreview.reset(); seekTarget = 1; stoppedResumeEvent = 0; playShouldRestart = false; els.sheet.dataset.timingProfile = "expressive"; queueStats(); });
  els.seekRange.addEventListener("pointerdown", () => { seekInteracting = true; });
  els.seekRange.addEventListener("input", () => { seekInteracting = true; setSeekTarget(els.seekRange.value); });
  els.seekRange.addEventListener("change", async () => { await applySeek(els.seekRange.value); seekInteracting = false; });
  els.seekRange.addEventListener("pointerup", () => { seekInteracting = false; });
  els.seekGo.addEventListener("click", () => applySeek(els.seekInput.value));
  els.seekInput.addEventListener("keydown", event => { if (event.key === "Enter") applySeek(els.seekInput.value); });
  els.seekStart.addEventListener("click", () => applySeek(1));
  els.seekEnd.addEventListener("click", () => applySeek(currentSeekTotal()));
  document.querySelectorAll("[data-seek-delta]").forEach(button => button.addEventListener("click", () => nudgeSeek(button.dataset.seekDelta)));
  [els.interval, els.hold, els.gate, els.blackLead, els.chordSpread, els.countdown, els.globalSpeed].forEach(element => element.addEventListener("input", updateSliderLabels));
  els.inputMode.addEventListener("change", updateInputModeUI); els.internalPlay.addEventListener("change", changeInternalMode);
  document.querySelectorAll("[data-speed]").forEach(button => button.addEventListener("click", () => setGlobalSpeed(button.dataset.speed)));
  els.record.addEventListener("click", startRecording); els.recordStop.addEventListener("click", finishRecording); els.replay.addEventListener("click", replayRecording);
  els.clearRecording.addEventListener("click", clearRecording); els.saveRecording.addEventListener("click", saveRecording);
  window.addEventListener("keydown", event => { if (event.key === "F7" && internalMode()) { event.preventDefault(); stopPlayback(); } });
}

bind(); updateInputModeUI(); updateSliderLabels(); refreshStats(); refreshLibrary(); refreshWindows(); loadProviders(); pollStatus();