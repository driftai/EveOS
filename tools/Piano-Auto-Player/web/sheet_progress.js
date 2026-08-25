const STYLE_ID = "sheetProgressStyles";
const EDITOR_CLASS = "sheet-progress-editor";
const INPUT_CLASS = "sheet-progress-input";
const PLAYABLE = /[A-Za-z0-9!@$%^*(]/;
const EXPRESSIVE_GRID = new Set(["grid", "vpsheet", "roblox_grid"]);

function installStyles() {
  if (typeof document === "undefined" || document.getElementById(STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = STYLE_ID;
  style.textContent = `
    .${EDITOR_CLASS} { position:relative; width:100%; min-height:330px; }
    .${EDITOR_CLASS} .sheet-progress-layer {
      position:absolute; inset:1px; z-index:1; overflow:hidden; pointer-events:none;
      box-sizing:border-box; padding:17px; border-radius:14px; white-space:pre-wrap; overflow-wrap:break-word;
      color:#eaf1f7; line-height:1.65; font-family:"Cascadia Code","SFMono-Regular",Consolas,monospace;
      font-size:14px; letter-spacing:normal; tab-size:4;
    }
    .${EDITOR_CLASS} .sheet-progress-layer.empty { color:#65717e; }
    .${EDITOR_CLASS} textarea.${INPUT_CLASS} {
      position:relative; z-index:2; box-sizing:border-box; background:transparent;
      color:rgba(234,241,247,0.004); -webkit-text-fill-color:rgba(234,241,247,0.004);
      caret-color:#eaf1f7;
    }
    .${EDITOR_CLASS} .sheet-progress-event {
      border-radius:3px; transition:background-color .06s linear, color .06s linear, box-shadow .06s linear;
    }
    .${EDITOR_CLASS} .sheet-progress-event.played {
      color:#dbe7ef; background:rgba(67,165,255,.065); box-shadow:inset 0 -1px 0 rgba(67,165,255,.14);
    }
    .${EDITOR_CLASS} .sheet-progress-event.current {
      color:#f4fbff; background:rgba(67,165,255,.46);
      box-shadow:inset 0 -1px 0 #43a5ff, 0 0 10px rgba(67,165,255,.20);
    }
  `;
  document.head.append(style);
}

function isPlayable(char) { return PLAYABLE.test(char); }
function appendEvent(events, kind, start, end) {
  if (end > start) events.push({ index:events.length + 1, kind, start, end });
}
function appendPause(events, value, start, end) {
  if (end <= start) return;
  const previous = events.at(-1);
  if (previous?.kind === "pause" && previous.value === value) {
    previous.end = end;
    return;
  }
  events.push({ index:events.length + 1, kind:"pause", value, start, end });
}
function consumeWhitespace(text, start) {
  let i = start;
  let newlines = 0;
  while (i < text.length && " \t\r\n".includes(text[i])) {
    if (text[i] === "\n") newlines += 1;
    i += 1;
  }
  return { end:i, kind:newlines >= 2 ? "paragraph" : "space" };
}

function parseExpressiveRanges(text) {
  const events = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (" \t\r\n".includes(ch)) {
      const ws = consumeWhitespace(text, i);
      appendPause(events, ws.kind, i, ws.end);
      i = ws.end;
      continue;
    }
    if (ch === "[") {
      const end = text.indexOf("]", i + 1);
      if (end !== -1) {
        const raw = text.slice(i + 1, end);
        const payload = [...raw].filter(isPlayable).join("");
        if (payload) {
          if (/\s/.test(raw)) {
            for (let p = i + 1; p < end; p += 1) if (isPlayable(text[p])) appendEvent(events, "fast", p, p + 1);
          } else appendEvent(events, "chord", i, end + 1);
        }
        i = end + 1;
        continue;
      }
    }
    if (ch === "{") {
      const end = text.indexOf("}", i + 1);
      if (end !== -1) {
        for (let p = i + 1; p < end; p += 1) if (isPlayable(text[p])) appendEvent(events, "fast", p, p + 1);
        i = end + 1;
        continue;
      }
    }
    if (ch === "-") {
      let end = i + 1;
      while (end < text.length && text[end] === "-") end += 1;
      appendPause(events, "-", i, end);
      i = end;
      continue;
    }
    if (ch === "|") {
      let end = i + 1;
      while (end < text.length && text[end] === "|") end += 1;
      appendPause(events, "|", i, end);
      i = end;
      continue;
    }
    if (isPlayable(ch)) appendEvent(events, "note", i, i + 1);
    i += 1;
  }
  while (events.length && events[0].kind === "pause" && ["space", "paragraph"].includes(events[0].value)) events.shift();
  while (events.length && events.at(-1).kind === "pause" && ["space", "paragraph"].includes(events.at(-1).value)) events.pop();
  events.forEach((event, index) => { event.index = index + 1; });
  return events;
}

function parseGridRanges(text) {
  const events = [];
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === "[") {
      const end = text.indexOf("]", i + 1);
      if (end !== -1) {
        if ([...text.slice(i + 1, end)].some(isPlayable)) appendEvent(events, "chord", i, end + 1);
        i = end + 1;
        continue;
      }
    }
    if (ch === "{") {
      const end = text.indexOf("}", i + 1);
      if (end !== -1) {
        for (let p = i + 1; p < end; p += 1) if (isPlayable(text[p])) appendEvent(events, "fast", p, p + 1);
        i = end + 1;
        continue;
      }
    }
    if ("-_|".includes(ch)) {
      let end = i + 1;
      while (end < text.length && text[end] === ch) end += 1;
      appendPause(events, ch, i, end);
      i = end;
      continue;
    }
    if (isPlayable(ch)) appendEvent(events, "note", i, i + 1);
    i += 1;
  }
  events.forEach((event, index) => { event.index = index + 1; });
  return events;
}

