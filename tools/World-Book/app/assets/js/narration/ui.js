(function () {
  const WB = window.WorldBook = window.WorldBook || {};
  const controller = WB.Narration;
  const deleting = new Map();
  let recognition = null;
  let lastCacheState = "";

  const byId = id => document.getElementById(id);

  function showDialog() {
    const dialog = byId("reader-library-dialog");
    if (!dialog) return;
    if (typeof dialog.showModal === "function" && !dialog.open) dialog.showModal();
    else dialog.setAttribute("open", "");
    WB.NarrationLayout.apply(WB.NarrationLayout.preference(), false);
    void refreshDocuments();
    void refreshCache();
  }

  function closeDialog() {
    const dialog = byId("reader-library-dialog");
    if (!dialog) return;
    if (typeof dialog.close === "function" && dialog.open) dialog.close();
    else dialog.removeAttribute("open");
  }

  function status(message, tone = "") {
    const output = byId("reader-status");
    if (!output) return;
    output.textContent = message;
    output.dataset.tone = tone;
  }

  function humanBytes(bytes) {
    const value = Math.max(0, Number(bytes) || 0);
    if (value < 1024) return `${value} B`;
    if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
    return `${(value / 1024 ** 2).toFixed(1)} MB`;
  }

  function renderPassage(value) {
    const preview = byId("reader-passage-preview");
    if (!preview) return;
    const passage = String(value.passage || "");
    if (!passage) {
      preview.textContent = "The current passage will appear here.";
      preview.dataset.highlight = "none";
      preview.removeAttribute("aria-label");
      return;
    }

    const marker = value.marker;
    const active = ["generating", "playing", "paused"].includes(value.status);
    if (!active || !marker) {
      preview.textContent = passage;
      preview.dataset.highlight = "none";
      preview.setAttribute("aria-label", passage);
      return;
    }

    const clamp = number => Math.min(passage.length, Math.max(0, Number(number) || 0));
    const sentenceStart = clamp(marker.sentenceStart);
    const sentenceEnd = Math.max(sentenceStart, clamp(marker.sentenceEnd));
    const wordStart = Math.min(sentenceEnd, Math.max(sentenceStart, clamp(marker.wordStart)));
    const wordEnd = Math.min(sentenceEnd, Math.max(wordStart, clamp(marker.wordEnd)));
    const sentence = document.createElement("span");
    sentence.className = "narration-highlight-sentence";
    if (marker.kind === "estimated") sentence.classList.add("is-estimated");
    sentence.append(document.createTextNode(passage.slice(sentenceStart, wordStart)));
    if (wordEnd > wordStart) {
      const word = document.createElement("mark");
      word.className = "narration-highlight-word";
      word.textContent = passage.slice(wordStart, wordEnd);
      sentence.append(word);
    }
    sentence.append(document.createTextNode(passage.slice(wordEnd, sentenceEnd)));
    preview.replaceChildren(
      document.createTextNode(passage.slice(0, sentenceStart)),
      sentence,
      document.createTextNode(passage.slice(sentenceEnd)),
    );
    preview.dataset.highlight = marker.kind || "passage";
    preview.setAttribute("aria-label", passage);
  }

  async function refreshCache() {
    const output = byId("reader-cache-stats");
    if (!output) return;
    try {
      const value = await WB.NarrationStore.stats();
      output.textContent = `Audio cache: ${value.count} passage${value.count === 1 ? "" : "s"} across ${value.sources || 0} source${value.sources === 1 ? "" : "s"} / ${humanBytes(value.bytes)}`;
      WB.NarrationHost?.post?.({ type: "eve-world-book-narration-cache-stats", stats: value });
      await WB.NarrationCacheUI?.refresh?.();
    } catch (error) {
      output.textContent = "Audio cache is unavailable";
    }
  }

  function documentCard(record) {
    const card = document.createElement("article");
    card.className = "narration-document-card";
    card.dataset.readerDocumentId = record.id;

    const main = document.createElement("button");
    main.type = "button";
    main.className = "narration-document-main";
    const title = document.createElement("strong");
    title.textContent = record.title || "Untitled document";
    const details = document.createElement("small");
    details.textContent = `${String(record.format || "text").toUpperCase()} / ${Number(record.characterCount || 0).toLocaleString()} characters`;
    main.append(title, details);
    main.addEventListener("click", () => void loadDocument(record.id));

    const actions = document.createElement("div");
    actions.className = "narration-document-actions";
    if (record.hasSource) {
      const download = document.createElement("a");
      download.className = "button button-small";
      download.href = WB.API.readerDocumentDownloadUrl(record.id);
      download.textContent = "Original";
      download.title = "Download the imported source file";
      actions.append(download);
    }

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "button button-small narration-delete-button";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => void requestDelete(record, remove));
    actions.append(remove);
    card.append(main, actions);
    return card;
  }

  async function refreshDocuments() {
    const list = byId("reader-document-list");
    if (!list) return;
    list.replaceChildren();
    const waiting = document.createElement("p");
    waiting.className = "narration-empty";
    waiting.textContent = "Loading private reader documents...";
    list.append(waiting);
    try {
      const payload = await WB.API.getReaderDocuments();
      const records = Array.isArray(payload.documents) ? payload.documents : [];
      list.replaceChildren();
      if (!records.length) {
        waiting.textContent = "No private documents yet. Import or paste one above.";
        list.append(waiting);
        return;
      }
      records.forEach(record => list.append(documentCard(record)));
    } catch (error) {
      waiting.textContent = error.message || "Reader documents could not be loaded.";
      waiting.dataset.tone = "error";
    }
  }

  async function loadDocument(id) {
    status("Opening reader document...");
    try {
      const payload = await WB.API.getReaderDocument(id);
      const record = payload.document || {};
      controller.load({
        id: `reader:${record.id}`,
        title: record.title,
        text: record.text,
        kind: "private document",
        locator: `Private documents / ${record.title || "Untitled document"}`,
      });
      status("Ready", "ready");
    } catch (error) {
      status(error.message || "Document could not be opened.", "error");
    }
  }

  async function requestDelete(record, button) {
    const prior = deleting.get(record.id);
    if (!prior || Date.now() - prior > 5000) {
      const marker = Date.now();
      deleting.set(record.id, marker);
      button.textContent = "Remove now";
      button.classList.add("is-confirming");
      status(`Press Remove now to delete ${record.title}.`, "warning");
      window.setTimeout(() => {
        if (!button.isConnected || deleting.get(record.id) !== marker) return;
        deleting.delete(record.id);
        button.textContent = "Remove";
        button.classList.remove("is-confirming");
      }, 5100);
      return;
    }
    deleting.delete(record.id);
    button.disabled = true;
    try {
      await WB.API.deleteReaderDocument(record.id);
       await controller.clearSourceCache(`reader:${record.id}`);
      status(`${record.title} removed.`, "ready");
      await refreshDocuments();
    } catch (error) {
      button.disabled = false;
      status(error.message || "Document could not be removed.", "error");
    }
  }

  async function importDocument(file) {
    if (!file) return;
    status(`Importing ${file.name}...`);
    try {
      const payload = await WB.API.importReaderDocument(file);
      const record = payload.document || {};
      await refreshDocuments();
      await loadDocument(record.id);
    } catch (error) {
      status(error.message || "Document import failed.", "error");
    }
  }

  async function savePastedText() {
    const title = byId("reader-paste-title")?.value?.trim() || "Pasted narration";
    const text = byId("reader-paste-text")?.value || "";
    if (!text.trim()) return status("Paste or dictate some text first.", "warning");
    status("Saving text to the private reader library...");
    try {
      const payload = await WB.API.saveReaderText(title, text);
      await refreshDocuments();
      await loadDocument(payload.document.id);
    } catch (error) {
      status(error.message || "Text could not be saved.", "error");
    }
  }

  function toggleDictation() {
    const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const button = byId("reader-dictate-btn");
    if (!SpeechRecognition) return status("Browser dictation is unavailable here.", "warning");
    if (recognition) {
      recognition.stop();
      return;
    }
    recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    let committed = byId("reader-paste-text")?.value?.trim() || "";
    recognition.onresult = event => {
      let interim = "";
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const value = event.results[index][0]?.transcript || "";
        if (event.results[index].isFinal) committed = `${committed} ${value}`.trim();
        else interim += value;
      }
      byId("reader-paste-text").value = `${committed}${interim ? ` ${interim}` : ""}`.trim();
    };
    recognition.onerror = event => status(`Dictation stopped: ${event.error || "recognition error"}`, "error");
    recognition.onend = () => {
      recognition = null;
      if (button) button.textContent = "Dictate";
    };
    button.textContent = "Stop dictation";
    status("Listening locally through browser dictation...", "ready");
    recognition.start();
  }

  function voices() {
    const select = byId("reader-browser-voice");
    if (!select) return;
    const current = WB.NarrationStore.settings().browserVoice;
    select.replaceChildren(new Option("Browser default", ""));
    controller.browser.voices().forEach(voice => {
      select.append(new Option(`${voice.name} (${voice.lang})`, voice.voiceURI));
    });
    select.value = current;
  }

  function populateSettings() {
    const settings = WB.NarrationStore.settings();
    byId("reader-engine").value = settings.engine;
    byId("reader-gemini-voice").value = settings.geminiVoice;
    byId("reader-rate").value = settings.rate;
    byId("reader-pitch").value = settings.pitch;
    byId("reader-volume").value = settings.volume;
    voices();
    updateEngineControls(settings.engine);
  }

  function updateEngineControls(engine) {
    const gemini = engine === "gemini";
    byId("reader-browser-voice").disabled = gemini;
    byId("reader-rate").disabled = gemini;
    byId("reader-pitch").disabled = gemini;
    byId("reader-gemini-voice").disabled = !gemini;
    const note = byId("reader-engine-note");
    if (note) {
      note.textContent = gemini
        ? "Gemini controls voice and expression; Volume applies here and in Audioflix routing. Rate and pitch are browser-speech controls."
        : "Browser speech works offline. Voice, rate, pitch, and volume apply immediately to the next passage.";
    }
  }

  function bindSetting(id, key, numeric = false) {
    byId(id)?.addEventListener("change", event => {
      const value = numeric ? Number(event.currentTarget.value) : event.currentTarget.value;
      WB.NarrationStore.saveSettings({ [key]: value });
      if (key === "engine") updateEngineControls(value);
    });
  }

  function renderState(event) {
    const value = event.detail || {};
    byId("reader-source-title").textContent = value.source?.title || "Choose an entry or document";
    renderPassage(value);
    const progress = byId("reader-progress");
    progress.max = 1000;
    progress.value = Math.round(Math.min(1, Math.max(0, Number(value.overallRatio) || 0)) * 1000);
    const label = value.passageCount ? `${Number(value.index || 0) + 1} of ${value.passageCount}` : "Ready";
    const percent = Math.round(Math.min(1, Math.max(0, Number(value.passageRatio) || 0)) * 100);
    const progressLabel = byId("reader-progress-label");
    if (progressLabel) progressLabel.textContent = value.passageCount ? `Clip ${label} / ${percent}%` : "Ready";
    status(value.error || `${label} / ${String(value.status || "idle")}`, value.error ? "error" : value.status);
    byId("reader-play-btn").textContent = value.status === "paused" ? "Resume" : "Play";
    const cacheState = `${value.source?.id || ""}:${value.index || 0}:${value.status || "idle"}`;
    if (cacheState !== lastCacheState) {
      lastCacheState = cacheState;
      if (byId("reader-cache-list")?.closest("details")?.open || ["complete", "ready"].includes(value.status)) {
        void refreshCache();
      }
    }
  }

  function goToCachedPassage(event) {
    const result = controller.focusCachedPassage(event.detail || {});
    status(result.message, result.ok ? "ready" : "warning");
    if (!result.ok) return;
    byId("reader-passage-preview")?.scrollIntoView?.({ block: "center", behavior: "smooth" });
    byId("reader-passage-preview")?.classList.add("is-cache-target");
    window.setTimeout(() => byId("reader-passage-preview")?.classList.remove("is-cache-target"), 1200);
    void refreshCache();
  }

  function loadEditorSelection() {
    showDialog();
    try {
      controller.load(WB.NarrationText.editorSource());
      status("Ready", "ready");
    } catch (error) {
      status(error.message || "This entry has no readable text.", "error");
    }
  }

  function applyExternalSettings(event) {
    const data = event.data;
    if (!WB.NarrationHost?.isHostEvent?.(event)
      || !data || data.type !== "eve-world-book-narration-settings" || !data.settings) return;
    WB.NarrationStore.saveSettings(data.settings, { notifyHost: false });
    populateSettings();
  }

  async function applyExternalCommand(event) {
    const data = event.data;
    if (!WB.NarrationHost?.isHostEvent?.(event) || data?.type !== "eve-world-book-narration-command") return;
    if (data.action === "open-reader") showDialog();
    if (data.action === "load-source") {
      try {
        controller.load(data.data?.source || {});
        if (data.data?.showReader === true) showDialog();
        status("Ready", "ready");
        if (data.data?.autoplay === true) controller.play();
      } catch (error) {
        status(error.message || "This source does not contain readable text.", "error");
      }
      return;
    }
    if (data.action === "play") {
      try { controller.play(); } catch (error) { status(error.message || "Choose something to read first.", "warning"); }
    }
    if (data.action === "pause") controller.pause();
    if (data.action === "stop") controller.stop();
    if (data.action === "previous") controller.previous();
    if (data.action === "next") controller.next();
    if (data.action === "seek-progress") {
      const value = Math.max(0, Math.min(1000, Number(data.data?.value) || 0));
      controller.seekProgress(value, data.data?.autoplay === true);
    }
    if (data.action === "clear-cache") {
       await controller.clearAudioCache();
      status("Generated narration audio cleared.", "ready");
      await refreshCache();
    }
  }

  function initialize() {
    byId("reader-library-btn")?.addEventListener("click", showDialog);
    byId("read-aloud-btn")?.addEventListener("click", loadEditorSelection);
    document.querySelector("[data-reader-close]")?.addEventListener("click", closeDialog);
    byId("reader-detach-btn")?.addEventListener("click", () => {
      WB.NarrationHost?.post?.({ type: "eve-world-book-narration-detach" });
    });
    byId("reader-file-input")?.addEventListener("change", event => {
      const file = event.currentTarget.files?.[0];
      event.currentTarget.value = "";
      void importDocument(file);
    });
    byId("reader-save-text-btn")?.addEventListener("click", () => void savePastedText());
    byId("reader-dictate-btn")?.addEventListener("click", toggleDictation);
    byId("reader-play-btn")?.addEventListener("click", () => {
      try { controller.play(); } catch (error) { status(error.message || "Choose something to read first.", "warning"); }
    });
    byId("reader-pause-btn")?.addEventListener("click", () => controller.pause());
    byId("reader-stop-btn")?.addEventListener("click", () => controller.stop());
    byId("reader-next-btn")?.addEventListener("click", () => controller.next());
    byId("reader-previous-btn")?.addEventListener("click", () => controller.previous());
    byId("reader-progress")?.addEventListener("input", event => {
      const output = byId("reader-progress-label");
      if (output) output.textContent = `${Math.round((Number(event.currentTarget.value) || 0) / 10)}% of source`;
    });
    byId("reader-progress")?.addEventListener("change", event => {
      const state = controller.snapshot();
      controller.seekProgress(event.currentTarget.value, state.status === "playing");
    });
    document.querySelector(".narration-cache-manager")?.addEventListener("toggle", event => {
      if (event.currentTarget.open) void refreshCache();
    });
    byId("reader-clear-cache-btn")?.addEventListener("click", async event => {
      const button = event.currentTarget;
      if (button.dataset.confirm !== "1") {
        button.dataset.confirm = "1";
        button.textContent = "Clear now";
        status("Press Clear now to remove generated narration audio.", "warning");
        window.setTimeout(() => {
          if (button.dataset.confirm === "1") {
            button.dataset.confirm = "";
            button.textContent = "Clear generated audio";
          }
        }, 5000);
        return;
      }
      button.dataset.confirm = "";
       await controller.clearAudioCache();
      button.textContent = "Clear generated audio";
      status("Generated narration audio cleared.", "ready");
      await refreshCache();
    });
    bindSetting("reader-engine", "engine");
    bindSetting("reader-browser-voice", "browserVoice");
    bindSetting("reader-gemini-voice", "geminiVoice");
    bindSetting("reader-rate", "rate", true);
    bindSetting("reader-pitch", "pitch", true);
    bindSetting("reader-volume", "volume", true);
    populateSettings();
    window.speechSynthesis?.addEventListener?.("voiceschanged", voices);
    controller.addEventListener("state", renderState);
    window.addEventListener("message", applyExternalSettings);
    window.addEventListener("message", event => void applyExternalCommand(event));
    window.addEventListener("eve:world-book-narration-go-to", goToCachedPassage);
    WB.NarrationLayout.bind();
    WB.NarrationHost?.post?.({ type: "eve-world-book-narration-ready" });
  }

  initialize();
})();
