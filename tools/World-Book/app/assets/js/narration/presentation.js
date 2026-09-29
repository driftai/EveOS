// Narration text highlighting and cache-size presentation share no playback state.
(function () {
  const WB = window.WorldBook = window.WorldBook || {};
  const byId = id => document.getElementById(id);
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
  WB.NarrationPresentation = { humanBytes, renderPassage };
})();