export function buildSheetEventRanges(text, profile = "expressive") {
  const value = String(text || "");
  const normalized = String(profile || "expressive").toLowerCase();
  return normalized === "letter_grid" || EXPRESSIVE_GRID.has(normalized)
    ? parseGridRanges(value)
    : parseExpressiveRanges(value);
}

function currentIndexFromStatus(status, fallback = 0) {
  const current = Number(status?.current_index || 0);
  if (["playing", "countdown", "paused"].includes(status?.status) && current > 0) return current;
  if (status?.status === "complete") return 0;
  if (["idle", "stopped", "error"].includes(status?.status)) return 0;
  return Math.max(0, Number(fallback || 0));
}

function createSpan(text, event, currentIndex) {
  const span = document.createElement("span");
  span.className = "sheet-progress-event";
  if (event.index > 0 && event.index < currentIndex) span.classList.add("played");
  if (event.index === currentIndex && currentIndex > 0) span.classList.add("current");
  span.dataset.eventIndex = String(event.index);
  span.textContent = text.slice(event.start, event.end);
  return span;
}

function renderLayer(layer, text, ranges, currentIndex, placeholder) {
  layer.replaceChildren();
  layer.classList.toggle("empty", !text);
  if (!text) {
    layer.textContent = placeholder || "";
    return;
  }
  let cursor = 0;
  for (const event of ranges) {
    if (event.start > cursor) layer.append(document.createTextNode(text.slice(cursor, event.start)));
    layer.append(createSpan(text, event, currentIndex));
    cursor = event.end;
  }
  if (cursor < text.length) layer.append(document.createTextNode(text.slice(cursor)));
}

function syncViewport(layer, textarea) {
  if (!layer || !textarea) return;
  const top = Math.max(0, layer.scrollTop);
  textarea.scrollTop = top;
  textarea.scrollLeft = layer.scrollLeft;
}

function followCurrentEvent(layer, textarea, currentIndex, force = false) {
  if (!layer || !textarea || !currentIndex) return;
  const target = layer.querySelector(`[data-event-index="${currentIndex}"]`);
  if (!target) return;
  const layerRect = layer.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const visibleTop = layerRect.top + layer.clientHeight * 0.24;
  const visibleBottom = layerRect.top + layer.clientHeight * 0.76;
  if (!force && targetRect.top >= visibleTop && targetRect.bottom <= visibleBottom) return;
  const delta = targetRect.top - layerRect.top;
  const targetScroll = Math.max(0, layer.scrollTop + delta - (layer.clientHeight - target.offsetHeight) * 0.50);
  layer.scrollTop = targetScroll;
  textarea.scrollTop = targetScroll;
  textarea.scrollLeft = layer.scrollLeft;
}

