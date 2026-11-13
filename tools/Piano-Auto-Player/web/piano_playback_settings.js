const ROUTES = new Set(["inherit", "internal", "target"]);
const LAYOUTS = new Set(["61", "88"]);

function nullableText(value, limit = 180) {
  if (value == null || value === "") return null;
  return String(value).trim().slice(0, limit) || null;
}

export function normalizePianoPlaybackSettings(raw = {}) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) raw = {};
  const route = ROUTES.has(String(raw.route || "inherit")) ? String(raw.route || "inherit") : "inherit";
  const layout = LAYOUTS.has(String(raw.layout || "")) ? String(raw.layout) : null;
  const volumeNumber = raw.internalVolumePercent == null || raw.internalVolumePercent === ""
    ? null : Number(raw.internalVolumePercent);
  const internalVolumePercent = Number.isInteger(volumeNumber) && volumeNumber >= 0 && volumeNumber <= 100
    ? volumeNumber : null;
  return {
    route,
    targetHint: nullableText(raw.targetHint),
    layout,
    instrumentId: nullableText(raw.instrumentId, 80),
    internalVolumePercent,
  };
}

export function songPlaybackSettings(song) {
  const stored = song?.identifiers?.custom?.piano_playback_v1;
  if (stored && typeof stored === "object") return normalizePianoPlaybackSettings(stored);
  if (typeof stored === "string" && stored.trim()) {
    try { return normalizePianoPlaybackSettings(JSON.parse(stored)); }
    catch (_) { return normalizePianoPlaybackSettings(); }
  }
  return normalizePianoPlaybackSettings();
}

export function targetOption(select, hint) {
  const normalized = value => String(value || "").trim().toLowerCase();
  const wanted = normalized(hint);
  if (!select || !wanted) return null;
  return [...select.options].find(option => normalized(option.value) === wanted)
    || [...select.options].find(option => normalized(option.dataset.title || option.textContent) === wanted)
    || null;
}