function setup(textarea) {
  if (typeof document === "undefined" || !textarea || textarea.dataset.sheetProgressReady === "1") return;
  installStyles();
  textarea.dataset.sheetProgressReady = "1";
  textarea.classList.add(INPUT_CLASS);

  const wrapper = document.createElement("div");
  wrapper.className = EDITOR_CLASS;
  textarea.parentNode.insertBefore(wrapper, textarea);
  wrapper.append(textarea);

  const layer = document.createElement("div");
  layer.className = "sheet-progress-layer";
  layer.setAttribute("aria-hidden", "true");
  wrapper.insertBefore(layer, textarea);

  let ranges = [];
  let currentIndex = 0;
  let lastIndex = 0;
  let forceFollow = false;
  let renderQueued = false;
  let followQueued = false;

  const readText = () => String(textarea.value || "");
  const rebuild = () => {
    ranges = buildSheetEventRanges(readText(), textarea.dataset.timingProfile || "expressive");
    queueRender(true);
  };
  const queueRender = (force = false) => {
    forceFollow = forceFollow || force;
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => {
      renderQueued = false;
      renderLayer(layer, readText(), ranges, currentIndex, textarea.getAttribute("placeholder"));
      syncViewport(layer, textarea);
      if (forceFollow || currentIndex !== lastIndex) {
        followCurrentEvent(layer, textarea, currentIndex, forceFollow);
        lastIndex = currentIndex;
        forceFollow = false;
      }
    });
  };
  const queueFollow = () => {
    if (followQueued) return;
    followQueued = true;
    requestAnimationFrame(() => {
      followQueued = false;
      if (currentIndex) followCurrentEvent(layer, textarea, currentIndex, false);
      syncViewport(layer, textarea);
    });
  };

  textarea.addEventListener("input", () => { textarea.dataset.seekFallback = "0"; rebuild(); });
  textarea.addEventListener("scroll", () => {
    if (Math.abs(layer.scrollTop - textarea.scrollTop) > 1) layer.scrollTop = textarea.scrollTop;
    if (Math.abs(layer.scrollLeft - textarea.scrollLeft) > 1) layer.scrollLeft = textarea.scrollLeft;
  });
  layer.addEventListener("scroll", () => {
    if (Math.abs(textarea.scrollTop - layer.scrollTop) > 1) textarea.scrollTop = layer.scrollTop;
    if (Math.abs(textarea.scrollLeft - layer.scrollLeft) > 1) textarea.scrollLeft = layer.scrollLeft;
  });
  new MutationObserver(records => {
    if (records.some(record => record.type === "attributes" && record.attributeName === "data-timing-profile")) rebuild();
  }).observe(textarea, { attributes:true });

  window.addEventListener("piano:sheet-progress-seek", event => {
    const index = Number(event.detail?.index || 0);
    if (index > 0) {
      currentIndex = index;
      queueRender(true);
    }
  });
  window.addEventListener("piano:sheet-rebuild", rebuild);

  const statusLoop = async () => {
    try {
      const response = await fetch("/api/status", { cache:"no-store" });
      if (response.ok) {
        const status = await response.json();
        const nextIndex = currentIndexFromStatus(status, Number(textarea.dataset.seekFallback || 0));
        const changed = nextIndex !== currentIndex || status.status === "complete";
        currentIndex = nextIndex;
        queueRender(changed && currentIndex > 0);
        if (status.status === "complete") {
          requestAnimationFrame(() => {
            layer.scrollTop = Math.max(0, layer.scrollHeight - layer.clientHeight);
            textarea.scrollTop = layer.scrollTop;
          });
        }
      }
    } catch (_) {}
    window.setTimeout(statusLoop, 180);
  };

  rebuild();
  statusLoop();
}

function boot() {
  if (typeof document === "undefined") return;
  const textarea = document.getElementById("sheetInput");
  if (textarea) setup(textarea);
}

if (typeof document !== "undefined") {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", boot, { once:true });
  else boot();
}
